import { MediaScanStatus, MediaUploadStatus, Role, SellerStatus } from '@prisma/client';
import { prisma } from './security.js';

export type StoreBrandingActor = { id: string; sellerId?: string; role?: Role };

export async function authorizedBrandingStore(actor: StoreBrandingActor) {
  if (!actor.sellerId) return null;
  const seller = await prisma.seller.findFirst({
    where: { id: actor.sellerId, status: SellerStatus.APPROVED },
    select: { id: true, userId: true, store: true }
  });
  if (!seller?.store) return null;
  if (actor.role === Role.ADMIN && seller.store.isPlatformStore) return seller.store;
  if (seller.userId === actor.id) return seller.store;
  const permission = await prisma.sellerStaff.findFirst({
    where: { sellerId: seller.id, userId: actor.id, canManageStoreBranding: true }
  });
  return permission ? seller.store : null;
}

export async function authorizedBrandingAsset(actor: StoreBrandingActor, assetId: string) {
  const store = await authorizedBrandingStore(actor);
  if (!store) return null;
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: assetId, storeId: store.id, kind: 'IMAGE', uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: { not: MediaScanStatus.REJECTED } }
  });
  return asset ? { store, asset } : null;
}
