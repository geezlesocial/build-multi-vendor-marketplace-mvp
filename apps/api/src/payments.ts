import crypto from 'node:crypto';
import Stripe from 'stripe';
import { env } from './config.js';

export const stripe = env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.includes('placeholder') ? new Stripe(env.STRIPE_SECRET_KEY) : null;

export async function createStripeCheckout(order: { id: string; orderNumber: string; totalMinor: number; currency: string; buyerEmail: string }, successUrl: string, cancelUrl: string) {
  if (!stripe) throw new Error('Stripe is not configured');
  return stripe.checkout.sessions.create({ mode: 'payment', customer_email: order.buyerEmail, line_items: [{ price_data: { currency: order.currency.toLowerCase(), product_data: { name: `Marketplace order ${order.orderNumber}` }, unit_amount: order.totalMinor }, quantity: 1 }], metadata: { orderId: order.id, orderNumber: order.orderNumber }, success_url: successUrl, cancel_url: cancelUrl }, { idempotencyKey: `order-${order.id}` });
}

export async function createPaymongoCheckout(order: { id: string; orderNumber: string; totalMinor: number; currency: string }, successUrl: string, cancelUrl: string) {
  const key = env.PAYMONGO_SECRET_KEY;
  if (!key || key.toLowerCase().includes('placeholder')) throw new Error('PayMongo is not configured with a real API secret.');
  if (order.currency !== 'PHP') throw new Error('PayMongo checkout is restricted to PHP.');
  const auth = Buffer.from(`${key}:`).toString('base64');
  const response = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', 'Idempotency-Key': `marketplace-checkout-${order.id}` },
    body: JSON.stringify({ data: { attributes: {
      line_items: [{ name: `Marketplace order ${order.orderNumber}`, amount: order.totalMinor, currency: 'PHP', quantity: 1 }],
      payment_method_types: ['card', 'gcash', 'qrph'],
      success_url: successUrl, cancel_url: cancelUrl, reference_number: order.id, pass_on_fees: false,
      metadata: { orderId: order.id, orderNumber: order.orderNumber }
    } } })
  });
  if (!response.ok) throw new Error(`PayMongo checkout session could not be created (${response.status}).`);
  const result = await response.json() as { data?: { id?: string; attributes?: { checkout_url?: string } } };
  const id = result.data?.id;
  const checkoutUrl = result.data?.attributes?.checkout_url;
  if (!id || !checkoutUrl || !checkoutUrl.startsWith('https://checkout.paymongo.com/')) throw new Error('PayMongo returned an invalid checkout session.');
  return { id, checkoutUrl };
}

export async function createPaystackTransaction(order: { id: string; orderNumber: string; totalMinor: number; currency: string; buyerEmail: string }, callbackUrl: string) {
  const key = env.PAYSTACK_SECRET_KEY;
  if (!key || key.toLowerCase().includes('placeholder')) throw new Error('Paystack is not configured with a real API secret.');
  if (order.currency !== 'NGN') throw new Error('Paystack checkout is restricted to NGN.');
  const reference = `ML${order.id.replace(/[^A-Za-z0-9=.\-]/g, '')}`;
  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: order.buyerEmail, amount: String(order.totalMinor), currency: 'NGN', reference, callback_url: callbackUrl, metadata: { orderId: order.id, orderNumber: order.orderNumber } })
  });
  if (!response.ok) throw new Error(`Paystack transaction could not be initialized (${response.status}).`);
  const result = await response.json() as { status?: boolean; data?: { authorization_url?: string; access_code?: string; reference?: string } };
  const authorizationUrl = result.data?.authorization_url;
  if (!result.status || !authorizationUrl || !authorizationUrl.startsWith('https://checkout.paystack.com/') || result.data?.reference !== reference) throw new Error('Paystack returned an invalid transaction response.');
  return { authorizationUrl, reference: result.data.reference, accessCode: result.data.access_code ?? null };
}

export async function createStripeStoreBusterCheckout(input: { fundingIntentId: string; amountMinor: number; currency: string; buyerEmail: string }, successUrl: string, cancelUrl: string) {
  if (!stripe) throw new Error('Stripe is not configured');
  return stripe.checkout.sessions.create({
    mode: 'payment', customer_email: input.buyerEmail,
    line_items: [{ price_data: { currency: input.currency.toLowerCase(), product_data: { name: 'Store Buster prepaid advertising balance' }, unit_amount: input.amountMinor }, quantity: 1 }],
    metadata: { purpose: 'STORE_BUSTER_AD_BALANCE', fundingIntentId: input.fundingIntentId },
    payment_intent_data: { metadata: { purpose: 'STORE_BUSTER_AD_BALANCE', fundingIntentId: input.fundingIntentId } },
    success_url: successUrl, cancel_url: cancelUrl
  }, { idempotencyKey: `store-buster-funding-${input.fundingIntentId}` });
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

function paypalRequestId(action: 'ORDER' | 'CAPTURE', identity: string) {
  const digest = crypto.createHash('sha256').update(`marketplace:${action}:${identity}`).digest('hex').slice(0, 32);
  return `ml-${action === 'ORDER' ? 'o' : 'c'}-${digest}`;
}

export async function createPaypalOrder(order: { id: string; orderNumber: string; totalMinor: number; currency: string }) {
  const token = await paypalAccessToken();
  const value = (order.totalMinor / 100).toFixed(2);
  const response = await fetch(`${env.PAYPAL_BASE_URL}/v2/checkout/orders`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': paypalRequestId('ORDER', order.id) }, body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ reference_id: order.id, custom_id: order.id, description: `Marketplace order ${order.orderNumber}`, amount: { currency_code: order.currency, value } }], application_context: { user_action: 'PAY_NOW' } }) });
  if (!response.ok) throw new Error(`PayPal create order failed (${response.status})`);
  return response.json() as Promise<{ id: string; status: string; links?: { rel: string; href: string }[] }>;
}

export async function createPaypalStoreBusterOrder(input: { fundingIntentId: string; amountDecimal: string; currency: string; returnUrl: string; cancelUrl: string }) {
  const token = await paypalAccessToken();
  const reference = `store-buster-ad:${input.fundingIntentId}`;
  const response = await fetch(`${env.PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `store-buster-${input.fundingIntentId}` },
    body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ reference_id: reference, custom_id: reference, description: 'Store Buster prepaid advertising balance', amount: { currency_code: input.currency, value: input.amountDecimal } }], application_context: { user_action: 'PAY_NOW', return_url: input.returnUrl, cancel_url: input.cancelUrl } })
  });
  if (!response.ok) throw new Error(`PayPal ad balance order failed (${response.status})`);
  return response.json() as Promise<{ id: string; status: string; links?: { rel: string; href: string }[] }>;
}

export async function capturePaypalOrder(providerOrderId: string, requestId: string = paypalRequestId('CAPTURE', providerOrderId)) {
  const token = await paypalAccessToken();
  const response = await fetch(`${env.PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': requestId } });
  if (!response.ok) throw new Error(`PayPal capture failed (${response.status})`);
  return response.json() as Promise<{ id: string; status: string; purchase_units?: { custom_id?: string; reference_id?: string; payments?: { captures?: { id: string; status: string; amount?: { currency_code: string; value: string } }[] } }[] }>;
}
