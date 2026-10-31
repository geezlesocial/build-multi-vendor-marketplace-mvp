targetScope = 'resourceGroup'

@description('Region is a planning default only; confirm it and PostgreSQL 17/SKU availability before approval.')
param location string = 'southeastasia'

@description('Workload-specific resource prefix. Resource names are generated within the dedicated group.')
param namePrefix string = 'mpstg'

@description('Secure server administrator login for first provisioning. Store only in the approved secret channel.')
param postgresAdminLogin string = 'marketplace_admin'

@secure()
@description('PostgreSQL administrator password; never pass on a command line or commit a parameter file containing its value.')
param postgresAdminPassword string

@description('Email address that receives budget alerts. Use a Marketplace owner mailbox.')
param budgetContactEmail string

@description('Monthly cost alert. Alerts are not a spending cap.')
@minValue(1)
@maxValue(100000)
param monthlyBudgetUsd int = 25

@description('Budget window start. Review and update when deploying in a later month.')
param budgetStartDate string = utcNow('yyyy-MM-01T00:00:00Z')

@description('Allowlisted temporary administrator egress IP for initial secret seeding, as x.x.x.x/32. Remove the rule after setup.')
param keyVaultBootstrapIpCidr string = ''

@description('First phase creates only isolated infrastructure. Seed the Key Vault secrets through the approved path, then redeploy with deployApplications=true.')
param deployApplications bool = false

@description('Enable only after all referenced Key Vault secrets are present and reviewed.')
param deployBootstrapJob bool = false

@description('Create isolated Mailpit and ClamAV apps for a test window. Both remain at zero replicas until manually scaled up; do not rely on TCP traffic to wake them.')
param deploySessionServices bool = false

@description('Immutable image reference, e.g. <acr>.azurecr.io/marketplace-api:<40-char-commit-sha>. Required with deployApplications.')
param apiImage string = ''

@description('Immutable image reference for the static web container.')
param webImage string = ''

@description('Immutable image reference for the one-shot Prisma migration tool.')
param migratorImage string = ''

@description('PostgreSQL staging database name. The database is independent from all Scrolith and production data.')
param databaseName string = 'marketplace_staging'

var suffix = uniqueString(subscription().id, resourceGroup().id)
var vnetName = '${namePrefix}-vnet'
var acaEnvironmentName = '${namePrefix}-aca'
var apiAppName = '${namePrefix}-api'
var webAppName = '${namePrefix}-web'
var migrationPreflightJobName = '${namePrefix}-migration-preflight'
var migrationDeployJobName = '${namePrefix}-migration-deploy'
var bootstrapJobName = '${namePrefix}-admin-bootstrap'
var registryName = '${namePrefix}${suffix}'
var vaultName = '${namePrefix}kv${suffix}'
var bootstrapVaultName = '${namePrefix}bootkv${suffix}'
var storageName = '${namePrefix}blob${suffix}'
var postgresServerName = '${namePrefix}-pg-${suffix}'
var apiInternalFqdn = '${apiAppName}.internal.${acaEnvironment.properties.defaultDomain}'
var webFqdn = '${webAppName}.${acaEnvironment.properties.defaultDomain}'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
var keyVaultDnsSuffix = environment().suffixes.keyvaultDns

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
  }
}

resource acaSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' = {
  parent: vnet
  name: 'snet-container-apps'
  properties: {
    addressPrefix: '10.42.0.0/23'
    delegations: [
      { name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }
    ]
  }
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' = {
  parent: vnet
  name: 'snet-postgres'
  properties: {
    addressPrefix: '10.42.2.0/28'
    delegations: [
      { name: 'postgres-flexible-server', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }
    ]
  }
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' = {
  parent: vnet
  name: 'snet-private-endpoints'
  properties: { addressPrefix: '10.42.2.16/28' }
}

resource postgresPrivateDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${namePrefix}.postgres.database.azure.com'
  location: 'global'
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: postgresPrivateDns
  name: '${namePrefix}-vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}

resource vaultPrivateDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
}

