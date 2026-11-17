const crypto = require('node:crypto');

function streamSignature(clientId, clientSecret, callId, streamId) {
  return crypto.createHmac('sha256', clientSecret)
    .update(`${clientId},${callId},${streamId}`).digest('hex');
}
function validateWebhook({ headers, rawBody, secret, maxAgeSeconds = 300, now = Date.now() }) {
  const timestamp = headers['x-zm-request-timestamp'];
  const signature = headers['x-zm-signature'];
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) || typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > maxAgeSeconds) return false;
  const expected = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:`).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected); const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validationResponse(plainToken, secret) {
  return { plainToken, encryptedToken: crypto.createHmac('sha256', secret).update(plainToken).digest('hex') };
}
module.exports = { streamSignature, validateWebhook, validationResponse };
