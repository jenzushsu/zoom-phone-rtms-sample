const { loadConfig } = require('./config');
const { createLogger } = require('./lib/logger');
const { SessionManager } = require('./rtms/session-manager');
const { createApp } = require('./app');
const config = loadConfig();
const logger = createLogger(config.logLevel);
const manager = new SessionManager(config, logger);
const app = createApp({ config, manager, logger });
const server = app.listen(config.port, () => logger.info('server.started', { port: config.port,
  endpoints: ['/', '/api/transcripts/events', '/api/webhooks/zoom', '/webhook'], protocolVersion: config.protocolVersion,
  url: `http://localhost:${config.port}`, demoMode: config.demoMode }));
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info('server.shutdown', { signal });
  manager.stopAll('server shutdown');
  app.locals.closeTranscripts();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
