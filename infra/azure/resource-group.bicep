targetScope = 'subscription'

@description('Dedicated Marketplace-only staging resource group. Do not point this at Scrolith resources.')
param resourceGroupName string = 'rg-marketplace-staging'

@description('Azure region; Southeast Asia is only a planning default and needs owner confirmation.')
param location string = 'southeastasia'

resource marketplaceStagingGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    workload: 'marketplace'
    environment: 'staging'
    managedBy: 'bicep'
  }
}

output resourceGroupId string = marketplaceStagingGroup.id
