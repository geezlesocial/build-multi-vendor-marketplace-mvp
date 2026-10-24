import { decimalToMinorExact } from './currency-domain.js';
import type { VerifiedPaymentEvent } from './payment-webhook-reconciliation.js';

type JsonRecord = Record<string, unknown>;
type MinorUnitLookup = (currency: string) => Promise<number | null>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function amountEvidence(value: unknown, lookupMinorUnit: MinorUnitLookup) {
  const amount = record(value);
  const currency = text(amount?.currency_code)?.toUpperCase() ?? null;
  const decimalAmount = text(amount?.value);
  let amountMinor: number | null = null;
  if (currency && decimalAmount) {
    const exponent = await lookupMinorUnit(currency);
    if (exponent !== null) {
      try { amountMinor = decimalToMinorExact(decimalAmount, exponent); }
      catch { amountMinor = null; }
    }
  }
  return { amountMinor, currency };
}

/**
 * Converts an already signature-verified PayPal event into the facts consumed by
 * the transactional reconciler. Order-completed events count as captures only
 * when the payload contains one completed capture tied to this marketplace order.
 */
export async function paypalWebhookEventToVerifiedPaymentEvent(input: unknown, lookupMinorUnit: MinorUnitLookup): Promise<VerifiedPaymentEvent> {
  const event = record(input);
  const eventId = text(event?.id);
  const eventType = text(event?.event_type);
  if (!eventId || !eventType) throw new Error('PayPal webhook event identity is incomplete.');

  const resource = record(event?.resource);
  const supplementary = record(resource?.supplementary_data);
  const relatedIds = record(supplementary?.related_ids);
  const occurredAtValue = text(event?.create_time);
  const occurredAt = occurredAtValue && Number.isFinite(Date.parse(occurredAtValue)) ? new Date(occurredAtValue) : null;

  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    const providerOrderId = text(relatedIds?.order_id);
    const captureId = text(resource?.id);
    const { amountMinor, currency } = await amountEvidence(resource?.amount, lookupMinorUnit);
    return {
      provider: 'PAYPAL', eventId, eventType,
      providerObjectRef: providerOrderId, paymentLookupRef: providerOrderId,
      amountMinor, currency, occurredAt,
      captureConfirmed: resource?.status === 'COMPLETED' && Boolean(captureId && providerOrderId)
    };
  }

  if (eventType === 'CHECKOUT.ORDER.COMPLETED') {
    const providerOrderId = text(resource?.id);
    const units = Array.isArray(resource?.purchase_units) ? resource.purchase_units.map(record) : [];
    const purchaseUnit = units.length === 1 ? units[0] : null;
    const customId = text(purchaseUnit?.custom_id);
    const referenceId = text(purchaseUnit?.reference_id);
    const metadataOrderId = customId ?? referenceId;
    const payments = record(purchaseUnit?.payments);
    const captures = Array.isArray(payments?.captures) ? payments.captures.map(record) : [];
    const capture = captures.length === 1 ? captures[0] : null;
    const captureId = text(capture?.id);
    const { amountMinor, currency } = await amountEvidence(capture?.amount, lookupMinorUnit);
    const unitAssociationValid = Boolean(metadataOrderId)
      && (!customId || !referenceId || customId === referenceId);
    return {
      provider: 'PAYPAL', eventId, eventType,
      providerObjectRef: providerOrderId, paymentLookupRef: providerOrderId,
      metadataOrderId, amountMinor, currency, occurredAt,
      captureConfirmed: resource?.status === 'COMPLETED'
        && Boolean(providerOrderId && captureId)
        && purchaseUnit !== null && captures.length === 1 && unitAssociationValid
        && capture?.status === 'COMPLETED'
    };
  }

  // Preserve the established extraction for refunds, disputes, and unsupported
  // events; only capture events use capture-specific confirmation rules above.
  const providerRef = text(relatedIds?.order_id) ?? text(resource?.id);
  const { amountMinor, currency } = await amountEvidence(resource?.amount, lookupMinorUnit);
  return {
    provider: 'PAYPAL', eventId, eventType,
    providerObjectRef: providerRef, paymentLookupRef: providerRef,
    amountMinor, currency, occurredAt, captureConfirmed: false
  };
}
