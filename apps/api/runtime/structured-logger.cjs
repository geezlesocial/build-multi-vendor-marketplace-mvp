const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const context = new AsyncLocalStorage();
const eventCodes = new Set([
  'HTTP_REQUEST_FAILED',
  'CONTENT_SCHEDULER_FAILED',
  'STORE_SUBSCRIPTION_EXPIRY_FAILED',
  'STORE_EMAIL_DELIVERY_WORKER_FAILED',
  'TRANSACTIONAL_EMAIL_DELIVERY_WORKER_FAILED',
  'MARKETPLACE_AD_BUDGET_RECONCILIATION_FAILED',
  'JIMA_RETENTION_CLEANUP_FAILED',
  'MESSAGE_DRAFT_CLEANUP_FAILED',
  'REFERENCE_EXCHANGE_RATE_REFRESH_FAILED',
  'LIVE_PROVIDER_SYNC_FAILED',
  'APPLICATION_ERROR',
  'APPLICATION_WARNING'
]);
const errorCategories = new Map([
  ['TypeError', 'RUNTIME_TYPE_ERROR'],
  ['ReferenceError', 'RUNTIME_REFERENCE_ERROR'],
  ['SyntaxError', 'RUNTIME_SYNTAX_ERROR'],
  ['RangeError', 'RUNTIME_RANGE_ERROR'],
  ['PrismaClientKnownRequestError', 'DATABASE_QUERY_ERROR'],
  ['PrismaClientInitializationError', 'DATABASE_CONNECTION_ERROR'],
  ['PrismaClientValidationError', 'DATABASE_VALIDATION_ERROR'],
  ['ZodError', 'INPUT_VALIDATION_ERROR'],
  ['MediaScannerError', 'MEDIA_SCANNER_ERROR']
]);

function errorCategory(error) {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR';
  return errorCategories.get(error.constructor?.name) ?? 'APPLICATION_ERROR';
}

function emit(level, event, error) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event: eventCodes.has(event) ? event : level === 'warn' ? 'APPLICATION_WARNING' : 'APPLICATION_ERROR',
    correlationId: context.getStore()?.correlationId ?? randomUUID(),
    errorCategory: errorCategory(error)
  };
  process[level === 'warn' ? 'stdout' : 'stderr'].write(`${JSON.stringify(record)}\n`);
}

function runWithRequestContext(correlationId, callback) {
  return context.run({ correlationId }, callback);
}

function logOperationalError(event, error) { emit('error', event, error); }

module.exports = { runWithRequestContext, logOperationalError, emit };
