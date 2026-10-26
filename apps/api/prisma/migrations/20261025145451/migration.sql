-- AlterTable
ALTER TABLE "CommissionLedger" ALTER COLUMN "eligibleBaseMinor" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "ExchangeRateSnapshot_pair_provider_date_key" RENAME TO "ExchangeRateSnapshot_baseCurrency_quoteCurrency_provider_so_key";

-- RenameIndex
ALTER INDEX "ManualExchangeRateVersion_storeId_baseCurrency_quoteCurrency_ve" RENAME TO "ManualExchangeRateVersion_storeId_baseCurrency_quoteCurrenc_key";

-- RenameIndex
ALTER INDEX "ManualExchangeRateVersion_store_pair_effective_idx" RENAME TO "ManualExchangeRateVersion_storeId_baseCurrency_quoteCurrenc_idx";

-- RenameIndex
ALTER INDEX "ProcessedWebhookEvent_provider_providerObjectRef_reviewReason_i" RENAME TO "ProcessedWebhookEvent_provider_providerObjectRef_reviewReas_idx";

-- RenameIndex
ALTER INDEX "ProviderConfiguration_context_environment_enabled_archivedAt_id" RENAME TO "ProviderConfiguration_context_environment_enabled_archivedA_idx";

-- RenameIndex
ALTER INDEX "ProviderConfiguration_provider_context_environment_archivedAt_i" RENAME TO "ProviderConfiguration_provider_context_environment_archived_idx";

-- RenameIndex
ALTER INDEX "SellerCommissionPolicyVersion_planVersionId_status_effectiveFro" RENAME TO "SellerCommissionPolicyVersion_planVersionId_status_effectiv_idx";

-- RenameIndex
ALTER INDEX "SellerShippingZone_unique_service_scope" RENAME TO "SellerShippingZone_serviceId_countryCode_regionKey_cityKey_key";

-- RenameIndex
ALTER INDEX "StoreSubscriptionEvent_provider_event_key" RENAME TO "StoreSubscriptionEvent_provider_providerEventId_key";
