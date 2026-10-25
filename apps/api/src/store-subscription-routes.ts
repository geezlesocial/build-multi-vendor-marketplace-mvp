import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Role, SellerStatus } from '@prisma/client';
import type Stripe from 'stripe';
import { env } from './config.js';
import { prisma, requireAuth, requireRole } from './security.js';
import { requestStoreSubscriptionCancellation, processStripeStoreBillingEvent, SubscriptionBillingError } from './store-subscription-lifecycle.js';
import { stripeStoreBillingProvider, verifyStripeStoreBillingWebhook } from './stripe-store-billing.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const routeParam = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const user = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };

export function registerStoreSubscriptionRoutes(app: Express) {
  app.post('/api/webhooks/stripe/store-billing', express.raw({ type: 'application/json' }), run(async (req, res) => {
    const rawBody = ((req as Request & { rawBody?: Buffer }).rawBody ?? req.body) as Buffer;
    if (!Buffer.isBuffer(rawBody)) return res.status(400).json({ code: 'RAW_BODY_REQUIRED', error: 'A raw Stripe webhook body is required.' });
    let event: Stripe.Event;
    try {
      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string') return res.status(400).json({ code: 'SIGNATURE_REQUIRED', error: 'A Stripe signature is required.' });
      event = verifyStripeStoreBillingWebhook(rawBody, signature);
    } catch {
      return res.status(400).json({ code: 'INVALID_SIGNATURE', error: 'The Stripe Store billing signature could not be verified.' });
    }
    try {
      const result = await processStripeStoreBillingEvent(prisma, event);
      return res.status(200).json({ received: true, reconciliation: result.reconciliation, duplicate: result.duplicate });
    } catch (error) {
      const code = error instanceof SubscriptionBillingError ? error.code : 'PROCESSING_FAILED';
      // A non-2xx response asks Stripe to retry. Financial state and the event
      // status are separately committed so a retry can resume incomplete work.
      return res.status(500).json({ code: 'STORE_BILLING_RECONCILIATION_FAILED', reason: code });
    }
  }));

  app.post('/api/seller/billing/:subscriptionId/cancel', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    if (!env.STORE_PLAN_BILLING_SANDBOX_ENABLED) return res.status(503).json({ code: 'PLAN_BILLING_DISABLED', error: 'Stripe Store billing sandbox is disabled.' });
    const provider = stripeStoreBillingProvider();
    if (!provider) return res.status(503).json({ code: 'PLAN_BILLING_DISABLED', error: 'Stripe Store billing sandbox is not configured.' });
    const current = user(res);
    if (!current.sellerId) return res.status(403).json({ error: 'Seller scope required.' });
    const seller = await prisma.seller.findFirst({ where: { id: current.sellerId, status: SellerStatus.APPROVED }, select: { store: { select: { id: true } } } });
    if (!seller?.store) return res.status(404).json({ error: 'The approved seller Store is unavailable.' });
    try {
      const subscription = await requestStoreSubscriptionCancellation(prisma, provider, { subscriptionId: routeParam(req.params.subscriptionId), storeId: seller.store.id, actorId: current.id });
      return res.json({ id: subscription.id, status: subscription.status, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd, expiresAt: subscription.expiresAt });
    } catch (error) {
      if (error instanceof SubscriptionBillingError) return res.status(error.code === 'SUBSCRIPTION_NOT_FOUND' ? 404 : 409).json({ code: error.code, error: error.message });
      throw error;
    }
  }));

  app.get('/api/admin/store-billing/events', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const events = await prisma.storeSubscriptionEvent.findMany({
      orderBy: { receivedAt: 'desc' }, take: 100,
      select: { id: true, provider: true, providerEventId: true, eventType: true, status: true, signatureVerified: true, subscriptionId: true, safeSummary: true, errorCode: true, receivedAt: true, processedAt: true }
    });
    res.json(events);
  }));
}
