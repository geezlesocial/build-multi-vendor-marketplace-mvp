import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { convertMinorExact } from './currency-domain.js';
import type { VerifiedPaymentEvent } from './payment-webhook-reconciliation.js';

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const asText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const safeEqualHex = (actual: string | undefined, expected: string) => {
  if (!actual || !/^[a-f0-9]+$/i.test(actual) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
};

export type ProviderChargeQuote = {
  provider: 'PAYMONGO' | 'PAYSTACK';
  currency: 'PHP' | 'NGN';
  amountMinor: number;
  baseCurrency: string;
  baseAmountMinor: number;
  rate: string;
  rateProvider: string;
  sourceDate: string;
  fetchedAt: string;
  rounding: 'HALF_UP';
};

export function providerCurrencyForMethod(method: string): 'PHP' | 'NGN' | null {
  if (method === 'PAYMONGO') return 'PHP';
  if (method === 'PAYSTACK') return 'NGN';
  return null;
}

export function createProviderChargeQuote(input: {
  provider: 'PAYMONGO' | 'PAYSTACK';
  baseCurrency: string;
  baseAmountMinor: number;
  baseExponent: number;
  rate: { rate: string; provider: string; sourceDate: string; fetchedAt: string };
  quoteExponent: number;
}): ProviderChargeQuote {
  const currency = input.provider === 'PAYMONGO' ? 'PHP' : 'NGN';
  const converted = convertMinorExact(BigInt(input.baseAmountMinor), input.rate.rate, input.baseExponent, input.quoteExponent);
  const amountMinor = Number(converted);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > 2_147_483_647) throw new Error('Converted provider charge is outside the supported amount range.');
  return { provider: input.provider, currency, amountMinor, baseCurrency: input.baseCurrency, baseAmountMinor: input.baseAmountMinor, rate: input.rate.rate, rateProvider: input.rate.provider, sourceDate: input.rate.sourceDate, fetchedAt: input.rate.fetchedAt, rounding: 'HALF_UP' };
}

export function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined, secret: string | undefined) {
  if (!secret) return false;
  return safeEqualHex(signature, createHmac('sha512', secret).update(rawBody).digest('hex'));
}

export function verifyPaymongoSignature(rawBody: Buffer, header: string | undefined, secret: string | undefined, liveMode: boolean, now = Date.now(), maxSkewSeconds = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(part => {
    const [key, ...value] = part.trim().split('=');
    return [key, value.join('=')];
  }));
  const timestamp = Number(parts.t);
  const signature = liveMode ? parts.li : parts.te;
  if (!Number.isInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > maxSkewSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  return safeEqualHex(signature, expected);
}