resource vaultDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: vaultPrivateDns
  name: '${namePrefix}-vault-vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}

resource blobPrivateDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.${environment().suffixes.storage}'
  location: 'global'
}

resource blobDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: blobPrivateDns
  name: '${namePrefix}-blob-vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-runtime-identity'
  location: location
}

resource registryIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-registry-pull-identity'
  location: location
}

resource bootstrapIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-bootstrap-identity'
  location: location
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
      ipRules: empty(keyVaultBootstrapIpCidr) ? [] : [{ value: keyVaultBootstrapIpCidr }]
      virtualNetworkRules: []
    }
  }
}

// Keep one-time administrator bootstrap credentials out of the API runtime vault.
resource bootstrapVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: bootstrapVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
      ipRules: empty(keyVaultBootstrapIpCidr) ? [] : [{ value: keyVaultBootstrapIpCidr }]
      virtualNetworkRules: []
    }
  }
}

resource vaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = {
  name: '${namePrefix}-vault-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnet.id }
    privateLinkServiceConnections: [
      { name: 'vault', properties: { privateLinkServiceId: vault.id, groupIds: ['vault'] } }
    ]
  }
}

resource vaultPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = {
  parent: vaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'vault', properties: { privateDnsZoneId: vaultPrivateDns.id } }
    ]
  }
}

resource bootstrapVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = {
  name: '${namePrefix}-bootstrap-vault-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnet.id }
    privateLinkServiceConnections: [
      { name: 'bootstrap-vault', properties: { privateLinkServiceId: bootstrapVault.id, groupIds: ['vault'] } }
    ]
  }
}

resource bootstrapVaultPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = {
  parent: bootstrapVaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'bootstrap-vault', properties: { privateDnsZoneId: vaultPrivateDns.id } }
    ]
  }
}

resource vaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, appIdentity.id, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    networkAcls: { bypass: 'None', defaultAction: 'Deny', ipRules: [], virtualNetworkRules: [] }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { deleteRetentionPolicy: { enabled: true, days: 7 }, containerDeleteRetentionPolicy: { enabled: true, days: 7 } }
}

resource privateMediaContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'marketplace-media'
  properties: { publicAccess: 'None' }
}

resource blobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = {
  name: '${namePrefix}-blob-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnet.id }
    privateLinkServiceConnections: [
      { name: 'blob', properties: { privateLinkServiceId: storage.id, groupIds: ['blob'] } }
    ]
  }
}

resource blobPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = {
  parent: blobPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'blob', properties: { privateDnsZoneId: blobPrivateDns.id } }
    ]
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    createMode: 'Default'
    availabilityZone: '1'
    storage: { storageSizeGB: 32, autoGrow: 'Disabled', type: 'Premium_LRS' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: postgresPrivateDns.id
      publicNetworkAccess: 'Disabled'
    }
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
    highAvailability: { mode: 'Disabled' }
  }
  dependsOn: [postgresDnsLink]
}

resource stagingDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${namePrefix}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 14
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource acaEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: acaEnvironmentName
  location: location
  properties: {
    vnetConfiguration: { infrastructureSubnetId: acaSubnet.id, internal: false }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption', minimumCount: 0, maximumCount: 1 }
    ]
    zoneRedundant: false
  }
}

