import type { Prisma } from '@prisma/client';
import { env } from './config.js';
import { reservedStoreSlug, storeSlugFromName } from './platform-domain.js';

type Transaction = Prisma.TransactionClient;

/**
 * Creates the standard Store for an approved seller, or repairs its base-currency
 * offer if the Store already exists. Safe to call repeatedly inside a transaction.
 */
export async function provisionApprovedSellerStore(tx: Transaction, input: { sellerId: string; sellerName: string }) {
  const existing = await tx.store.findUnique({ where: { sellerId: input.sellerId } });
  const storeCurrency = existing?.baseCurrency ?? env.CURRENCY;
  const currency = await tx.currencyCatalogEntry.findUnique({
    where: { code: storeCurrency },
    select: { code: true, active: true, checkoutEnabled: true }
  });
  if (!currency) {
    throw Object.assign(new Error(`Store provisioning needs ${storeCurrency} in the platform currency catalog. Configure the catalog and retry approval.`), { statusCode: 409, code: 'STORE_BASE_CURRENCY_NOT_CONFIGURED' });
  }

  const store = existing ?? await (async () => {
    const sellerSlug = input.sellerId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8) || 'seller';
    let baseSlug = storeSlugFromName(input.sellerName).slice(0, 60).replace(/-+$/g, '') || 'seller';
    if (reservedStoreSlug(baseSlug)) baseSlug = `${baseSlug}-store`;
    let slug = `${baseSlug}-${sellerSlug}`;
    let suffix = 1;
    while (await tx.store.findUnique({ where: { slug }, select: { id: true } })) {
      suffix += 1;
      slug = `${baseSlug}-${sellerSlug}-${suffix}`;
      if (suffix > 10) throw Object.assign(new Error('A unique Store URL could not be assigned. Rename the conflicting Store and retry.'), { statusCode: 409, code: 'STORE_SLUG_CONFLICT' });
    }
    return tx.store.create({ data: {
      sellerId: input.sellerId,
      name: `${input.sellerName.trim() || 'Seller'}'s Store`.slice(0, 120),
      slug,
      baseCurrency: currency.code
    } });
  })();

  await tx.storeCurrencyOffer.upsert({
    where: { storeId_currency: { storeId: store.id, currency: currency.code } },
    update: {},
    create: {
      storeId: store.id,
      currency: currency.code,
      displayEnabled: true,
      checkoutEnabled: currency.active && currency.checkoutEnabled
    }
  });
  return { store, created: !existing };
}
