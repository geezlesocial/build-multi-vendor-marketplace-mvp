import { LiveSessionStatus, ProductStatus, SellerStatus } from '@prisma/client';
import { env } from './config.js';
import { prisma } from './security.js';
import { liveProvider, type LiveProviderReadiness } from './live-provider.js';
import { canTransition } from './live-state.js';

export function canTransitionLiveSession(from: LiveSessionStatus, to: LiveSessionStatus) {
  return canTransition(from, to);
}

export async function liveShoppingState() {
  const [settings, readiness] = await Promise.all([
    prisma.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { liveShoppingEnabled: true } }),
    liveProvider.getReadiness()
  ]);
  const runtimeEnabled = settings?.liveShoppingEnabled ?? false;
  const deploymentGate = env.LIVE_SHOPPING_AVAILABLE;
  const effectiveEnabled = deploymentGate && runtimeEnabled && readiness.configured && readiness.healthy;
  const reason = !deploymentGate ? 'Deployment gate LIVE_SHOPPING_AVAILABLE is false.' : !runtimeEnabled ? 'Live shopping is disabled by the admin setting.' : !readiness.healthy ? readiness.reason : 'Live shopping is available.';
  return { deploymentGate, runtimeEnabled, effectiveEnabled, readiness, reason };
}

export async function requireLiveShopping() {
  const state = await liveShoppingState();
  if (!state.effectiveEnabled) {
    const error = new Error(state.reason);
    Object.assign(error, { statusCode: 409, liveShoppingState: state });
    throw error;
  }
  return state;
}

export async function eligibleSeller(sellerId: string) {
  return prisma.seller.findFirst({ where: { id: sellerId, status: SellerStatus.APPROVED } });
}

export async function eligibleProducts(sellerId: string, productIds: string[]) {
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, sellerId, status: ProductStatus.APPROVED }, select: { id: true } });
  if (products.length !== productIds.length) throw new Error('Every linked product must belong to this approved seller and be approved.');
  return products;
}

export function publicLiveSession<T extends { providerSessionRef?: string | null; playbackRef?: string | null }>(session: T) {
  const { providerSessionRef: _providerSessionRef, playbackRef, ...safe } = session;
  return { ...safe, playbackAvailable: Boolean(playbackRef) };
}

export type { LiveProviderReadiness };