resource bootstrapVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(bootstrapVault.id, bootstrapIdentity.id, keyVaultSecretsUserRoleId)
  scope: bootstrapVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: bootstrapIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, registryIdentity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: acrPullRole
    principalId: registryIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${namePrefix}-budget-alerts'
  location: 'global'
  properties: {
    groupShortName: 'mpstg-cost'
    enabled: true
    emailReceivers: [
      { name: 'Marketplace staging budget owner', emailAddress: budgetContactEmail, useCommonAlertSchema: true }
    ]
  }
}

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = if (deployApplications) {
  name: apiAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentity.id}': {}, '${registryIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: acaEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registry.properties.loginServer, identity: registryIdentity.id }]
      secrets: [
        { name: 'database-url', keyVaultUrl: 'https://${vault.name}.${keyVaultDnsSuffix}/secrets/database-url', identity: appIdentity.id }
        { name: 'password-pepper', keyVaultUrl: 'https://${vault.name}.${keyVaultDnsSuffix}/secrets/password-pepper', identity: appIdentity.id }
        { name: 'payout-encryption-key', keyVaultUrl: 'https://${vault.name}.${keyVaultDnsSuffix}/secrets/payout-encryption-key', identity: appIdentity.id }
        { name: 'dropshipping-encryption-key', keyVaultUrl: 'https://${vault.name}.${keyVaultDnsSuffix}/secrets/dropshipping-encryption-key', identity: appIdentity.id }
        { name: 'affiliate-signing-secret', keyVaultUrl: 'https://${vault.name}.${keyVaultDnsSuffix}/secrets/affiliate-signing-secret', identity: appIdentity.id }
      ]
      ingress: { external: false, targetPort: 4000, transport: 'http', allowInsecure: false }
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'API_PORT', value: '4000' }
            { name: 'TRUST_PROXY_HOPS', value: '1' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'PASSWORD_PEPPER', secretRef: 'password-pepper' }
            { name: 'PAYOUT_ENCRYPTION_KEY', secretRef: 'payout-encryption-key' }
            { name: 'DROPSHIPPING_ENCRYPTION_KEY', secretRef: 'dropshipping-encryption-key' }
            { name: 'AFFILIATE_SIGNING_SECRET', secretRef: 'affiliate-signing-secret' }
            { name: 'SITE_URL', value: 'https://${webFqdn}' }
            { name: 'WEB_ORIGIN', value: 'https://${webFqdn}' }
            { name: 'CONTENT_SCAN_REQUIRED', value: 'true' }
            { name: 'CONTENT_SCANNER_AVAILABLE', value: 'false' }
            { name: 'CONTENT_OBJECT_STORAGE_AVAILABLE', value: 'false' }
            { name: 'STORE_EMAIL_DELIVERY_AVAILABLE', value: 'false' }
            { name: 'STORE_BUSTER_SPONSORED_AVAILABLE', value: 'false' }
            { name: 'MONEY_MOVEMENT_HARD_DISABLED', value: 'true' }
            { name: 'WALLET_FUNDING_PROVIDER_READY', value: 'false' }
            { name: 'WALLET_FUNDING_SANDBOX_MODE', value: 'false' }
            { name: 'LIVE_SHOPPING_AVAILABLE', value: 'false' }
            { name: 'LIVE_RECORDING_STORAGE_AVAILABLE', value: 'false' }
            { name: 'LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE', value: 'false' }
            { name: 'FX_REFERENCE_FETCH_ENABLED', value: 'true' }
            { name: 'CONTENT_STORAGE_DIR', value: '/tmp/content' }
            { name: 'UPLOAD_DIR', value: '/tmp/uploads' }
            { name: 'TMPDIR', value: '/tmp' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          volumeMounts: [{ volumeName: 'temporary-files', mountPath: '/tmp' }]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 4000, scheme: 'HTTP' }, initialDelaySeconds: 10, periodSeconds: 30, timeoutSeconds: 3, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/ready', port: 4000, scheme: 'HTTP' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 4, failureThreshold: 3 }
          ]
        }
      ]
      volumes: [{ name: 'temporary-files', storageType: 'EmptyDir' }]
      scale: { minReplicas: 0, maxReplicas: 1, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }] }
    }
  }
  dependsOn: [vaultRole, acrPullRoleAssignment]
}

resource webApp 'Microsoft.App/containerApps@2024-03-01' = if (deployApplications) {
  name: webAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${registryIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: acaEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registry.properties.loginServer, identity: registryIdentity.id }]
      ingress: { external: true, targetPort: 8080, transport: 'http', allowInsecure: false }
    }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          env: [
            // ACA HTTP ingress terminates TLS at the Envoy edge. The internal FQDN is
            // HTTPS-only when allowInsecure is false; Nginx validates its managed cert.
            { name: 'API_UPSTREAM', value: 'https://${apiInternalFqdn}' }
            { name: 'DNS_RESOLVER', value: '168.63.129.16' }
          ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          volumeMounts: [{ volumeName: 'temporary-files', mountPath: '/tmp' }]
          probes: [{ type: 'Liveness', httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 5, periodSeconds: 30, timeoutSeconds: 3, failureThreshold: 3 }]
        }
      ]
      volumes: [{ name: 'temporary-files', storageType: 'EmptyDir' }]
      scale: { minReplicas: 0, maxReplicas: 1, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }] }
    }
  }
  dependsOn: [acrPullRoleAssignment, apiApp]
}

