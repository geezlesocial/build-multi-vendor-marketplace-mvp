import crypto from 'node:crypto';
import Stripe from 'stripe';
import { env } from './config.js';

export const stripe = env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.includes('placeholder') ? new Stripe(env.STRIPE_SECRET_KEY) : null;

export async function createStripeCheckout(order: { id: string; orderNumber: string; totalMinor: number; currency: string; buyerEmail: string }, successUrl: string, cancelUrl: string) {
  if (!stripe) throw new Error('Stripe is not configured');
  return stripe.checkout.sessions.create({ mode: 'payment', customer_email: order.buyerEmail, line_items: [{ price_data: { currency: order.currency.toLowerCase(), product_data: { name: `Marketplace order ${order.orderNumber}` }, unit_amount: order.totalMinor }, quantity: 1 }], metadata: { orderId: order.id, orderNumber: order.orderNumber }, success_url: successUrl, cancel_url: cancelUrl }, { idempotencyKey: `order-${order.id}` });
}

export async function paypalAccessToken() {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || env.PAYPAL_CLIENT_ID.includes('placeholder')) throw new Error('PayPal is not configured');
  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${env.PAYPAL_BASE_URL}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!response.ok) throw new Error('PayPal authentication failed');
  const data = await response.json() as { access_token: string };
  return data.access_token;
}

export async function verifyPaypalWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
  if (!env.PAYPAL_WEBHOOK_ID) return false;
  const token = await paypalAccessToken();
  const header = (name: string) => { const value = headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; };
  const webhookEvent = JSON.parse(rawBody.toString('utf8'));
  const response = await fetch(`${env.PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ auth_algo: header('paypal-auth-algo'), cert_url: header('paypal-cert-url'), transmission_id: header('paypal-transmission-id'), transmission_sig: header('paypal-transmission-sig'), transmission_time: header('paypal-transmission-time'), webhook_id: env.PAYPAL_WEBHOOK_ID, webhook_event: webhookEvent }) });
  if (!response.ok) return false;
  const result = await response.json() as { verification_status?: string };
  return result.verification_status === 'SUCCESS';
}

export async function createPaypalOrder(order: { id: string; orderNumber: string; totalMinor: number; currency: string }) {
  const token = await paypalAccessToken();
  const value = (order.totalMinor / 100).toFixed(2);
  const response = await fetch(`${env.PAYPAL_BASE_URL}/v2/checkout/orders`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() }, body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ reference_id: order.id, custom_id: order.id, description: `Marketplace order ${order.orderNumber}`, amount: { currency_code: order.currency, value } }], application_context: { user_action: 'PAY_NOW' } }) });
  if (!response.ok) throw new Error(`PayPal create order failed (${response.status})`);
  return response.json() as Promise<{ id: string; status: string; links?: { rel: string; href: string }[] }>;
}

export async function capturePaypalOrder(providerOrderId: string) {
  const token = await paypalAccessToken();
  const response = await fetch(`${env.PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() } });
  if (!response.ok) throw new Error(`PayPal capture failed (${response.status})`);
  return response.json() as Promise<{ id: string; status: string; purchase_units?: { payments?: { captures?: { id: string; status: string }[] } }[] }>;
}
