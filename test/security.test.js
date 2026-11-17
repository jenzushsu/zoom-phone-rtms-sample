const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { streamSignature, validateWebhook, validationResponse } = require('../src/lib/security');
test('stream signature is HMAC-SHA256', () => {
  const expected = crypto.createHmac('sha256', 'secret').update('id,call,stream').digest('hex');
  assert.equal(streamSignature('id', 'secret', 'call', 'stream'), expected);
});
test('webhook signature verifies raw body and rejects tampering and old timestamps', () => {
  const timestamp = '1700000000';
  const rawBody = Buffer.from('{"hello":"world"}');
  const signature = 'v0=' + crypto.createHmac('sha256', 'token').update(`v0:${timestamp}:`).update(rawBody).digest('hex');
  const args = { headers: { 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signature }, rawBody, secret: 'token', now: 1700000000000 };
  assert.equal(validateWebhook(args), true);
  assert.equal(validateWebhook({ ...args, rawBody: Buffer.from('{}') }), false);
  assert.equal(validateWebhook({ ...args, now: 1700001000000 }), false);
  assert.equal(validateWebhook({ ...args, headers: { ...args.headers, 'x-zm-signature': 'bad' } }), false);
});
test('URL validation returns plain and encrypted token', () => {
  const result = validationResponse('plain', 'secret');
  assert.equal(result.plainToken, 'plain');
  assert.equal(result.encryptedToken, crypto.createHmac('sha256', 'secret').update('plain').digest('hex'));
});