resource mailpitApp 'Microsoft.App/containerApps@2024-03-01' = if (deploySessionServices) {
  name: '${namePrefix}-mailpit'
  location: location
  properties: {
    managedEnvironmentId: acaEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 8025
        transport: 'http'
        additionalPortMappings: [{ external: false, targetPort: 1025, exposedPort: 1025 }]
      }
    }
    template: {
      containers: [{
        name: 'mailpit'
        image: 'axllent/mailpit:v1.27.8@sha256:6abc8e633df15eaf785cfcf38bae48e66f64beecdc03121e249d0f9ec15f0707'
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
      }]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

resource clamavApp 'Microsoft.App/containerApps@2024-03-01' = if (deploySessionServices) {
  name: '${namePrefix}-clamav'
  location: location
  properties: {
    managedEnvironmentId: acaEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, targetPort: 3310, exposedPort: 3310, transport: 'tcp' }
    }
    template: {
      containers: [{
        name: 'clamav'
        image: 'clamav/clamav:1.5@sha256:bda39705e291105049c3936e2803ac90b955172af8030f94f05dce1252df6c6d'
        resources: { cpu: 2, memory: '4Gi' }
        probes: [{ type: 'Readiness', tcpSocket: { port: 3310 }, initialDelaySeconds: 45, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 60 }]
      }]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

resource migrationPreflightJob 'Microsoft.App/jobs@2024-03-01' = if (deployApplications) {
  name: migrationPreflightJobName
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentity.id}': {}, '${registryIdentity.id}': {} } }
  properties: {
    environmentId: acaEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      registries: [{ server: registry.properties.loginServer, identity: registryIdentity.id }]
      secrets: [{ name: 'database-url', keyVaultUrl: 'https://${vault.name}.${keyVaultDnsSuffix}/secrets/database-url', identity: appIdentity.id }]
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [{ name: 'migration-preflight', image: migratorImage, command: ['../../node_modules/.bin/prisma', 'migrate', 'status', '--config', 'prisma.config.ts'], env: [{ name: 'DATABASE_URL', secretRef: 'database-url' }, { name: 'NODE_ENV', value: 'production' }] }]
    }
  }
  dependsOn: [vaultRole, acrPullRoleAssignment]
}

resource migrationDeployJob 'Microsoft.App/jobs@2024-03-01' = if (deployApplications) {
  name: migrationDeployJobName
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentity.id}': {}, '${registryIdentity.id}': {} } }
  properties: {
    environmentId: acaEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      registries: [{ server: registry.properties.loginServer, identity: registryIdentity.id }]
      secrets: [{ name: 'database-url', keyVaultUrl: 'https://${vault.name}.${keyVaultDnsSuffix}/secrets/database-url', identity: appIdentity.id }]
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [{ name: 'migration-deploy', image: migratorImage, command: ['../../node_modules/.bin/prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'], env: [{ name: 'DATABASE_URL', secretRef: 'database-url' }, { name: 'NODE_ENV', value: 'production' }] }]
    }
  }
  dependsOn: [vaultRole, acrPullRoleAssignment]
}

