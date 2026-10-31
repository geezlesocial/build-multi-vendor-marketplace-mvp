// Staging container log boundary: preserve operational event labels but never
// forward arbitrary exception strings, provider payloads, headers, or values.
const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);
const originalLog = console.log.bind(console);

const safeEvents = new Set([
  'Content scheduler failed',
  'Store subscription expiry scheduler failed',
  'Store email delivery worker failed',
  'Transactional email delivery worker failed',
  'Marketplace ad budget expiry reconciliation failed',
  'Jima retention cleanup failed',
  'Message draft cleanup failed',
  'Reference exchange-rate refresh failed',
  'Unhandled application error (details redacted)'
]);

console.error = (...args) => {
  const event = typeof args[0] === 'string' ? args[0] : '';
  originalError(safeEvents.has(event) ? event : 'Unhandled application error (details redacted)');
};

console.warn = (...args) => {
  const event = typeof args[0] === 'string' ? args[0] : '';
  originalWarn(safeEvents.has(event) ? event : 'Application warning (details redacted)');
};

console.log = (...args) => {
  const message = typeof args[0] === 'string' ? args[0] : '';
  if (message.startsWith('Marketplace API listening on http://localhost:')) {
    originalLog(message);
  } else {
    originalLog('Application event (details redacted)');
  }
};
