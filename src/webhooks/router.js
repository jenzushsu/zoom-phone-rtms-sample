const express = require('express');
const { validateWebhook, validationResponse } = require('../lib/security');
function createWebhookRouter({ config, manager, logger, onWebhook = () => {} }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!validateWebhook({ headers: req.headers, rawBody: req.rawBody, secret: config.webhookSecret,
      maxAgeSeconds: config.webhookMaxAgeSeconds })) return res.status(401).json({ message: 'Invalid or expired Zoom signature' });
    next();
  });
  router.post('/', (req, res) => {
    if (req.body?.event === 'endpoint.url_validation') {
      const token = req.body?.payload?.plainToken;
      if (typeof token !== 'string' || !token) return res.status(400).json({ message: 'Missing plainToken' });
      return res.json(validationResponse(token, config.webhookSecret));
    }
    const { event, payload } = req.body || {};
    // Only signed call lifecycle events are shared; validation tokens and headers stay private.
    if (['phone.call_rtms_started', 'phone.call_rtms_stopped'].includes(event)) {
      onWebhook({ event, callId: payload?.call_id, streamId: payload?.rtms_stream_id,
        receivedAt: new Date().toISOString(), rawBody: req.rawBody.toString('utf8') });
    }
    if (event === 'phone.call_rtms_started') {
      try {
        const result = manager.start(payload);
        return res.status(200).json({ received: true, duplicate: result.duplicate });
      } catch (error) {
        logger.warn('webhook.start_rejected', { message: error.message });
        const capacity = error.message.includes('capacity');
        return res.status(capacity ? 503 : 400).json({ message: error.message });
      }
    }
    if (event === 'phone.call_rtms_stopped') {
      if (typeof payload?.rtms_stream_id !== 'string' || !payload.rtms_stream_id)
        return res.status(400).json({ message: 'Missing rtms_stream_id' });
      manager.stop(payload.rtms_stream_id);
    } else logger.info('webhook.ignored', { event });
    return res.json({ received: true });
  });
  return router;
}
module.exports = { createWebhookRouter };
