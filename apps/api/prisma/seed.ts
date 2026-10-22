import { PrismaClient, ProductStatus, Role, SellerStatus, PaymentMethod } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { env } from '../src/config.js';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash(`LocalDemoOnly-ChangeMe-123!${env.PASSWORD_PEPPER}`, 12);
  const admin = await prisma.user.upsert({ where: { email: 'admin.local@example.test' }, update: { passwordHash, role: Role.ADMIN }, create: { email: 'admin.local@example.test', name: 'Local Admin', role: Role.ADMIN, passwordHash } });
  await prisma.user.upsert({ where: { email: 'editor.local@example.test' }, update: { passwordHash, role: Role.CONTENT_EDITOR }, create: { email: 'editor.local@example.test', name: 'Local Content Editor', role: Role.CONTENT_EDITOR, passwordHash } });
  const buyer = await prisma.user.upsert({ where: { email: 'buyer.local@example.test' }, update: { passwordHash, role: Role.BUYER }, create: { email: 'buyer.local@example.test', name: 'Local Buyer', role: Role.BUYER, passwordHash } });
  const sellerUser = await prisma.user.upsert({ where: { email: 'seller.local@example.test' }, update: { passwordHash, role: Role.SELLER }, create: { email: 'seller.local@example.test', name: 'Local Seller', role: Role.SELLER, passwordHash } });
  const seller = await prisma.seller.upsert({ where: { userId: sellerUser.id }, update: { status: SellerStatus.APPROVED }, create: { userId: sellerUser.id, status: SellerStatus.APPROVED, store: { create: { name: 'Demo Store', description: 'Local-only demo store.' } } } });
  const store = await prisma.store.findUnique({ where: { sellerId: seller.id } });
  if (store && !await prisma.storePlanAssignment.findFirst({ where: { storeId: store.id, status: 'ACTIVE' } })) {
    await prisma.storePlanAssignment.create({ data: { storeId: store.id, planVersionId: 'legacy-compatible-store-plan-v1', source: 'LEGACY_BOOTSTRAP', reason: 'Local demo compatibility assignment' } });
  }
  const category = await prisma.category.upsert({ where: { slug: 'featured' }, update: {}, create: { name: 'Featured', slug: 'featured' } });
  const product = await prisma.product.upsert({ where: { slug: 'demo-canvas-tote' }, update: {}, create: { sellerId: seller.id, categoryId: category.id, name: 'Demo Canvas Tote', slug: 'demo-canvas-tote', description: 'A local demo product for testing the marketplace flow.', priceMinor: 2400, status: ProductStatus.APPROVED, barcode: 'DEMO-001', inventory: { create: { quantity: 25 } } } });
  await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default', multiVendorEnabled: true, liveShoppingEnabled: false } });
  for (const method of Object.values(PaymentMethod)) await prisma.paymentMethodSettings.upsert({ where: { method }, update: {}, create: { id: method.toLowerCase(), method, enabled: method === PaymentMethod.COD } });
  await prisma.cart.upsert({ where: { userId: buyer.id }, update: {}, create: { userId: buyer.id, items: { create: { productId: product.id, quantity: 1 } } } });
  console.log(`Seeded local demo accounts: ${admin.email}, ${buyer.email}, ${sellerUser.email}`);
}

main().finally(() => prisma.$disconnect());