export function paymongoEventToVerifiedPaymentEvent(input: unknown, expectedLiveMode: boolean): VerifiedPaymentEvent | null {
  const envelope = asRecord(input);
  const eventData = asRecord(envelope?.data);
  const attributes = asRecord(eventData?.attributes);
  // Hosted Checkout v2 uses a flattened event envelope; other PayMongo
  // events use the nested attributes envelope.
  const eventType = asText(attributes?.type) ?? asText(eventData?.type);
  const resource = asRecord(attributes?.data) ?? asRecord(eventData?.data);
  const resourceAttributes = asRecord(resource?.attributes);
  const liveMode = attributes?.livemode ?? eventData?.livemode;
  if (!eventType || liveMode !== expectedLiveMode || !resource || !resourceAttributes) return null;
  const eventId = asText(envelope?.event_id) ?? asText(envelope?.id)
    ?? (attributes ? asText(eventData?.id) : null)
    ?? `paymongo_${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
  const createdAt = attributes?.created_at ?? eventData?.created_at;
  const occurredAt = typeof createdAt === 'number'
    ? new Date(createdAt * 1000)
    : typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)) ? new Date(createdAt) : null;

  if (eventType === 'checkout_session.payment.paid') {
    const sessionId = asText(resource?.id);
    const reference = asText(resourceAttributes?.reference_number);
    const intent = asRecord(resourceAttributes?.payment_intent);
    const intentId = asText(intent?.id);
    const intentAttributes = asRecord(intent?.attributes);
    const payments = Array.isArray(resourceAttributes?.payments) ? resourceAttributes.payments.map(asRecord).filter((item): item is RecordValue => item !== null) : [];
    const paid = payments.filter(item => asRecord(item.attributes)?.status === 'paid');
    const paidResource = paid.length === 1 ? paid[0] : null;
    const paidAttributes = asRecord(paidResource?.attributes);
    const amount = paidAttributes?.amount;
    const currency = asText(paidAttributes?.currency)?.toUpperCase() ?? asText(intentAttributes?.currency)?.toUpperCase() ?? null;
    return {
      provider: 'PAYMONGO', eventId, eventType, providerObjectRef: asText(paidResource?.id) ?? intentId,
      paymentLookupRef: sessionId, metadataOrderId: reference ?? asText(asRecord(resourceAttributes?.metadata)?.orderId),
      amountMinor: typeof amount === 'number' && Number.isSafeInteger(amount) ? amount : null,
      currency, occurredAt,
      // In Checkout v2, payment_intent can be an ID-only relationship. The
      // paid Payment embedded in the session is the settlement authority.
      captureConfirmed: Boolean(sessionId && reference && paidResource && paidAttributes?.currency === 'PHP' && paidAttributes?.status === 'paid' && (intentId || intentAttributes?.status === 'succeeded'))
    };
  }

  if (eventType === 'refund.succeeded' || eventType === 'dispute.created') {
    const resourceId = asText(resource?.id);
    const paymentId = asText(resourceAttributes?.payment_id) ?? asText(asRecord(resourceAttributes?.payment)?.id);
    const amount = resourceAttributes?.amount;
    const currency = asText(resourceAttributes?.currency)?.toUpperCase() ?? null;
    return {
      provider: 'PAYMONGO', eventId, eventType, providerObjectRef: paymentId ?? resourceId,
      paymentLookupRef: paymentId ?? resourceId,
      amountMinor: typeof amount === 'number' && Number.isSafeInteger(amount) ? amount : null,
      currency, occurredAt,
      captureConfirmed: false
    };
  }
  return null;
}

export function paystackEventToVerifiedPaymentEvent(input: unknown): VerifiedPaymentEvent | null {
  const envelope = asRecord(input);
  const eventType = asText(envelope?.event);
  const data = asRecord(envelope?.data);
  if (!eventType || !data) return null;
  const transaction = asRecord(data.transaction);
  const reference = asText(data.reference) ?? asText(data.transaction_reference) ?? asText(transaction?.reference);
  const currency = asText(data.currency)?.toUpperCase() ?? asText(transaction?.currency)?.toUpperCase() ?? null;
  const amountValue = data.amount ?? transaction?.amount;
  const amount = typeof amountValue === 'number' ? amountValue : typeof amountValue === 'string' && /^\d+$/.test(amountValue) ? Number(amountValue) : null;
  const resourceId = data.id !== undefined && data.id !== null ? String(data.id) : null;
  const eventId = eventType === 'refund.processed'
    ? asText(data.refund_reference) ?? resourceId ?? `paystack_${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`
    : resourceId ?? (reference ? `${eventType}:${reference}` : null);
  if (!reference || !eventId || amount === null || !Number.isSafeInteger(amount) || !currency) return null;
  const metadata = asRecord(data.metadata) ?? asRecord(transaction?.metadata);
  const supported = eventType === 'charge.success' || eventType === 'refund.processed' || eventType === 'charge.dispute.create';
  if (!supported) return null;
  return {
    provider: 'PAYSTACK', eventId, eventType, providerObjectRef: reference, paymentLookupRef: reference,
    metadataOrderId: asText(metadata?.orderId) ?? asText(data.order_id), amountMinor: amount, currency,
    occurredAt: (() => { const value = asText(data.paid_at) ?? asText(data.createdAt); return value && Number.isFinite(Date.parse(value)) ? new Date(value) : null; })(),
    captureConfirmed: eventType === 'charge.success' && asText(data.status) === 'success' && currency === 'NGN'
  };
}
