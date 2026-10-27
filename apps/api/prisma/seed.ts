import { PrismaClient, ProductStatus, Role, SellerStatus, PaymentMethod } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { env } from '../src/config.js';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash(`LocalDemoOnly-ChangeMe-123!${env.PASSWORD_PEPPER}`, 12);
  const demoOnboardingCompletedAt = new Date();
  const admin = await prisma.user.upsert({ where: { email: 'admin.local@example.test' }, update: { passwordHash, role: Role.ADMIN, onboardingCompletedAt: demoOnboardingCompletedAt }, create: { email: 'admin.local@example.test', name: 'Local Admin', role: Role.ADMIN, passwordHash, onboardingCompletedAt: demoOnboardingCompletedAt } });
  await prisma.user.upsert({ where: { email: 'editor.local@example.test' }, update: { passwordHash, role: Role.CONTENT_EDITOR, onboardingCompletedAt: demoOnboardingCompletedAt }, create: { email: 'editor.local@example.test', name: 'Local Content Editor', role: Role.CONTENT_EDITOR, passwordHash, onboardingCompletedAt: demoOnboardingCompletedAt } });
  const buyer = await prisma.user.upsert({ where: { email: 'buyer.local@example.test' }, update: { passwordHash, role: Role.BUYER, onboardingCompletedAt: demoOnboardingCompletedAt }, create: { email: 'buyer.local@example.test', name: 'Local Buyer', role: Role.BUYER, passwordHash, onboardingCompletedAt: demoOnboardingCompletedAt } });
  const sellerUser = await prisma.user.upsert({ where: { email: 'seller.local@example.test' }, update: { passwordHash, role: Role.SELLER, onboardingCompletedAt: demoOnboardingCompletedAt }, create: { email: 'seller.local@example.test', name: 'Local Seller', role: Role.SELLER, passwordHash, onboardingCompletedAt: demoOnboardingCompletedAt } });
  const seller = await prisma.seller.upsert({ where: { userId: sellerUser.id }, update: { status: SellerStatus.APPROVED }, create: { userId: sellerUser.id, status: SellerStatus.APPROVED, store: { create: { name: 'Demo Store', description: 'Local-only demo store.' } } } });
  const demoShipping = await prisma.sellerShippingService.upsert({ where: { id: 'local-demo-shipping-service' }, update: { sellerId: seller.id, name: 'Standard local delivery', enabled: true, supportsCod: true, feeMinor: 500, currency: env.CURRENCY, estimatedMinDays: 2, estimatedMaxDays: 5 }, create: { id: 'local-demo-shipping-service', sellerId: seller.id, name: 'Standard local delivery', enabled: true, supportsCod: true, feeMinor: 500, currency: env.CURRENCY, estimatedMinDays: 2, estimatedMaxDays: 5 } });
  await prisma.sellerShippingZone.upsert({ where: { id: 'local-demo-shipping-zone-us' }, update: { serviceId: demoShipping.id, countryCode: 'US', regionKey: '', regionLabel: null, cityKey: '', cityLabel: null }, create: { id: 'local-demo-shipping-zone-us', serviceId: demoShipping.id, countryCode: 'US', regionKey: '', regionLabel: null, cityKey: '', cityLabel: null } });
  const store = await prisma.store.findUnique({ where: { sellerId: seller.id } });
  if (store) {
    const usd = await prisma.currencyCatalogEntry.findUnique({ where: { code: 'USD' }, select: { active: true, checkoutEnabled: true } });
    if (usd) await prisma.storeCurrencyOffer.createMany({
      data: [{ storeId: store.id, currency: 'USD', displayEnabled: true, checkoutEnabled: usd.active && usd.checkoutEnabled }],
      skipDuplicates: true
    });
  }
  if (store && !await prisma.storePlanAssignment.findFirst({ where: { storeId: store.id, status: 'ACTIVE' } })) {
    await prisma.storePlanAssignment.create({ data: { storeId: store.id, planVersionId: 'legacy-compatible-store-plan-v1', source: 'LEGACY_BOOTSTRAP', reason: 'Local demo compatibility assignment' } });
  }
  const category = await prisma.category.upsert({ where: { slug: 'featured' }, update: {}, create: { name: 'Featured', slug: 'featured' } });
  const physicalType = await prisma.catalogProductType.upsert({ where: { slug: 'physical-product' }, update: {}, create: { id: 'ct_physical_default', name: 'Physical product', slug: 'physical-product', requiresShipping: true } });
  const product = await prisma.product.upsert({ where: { slug: 'demo-canvas-tote' }, update: { productTypeId: physicalType.id }, create: { sellerId: seller.id, categoryId: category.id, productTypeId: physicalType.id, name: 'Demo Canvas Tote', slug: 'demo-canvas-tote', description: 'A local demo product for testing the marketplace flow.', priceMinor: 2400, status: ProductStatus.APPROVED, barcode: 'DEMO-001', inventory: { create: { quantity: 25 } } } });
  await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default', multiVendorEnabled: true, liveShoppingEnabled: false } });
  for (const method of Object.values(PaymentMethod)) await prisma.paymentMethodSettings.upsert({ where: { method }, update: {}, create: { id: method.toLowerCase(), method, enabled: method === PaymentMethod.COD } });
  await prisma.cart.upsert({ where: { userId: buyer.id }, update: {}, create: { userId: buyer.id, items: { create: { productId: product.id, quantity: 1 } } } });
  console.log(`Seeded local demo accounts: ${admin.email}, ${buyer.email}, ${sellerUser.email}`);
}

main().finally(() => prisma.$disconnect());
