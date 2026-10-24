CREATE TABLE "CurrencyCatalogEntry" (
  "code" VARCHAR(3) NOT NULL,
  "numericCode" VARCHAR(3),
  "name" VARCHAR(100) NOT NULL,
  "symbol" VARCHAR(16) NOT NULL,
  "minorUnitExponent" INTEGER NOT NULL,
  "region" VARCHAR(32) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "displayEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "storePricingEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "checkoutEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "subscriptionEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "settlementEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "reportingEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CurrencyCatalogEntry_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "CurrencyCatalogEntry_code_check" CHECK ("code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "CurrencyCatalogEntry_numericCode_check" CHECK ("numericCode" IS NULL OR "numericCode" ~ '^[0-9]{3}$'),
  CONSTRAINT "CurrencyCatalogEntry_minorUnitExponent_check" CHECK ("minorUnitExponent" BETWEEN 0 AND 4)
);
CREATE INDEX "CurrencyCatalogEntry_active_displayEnabled_region_idx"
  ON "CurrencyCatalogEntry"("active", "displayEnabled", "region");

INSERT INTO "CurrencyCatalogEntry"
  ("code", "numericCode", "name", "symbol", "minorUnitExponent", "region", "displayEnabled", "storePricingEnabled", "checkoutEnabled", "subscriptionEnabled", "settlementEnabled", "reportingEnabled", "updatedAt")
VALUES
  ('USD','840','United States Dollar','$',2,'North America',TRUE,TRUE,TRUE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('PHP','608','Philippine Peso','₱',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('JPY','392','Japanese Yen','¥',0,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('CNY','156','Chinese Yuan','¥',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('SGD','702','Singapore Dollar','S$',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('MYR','458','Malaysian Ringgit','RM',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('THB','764','Thai Baht','฿',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('IDR','360','Indonesian Rupiah','Rp',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('VND','704','Vietnamese Dong','₫',0,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('INR','356','Indian Rupee','₹',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('KRW','410','South Korean Won','₩',0,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('BDT','050','Bangladeshi Taka','৳',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('PKR','586','Pakistani Rupee','₨',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('LKR','144','Sri Lankan Rupee','Rs',2,'Asia',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('EUR','978','Euro','€',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('GBP','826','British Pound Sterling','£',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('CHF','756','Swiss Franc','CHF',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('DKK','208','Danish Krone','kr',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('SEK','752','Swedish Krona','kr',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('NOK','578','Norwegian Krone','kr',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('PLN','985','Polish Zloty','zł',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('CZK','203','Czech Koruna','Kč',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('HUF','348','Hungarian Forint','Ft',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('RON','946','Romanian Leu','lei',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('TRY','949','Turkish Lira','₺',2,'Europe',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('AED','784','United Arab Emirates Dirham','د.إ',2,'Middle East',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('SAR','682','Saudi Riyal','ر.س',2,'Middle East',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('QAR','634','Qatari Riyal','ر.ق',2,'Middle East',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('KWD','414','Kuwaiti Dinar','د.ك',3,'Middle East',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('BHD','048','Bahraini Dinar','د.ب',3,'Middle East',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('OMR','512','Omani Rial','ر.ع.',3,'Middle East',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('JOD','400','Jordanian Dinar','د.ا',3,'Middle East',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('ILS','376','Israeli New Shekel','₪',2,'Middle East',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('ZAR','710','South African Rand','R',2,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('NGN','566','Nigerian Naira','₦',2,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('KES','404','Kenyan Shilling','KSh',2,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('GHS','936','Ghanaian Cedi','GH₵',2,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('EGP','818','Egyptian Pound','E£',2,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('MAD','504','Moroccan Dirham','د.م.',2,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('TZS','834','Tanzanian Shilling','TSh',2,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('UGX','800','Ugandan Shilling','USh',0,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('RWF','646','Rwandan Franc','RF',0,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('XOF','952','West African CFA Franc','CFA',0,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP),
  ('XAF','950','Central African CFA Franc','FCFA',0,'Africa',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE,CURRENT_TIMESTAMP);

ALTER TABLE "Store" ADD COLUMN "baseCurrency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "Store" ADD CONSTRAINT "Store_baseCurrency_fkey"
  FOREIGN KEY ("baseCurrency") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StoreCurrencyOffer" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "displayEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "checkoutEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreCurrencyOffer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreCurrencyOffer_storeId_currency_key" UNIQUE ("storeId", "currency")
);
CREATE INDEX "StoreCurrencyOffer_currency_displayEnabled_idx" ON "StoreCurrencyOffer"("currency", "displayEnabled");
ALTER TABLE "StoreCurrencyOffer" ADD CONSTRAINT "StoreCurrencyOffer_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreCurrencyOffer" ADD CONSTRAINT "StoreCurrencyOffer_currency_fkey"
  FOREIGN KEY ("currency") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ExchangeRateSnapshot" (
  "id" TEXT NOT NULL,
  "baseCurrency" VARCHAR(3) NOT NULL,
  "quoteCurrency" VARCHAR(3) NOT NULL,
  "rate" DECIMAL(30,12) NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "sourceDate" DATE NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExchangeRateSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExchangeRateSnapshot_pair_check" CHECK ("baseCurrency" <> "quoteCurrency"),
  CONSTRAINT "ExchangeRateSnapshot_rate_check" CHECK ("rate" > 0),
  CONSTRAINT "ExchangeRateSnapshot_pair_provider_date_key" UNIQUE ("baseCurrency", "quoteCurrency", "provider", "sourceDate")
);
CREATE INDEX "ExchangeRateSnapshot_baseCurrency_quoteCurrency_fetchedAt_idx"
  ON "ExchangeRateSnapshot"("baseCurrency", "quoteCurrency", "fetchedAt");
ALTER TABLE "ExchangeRateSnapshot" ADD CONSTRAINT "ExchangeRateSnapshot_baseCurrency_fkey"
  FOREIGN KEY ("baseCurrency") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExchangeRateSnapshot" ADD CONSTRAINT "ExchangeRateSnapshot_quoteCurrency_fkey"
  FOREIGN KEY ("quoteCurrency") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ManualExchangeRateVersion" (
  "id" TEXT NOT NULL,
  "storeId" TEXT,
  "version" INTEGER NOT NULL,
  "baseCurrency" VARCHAR(3) NOT NULL,
  "quoteCurrency" VARCHAR(3) NOT NULL,
  "rate" DECIMAL(30,12) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveUntil" TIMESTAMP(3),
  "reason" VARCHAR(500) NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManualExchangeRateVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualExchangeRateVersion_rate_check" CHECK ("rate" > 0),
  CONSTRAINT "ManualExchangeRateVersion_pair_check" CHECK ("baseCurrency" <> "quoteCurrency"),
  CONSTRAINT "ManualExchangeRateVersion_effective_check" CHECK ("effectiveUntil" IS NULL OR "effectiveUntil" > "effectiveFrom")
);
CREATE UNIQUE INDEX "ManualExchangeRateVersion_storeId_baseCurrency_quoteCurrency_version_key"
  ON "ManualExchangeRateVersion"("storeId", "baseCurrency", "quoteCurrency", "version");
CREATE UNIQUE INDEX "ManualExchangeRateVersion_store_pair_version_key"
  ON "ManualExchangeRateVersion"("storeId", "baseCurrency", "quoteCurrency", "version") WHERE "storeId" IS NOT NULL;
CREATE UNIQUE INDEX "ManualExchangeRateVersion_global_pair_version_key"
  ON "ManualExchangeRateVersion"("baseCurrency", "quoteCurrency", "version") WHERE "storeId" IS NULL;
CREATE INDEX "ManualExchangeRateVersion_store_pair_effective_idx"
  ON "ManualExchangeRateVersion"("storeId", "baseCurrency", "quoteCurrency", "effectiveFrom", "effectiveUntil");
ALTER TABLE "ManualExchangeRateVersion" ADD CONSTRAINT "ManualExchangeRateVersion_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualExchangeRateVersion" ADD CONSTRAINT "ManualExchangeRateVersion_baseCurrency_fkey"
  FOREIGN KEY ("baseCurrency") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualExchangeRateVersion" ADD CONSTRAINT "ManualExchangeRateVersion_quoteCurrency_fkey"
  FOREIGN KEY ("quoteCurrency") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualExchangeRateVersion" ADD CONSTRAINT "ManualExchangeRateVersion_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