resource bootstrapJob 'Microsoft.App/jobs@2024-03-01' = if (deployApplications && deployBootstrapJob) {
  name: bootstrapJobName
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${bootstrapIdentity.id}': {}, '${registryIdentity.id}': {} } }
  properties: {
    environmentId: acaEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 0
      registries: [{ server: registry.properties.loginServer, identity: registryIdentity.id }]
      secrets: [
        { name: 'database-url', keyVaultUrl: 'https://${bootstrapVault.name}.${keyVaultDnsSuffix}/secrets/database-url', identity: bootstrapIdentity.id }
        { name: 'password-pepper', keyVaultUrl: 'https://${bootstrapVault.name}.${keyVaultDnsSuffix}/secrets/password-pepper', identity: bootstrapIdentity.id }
        { name: 'bootstrap-admin-email', keyVaultUrl: 'https://${bootstrapVault.name}.${keyVaultDnsSuffix}/secrets/bootstrap-admin-email', identity: bootstrapIdentity.id }
        { name: 'bootstrap-admin-name', keyVaultUrl: 'https://${bootstrapVault.name}.${keyVaultDnsSuffix}/secrets/bootstrap-admin-name', identity: bootstrapIdentity.id }
        { name: 'bootstrap-admin-password', keyVaultUrl: 'https://${bootstrapVault.name}.${keyVaultDnsSuffix}/secrets/bootstrap-admin-password', identity: bootstrapIdentity.id }
      ]
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [{ name: 'initial-admin-bootstrap', image: apiImage, command: ['node', 'apps/api/dist/src/staging-admin-bootstrap.js'], env: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'DATABASE_URL', secretRef: 'database-url' }
        { name: 'PASSWORD_PEPPER', secretRef: 'password-pepper' }
        { name: 'STAGING_ADMIN_EMAIL', secretRef: 'bootstrap-admin-email' }
        { name: 'STAGING_ADMIN_NAME', secretRef: 'bootstrap-admin-name' }
        { name: 'STAGING_ADMIN_PASSWORD', secretRef: 'bootstrap-admin-password' }
        { name: 'STAGING_ADMIN_BOOTSTRAP_ENABLED', value: 'true' }
      ] }]
    }
  }
  dependsOn: [bootstrapVaultRole, acrPullRoleAssignment]
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (deployApplications) {
  name: '${namePrefix}-app-logs'
  scope: apiApp
  properties: {
    workspaceId: logWorkspace.id
    logs: [
      { category: 'ContainerAppConsoleLogs', enabled: true }
      { category: 'ContainerAppSystemLogs', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

resource webDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (deployApplications) {
  name: '${namePrefix}-web-logs'
  scope: webApp
  properties: {
    workspaceId: logWorkspace.id
    logs: [
      { category: 'ContainerAppConsoleLogs', enabled: true }
      { category: 'ContainerAppSystemLogs', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

resource budgetResource 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: '${namePrefix}-monthly-budget'
  scope: resourceGroup()
  properties: {
    category: 'Cost'
    amount: monthlyBudgetUsd
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate, endDate: '2035-12-31T00:00:00Z' }
    notifications: {
      Actual50: { enabled: true, operator: 'GreaterThan', threshold: 50, thresholdType: 'Actual', contactEmails: [budgetContactEmail], contactGroups: [actionGroup.id] }
      Actual80: { enabled: true, operator: 'GreaterThan', threshold: 80, thresholdType: 'Actual', contactEmails: [budgetContactEmail], contactGroups: [actionGroup.id] }
      Actual100: { enabled: true, operator: 'GreaterThan', threshold: 100, thresholdType: 'Actual', contactEmails: [budgetContactEmail], contactGroups: [actionGroup.id] }
      Forecast100: { enabled: true, operator: 'GreaterThan', threshold: 100, thresholdType: 'Forecasted', contactEmails: [budgetContactEmail], contactGroups: [actionGroup.id] }
    }
  }
}

output resourceGroupName string = resourceGroup().name
output containerRegistryName string = registry.name
output containerRegistryLoginServer string = registry.properties.loginServer
output stagingWebHostname string = webFqdn
output apiInternalHostname string = apiInternalFqdn
output postgresServerName string = postgres.name
output postgresDatabaseName string = stagingDatabase.name
output keyVaultName string = vault.name
output blobStorageAccountName string = storage.name
output logAnalyticsWorkspaceName string = logWorkspace.name
output deployApplicationsNext bool = !deployApplications
