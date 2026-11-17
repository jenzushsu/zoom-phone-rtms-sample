const express = require('express');
const path = require('node:path');
const { createTranscriptHub } = require('./transcripts/hub');
const { createWebhookRouter } = require('./webhooks/router');
function createApp({ config, manager, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    next();
  });
  app.use(express.json({ limit: '256kb', verify: (req, _res, body) => { req.rawBody = Buffer.from(body); } }));
  const hub = createTranscriptHub({ manager, logger });
  app.locals.closeTranscripts = () => hub.close();
  app.use('/api/transcripts', hub.router);
  app.get('/api/status', (_req, res) => res.json({ status: 'ok', service: 'zoom-phone-rtms', activeStreams: manager.size, storage: 'memory-only' }));
  app.use(express.static(path.join(__dirname, '../public')));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  const router = createWebhookRouter({ config, manager, logger, onWebhook: hub.recordWebhook });
  app.use(['/api/webhooks/zoom', '/webhook'], (req, res, next) => {
    if (config.demoMode) return res.status(503).json({ message: 'Zoom webhooks are disabled in demo mode' });
    next();
  }, router);
  app.use((error, _req, res, _next) => {
    logger.warn('http.invalid_request', { message: error.message });
    res.status(error.status || 400).json({ message: 'Invalid request' });
  });
  return app;
}
module.exports = { createApp };
