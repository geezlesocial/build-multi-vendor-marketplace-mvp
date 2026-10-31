// Runtime boundary: allow structured events, never arbitrary messages/stack traces.
const { emit } = require('./structured-logger.cjs');
const originalLog = console.log.bind(console);

console.error = (...args) => {
  const event = typeof args[0] === 'string' ? args[0] : 'APPLICATION_ERROR';
  emit('error', event, args.find(value => value instanceof Error));
};

console.warn = (...args) => {
  const event = typeof args[0] === 'string' ? args[0] : 'APPLICATION_WARNING';
  emit('warn', event, args.find(value => value instanceof Error));
};

console.log = (...args) => {
  const message = typeof args[0] === 'string' ? args[0] : '';
  originalLog(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event: message.startsWith('Marketplace API listening on http://localhost:') ? 'API_LISTENING' : 'APPLICATION_EVENT'
  }));
};
