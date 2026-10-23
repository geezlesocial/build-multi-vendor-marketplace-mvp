-- Provider configuration inventory only. It stores references, never provider
-- credential values, and does not activate any existing payment or wallet gate.
CREATE TYPE "IntegrationProvider" AS ENUM ('STRIPE', 'PAYPAL');
CREATE TYPE "IntegrationContext" AS ENUM ('MARKETPLACE_CHECKOUT', 'WALLET_FUNDING');
CREATE TYPE "IntegrationEnvironment" AS ENUM ('SANDBOX', 'LIVE');

CREATE TABLE "ProviderConfiguration" (
    "id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "context" "IntegrationContext" NOT NULL,
    "environment" "IntegrationEnvironment" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderConfiguration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderConfiguration_name_check" CHECK (length(btrim("name")) BETWEEN 2 AND 80),
    CONSTRAINT "ProviderConfiguration_archive_enabled_check" CHECK ("archivedAt" IS NULL OR NOT "enabled"),
    CONSTRAINT "ProviderConfiguration_context_provider_check" CHECK (
        "context" <> 'WALLET_FUNDING' OR "provider" = 'STRIPE'
    )
);

CREATE TABLE "ProviderCredentialReference" (
    "id" TEXT NOT NULL,
    "configurationId" TEXT NOT NULL,
    "credentialKey" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderCredentialReference_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderCredentialReference_key_check" CHECK ("credentialKey" IN ('apiSecret', 'webhookSecret', 'clientId', 'clientSecret', 'webhookId')),
    CONSTRAINT "ProviderCredentialReference_reference_check" CHECK (
        "reference" ~ '^env:[A-Z][A-Z0-9_]{1,99}$'
        OR "reference" ~ '^secret-ref:payments/(stripe|paypal)/(apiSecret|webhookSecret|clientId|clientSecret|webhookId)$'
    ),
    CONSTRAINT "ProviderCredentialReference_configurationId_credentialKey_key" UNIQUE ("configurationId", "credentialKey")
);

CREATE INDEX "ProviderConfiguration_context_environment_enabled_archivedAt_idx"
    ON "ProviderConfiguration"("context", "environment", "enabled", "archivedAt");
CREATE INDEX "ProviderConfiguration_provider_context_environment_archivedAt_idx"
    ON "ProviderConfiguration"("provider", "context", "environment", "archivedAt");
CREATE UNIQUE INDEX "ProviderConfiguration_one_current_context_key"
    ON "ProviderConfiguration"("provider", "context", "environment") WHERE "archivedAt" IS NULL;
CREATE INDEX "ProviderCredentialReference_configurationId_idx"
    ON "ProviderCredentialReference"("configurationId");

ALTER TABLE "ProviderConfiguration" ADD CONSTRAINT "ProviderConfiguration_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderConfiguration" ADD CONSTRAINT "ProviderConfiguration_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderCredentialReference" ADD CONSTRAINT "ProviderCredentialReference_configurationId_fkey"
    FOREIGN KEY ("configurationId") REFERENCES "ProviderConfiguration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_provider_configuration_lifecycle() RETURNS trigger AS $$
DECLARE
    required_keys TEXT[];
    credential_count INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Provider configurations are retained for audit/history; archive instead';
    END IF;
    IF TG_OP = 'UPDATE' AND ROW(NEW."provider", NEW."context", NEW."environment")
        IS DISTINCT FROM ROW(OLD."provider", OLD."context", OLD."environment") THEN
        RAISE EXCEPTION 'Provider, context, and environment are immutable; archive and create a replacement';
    END IF;
    IF NEW."enabled" THEN
        IF NEW."archivedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'Archived provider configurations cannot be enabled';
        END IF;
        IF NEW."provider" = 'STRIPE' THEN
            required_keys := ARRAY['apiSecret', 'webhookSecret'];
        ELSE
            required_keys := ARRAY['clientId', 'clientSecret', 'webhookId'];
        END IF;
        SELECT count(*) INTO credential_count
        FROM "ProviderCredentialReference"
        WHERE "configurationId" = NEW."id" AND "credentialKey" = ANY(required_keys);
        IF credential_count <> cardinality(required_keys) THEN
            RAISE EXCEPTION 'All provider credential references are required before enabling a configuration';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProviderConfiguration_lifecycle_guard"
BEFORE UPDATE OR DELETE ON "ProviderConfiguration"
FOR EACH ROW EXECUTE FUNCTION enforce_provider_configuration_lifecycle();

CREATE FUNCTION enforce_provider_credential_reference() RETURNS trigger AS $$
DECLARE
    provider_name "IntegrationProvider";
    context_name "IntegrationContext";
    configuration_enabled BOOLEAN;
    allowed_keys TEXT[];
    configuration_id TEXT;
    key_name TEXT;
    reference_value TEXT;
    expected_environment_name TEXT;
    expected_secret_reference TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND ROW(NEW."configurationId", NEW."credentialKey")
        IS DISTINCT FROM ROW(OLD."configurationId", OLD."credentialKey") THEN
        RAISE EXCEPTION 'Credential reference identity is immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN
        configuration_id := OLD."configurationId";
        key_name := OLD."credentialKey";
        reference_value := OLD."reference";
    ELSE
        configuration_id := NEW."configurationId";
        key_name := NEW."credentialKey";
        reference_value := NEW."reference";
    END IF;
    SELECT "provider", "context", "enabled" INTO provider_name, context_name, configuration_enabled
    FROM "ProviderConfiguration" WHERE "id" = configuration_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Provider configuration does not exist'; END IF;
    IF provider_name = 'STRIPE' THEN
        allowed_keys := ARRAY['apiSecret', 'webhookSecret'];
    ELSIF context_name = 'MARKETPLACE_CHECKOUT' THEN
        allowed_keys := ARRAY['clientId', 'clientSecret', 'webhookId'];
    ELSE
        allowed_keys := ARRAY[]::TEXT[];
    END IF;
    IF NOT key_name = ANY(allowed_keys) THEN
        RAISE EXCEPTION 'Credential reference is unsupported for this provider context';
    END IF;
    IF configuration_enabled THEN
        RAISE EXCEPTION 'Disable a provider configuration before changing credential references';
    END IF;
    IF reference_value LIKE 'env:%' THEN
        IF provider_name = 'STRIPE' THEN
            expected_environment_name := CASE key_name WHEN 'apiSecret' THEN 'STRIPE_SECRET_KEY' WHEN 'webhookSecret' THEN 'STRIPE_WEBHOOK_SECRET' END;
        ELSE
            expected_environment_name := CASE key_name WHEN 'clientId' THEN 'PAYPAL_CLIENT_ID' WHEN 'clientSecret' THEN 'PAYPAL_CLIENT_SECRET' WHEN 'webhookId' THEN 'PAYPAL_WEBHOOK_ID' END;
        END IF;
        IF reference_value <> 'env:' || expected_environment_name THEN
            RAISE EXCEPTION 'Environment reference does not match this provider credential field';
        END IF;
    ELSIF reference_value LIKE 'secret-ref:%' THEN
        expected_secret_reference := 'secret-ref:payments/' || lower(provider_name::text) || '/' || key_name;
        IF reference_value <> expected_secret_reference THEN
            RAISE EXCEPTION 'Secret-manager reference does not match this provider credential field';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProviderCredentialReference_context_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProviderCredentialReference"
FOR EACH ROW EXECUTE FUNCTION enforce_provider_credential_reference();
