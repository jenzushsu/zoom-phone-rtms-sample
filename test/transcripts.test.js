const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { createApp } = require('../src/app');
const { createTranscriptHub } = require('../src/transcripts/hub');
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(key => [key, () => {}]));
function manager() {
  const value = new EventEmitter();
  value.size = 0; value.stats = () => [];
  return value;
}
async function fixture(t, config = {}) {
  const source = manager();
  const app = createApp({ config, manager: source, logger });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { app.locals.closeTranscripts(); server.closeAllConnections(); server.close(); });
  return { source, app, url: `http://127.0.0.1:${server.address().port}` };
}
async function connect(url, t) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${url}/api/transcripts/events`, { signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  let buffer = '';
  return { controller, async next() {
    while (!buffer.includes('\n\n')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      buffer += new TextDecoder().decode(value);
    }
    const end = buffer.indexOf('\n\n');
    const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    return { type: frame.match(/^event: (.+)/m)[1], data: JSON.parse(frame.match(/^data: (.+)/m)[1]) };
  } };
}
test('public viewer, SSE transcript delivery, call lifecycle, reconnect and cleanup', { timeout: 5000 }, async t => {
  const { source, app, url } = await fixture(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Live transcript/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const client = await connect(url, t);
  assert.deepEqual(await client.next(), { type: 'snapshot', data: { sessions: [], transcripts: [], webhooks: [], rtms: [] } });
  source.stats = () => [{ streamId: 'stream', callId: 'call' }];
  source.emit('start', { streamId: 'stream', callId: 'call' });
  assert.equal((await client.next()).data[0].streamId, 'stream');
  source.emit('transcript', { streamId: 'stream', callId: 'call', content: { data: '<script>untrusted</script>', user_name: 'Alex', is_final: true } });
  const live = await client.next();
  assert.equal(live.type, 'transcript');
  assert.equal(live.data.text, '<script>untrusted</script>');
  assert.equal(live.data.speaker, 'Alex');
  assert.equal(live.data.isFinal, true);
  const second = await connect(url, t);
  assert.deepEqual((await second.next()).data.transcripts, [live.data]);
  source.stats = () => [];
  source.emit('stop', { streamId: 'stream', callId: 'call', reason: 'ended' });
  assert.equal((await client.next()).type, 'stopped');
  assert.deepEqual(await client.next(), { type: 'sessions', data: [] });
  app.locals.closeTranscripts();
  assert.equal(source.listenerCount('transcript'), 0);
});
test('history is bounded, malformed text is ignored, and alternate text fields normalize', { timeout: 5000 }, async t => {
  const { source, url } = await fixture(t);
  for (let index = 0; index < 505; index++) source.emit('transcript', { streamId: 'stream', callId: 'call', content: { text: `Line ${index}`, speaker_name: 'Jamie' } });
  source.emit('transcript', { content: null });
  source.emit('transcript', { content: { data: { invalid: true } } });
  const client = await connect(url, t);
  const { transcripts } = (await client.next()).data;
  assert.equal(transcripts.length, 500);
  assert.equal(transcripts[0].text, 'Line 5');
  assert.equal(transcripts.at(-1).text, 'Line 504');
  assert.equal(transcripts[0].speaker, 'Jamie');
});
test('demo mode keeps viewer public and rejects Zoom webhooks', async t => {
  const { url } = await fixture(t, { demoMode: true });
  const response = await fetch(`${url}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 503);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
});
test('viewer capacity rejects excess connections', () => {
  const source = manager();
  const hub = createTranscriptHub({ manager: source, logger, maxViewers: 0 });
  const route = hub.router.stack.find(layer => layer.route?.path === '/events').route.stack[0].handle;
  let status;
  route({}, { status(code) { status = code; return this; }, json() {} });
  assert.equal(status, 503);
  hub.close();
});

test('RTMS diagnostics preserve payloads, sample audio, bound history and replay on reconnect', { timeout: 5000 }, async t => {
  const { source, url } = await fixture(t);
  const client = await connect(url, t);
  await client.next();
  for (const msgType of [2, 4, 12, 14, 17]) {
    const rawBody = JSON.stringify({ msg_type: msgType, content: { data: 'original payload' } });
    source.emit('packet', { streamId: 'stream', callId: 'call', channel: msgType === 2 ? 'signaling' : 'audio',
      msgType, receivedAt: new Date().toISOString(), rawBody });
    const frame = await client.next();
    assert.equal(frame.type, 'rtms');
    assert.equal(frame.data.msgType, msgType);
    assert.equal(frame.data.rawBody, rawBody);
    assert.equal(frame.data.sampled, msgType === 14);
  }
  source.emit('packet', { streamId: 'stream', msgType: 14, rawBody: '{"msg_type":14}' });
  const second = await connect(url, t);
  const replay = (await second.next()).data.rtms;
  assert.equal(replay.length, 5);
  for (let index = 0; index < 205; index++) {
    source.emit('packet', { streamId: 'stream', msgType: 12, rawBody: JSON.stringify({ msg_type: 12, timestamp: index }) });
  }
  const third = await connect(url, t);
  const bounded = (await third.next()).data.rtms;
  assert.equal(bounded.length, 200);
  assert.equal(JSON.parse(bounded.at(-1).rawBody).timestamp, 204);
});

test('signed webhook bodies stream unchanged, reconnect, and exclude unsigned requests and validation tokens', { timeout: 5000 }, async t => {
  const crypto = require('node:crypto');
  const secret = 'test-webhook-secret';
  const { source, url } = await fixture(t, { webhookSecret: secret, webhookMaxAgeSeconds: 300 });
  source.start = () => ({ duplicate: false });
  source.stop = () => true;
  const client = await connect(url, t);
  await client.next();
  const rawBody = '{\n  "event": "phone.call_rtms_started",\n  "payload": { "call_id": "call-1", "rtms_stream_id": "stream-1", "custom": "你好 <script>" }\n}';
  async function post(body, signed = true, path = '/api/webhooks/zoom') {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signed ? signature : 'v0=invalid' }, body });
  }
  assert.equal((await post(rawBody)).status, 200);
  const frame = await client.next();
  assert.equal(frame.type, 'webhook');
  assert.equal(frame.data.rawBody, rawBody);
  assert.equal(frame.data.streamId, 'stream-1');
  assert.equal(frame.data.callId, 'call-1');
  assert.equal(frame.data.headers, undefined);
  assert.equal((await post(rawBody, false)).status, 401);
  assert.equal((await post(JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'private-token' } }))).status, 200);
  const reconnect = await connect(url, t);
  assert.deepEqual((await reconnect.next()).data.webhooks, [frame.data]);
  const stopped = JSON.stringify({ event: 'phone.call_rtms_stopped', payload: { rtms_stream_id: 'stream-1' } });
  assert.equal((await post(stopped, true, '/webhook')).status, 200);
  assert.equal((await client.next()).data.rawBody, stopped);
  for (let index = 0; index < 22; index++) assert.equal((await post(rawBody)).status, 200);
  const bounded = await connect(url, t);
  const history = (await bounded.next()).data.webhooks;
  assert.equal(history.length, 20);
  assert.ok(history[0].id > frame.data.id);
  assert.equal(history.at(-1).rawBody, rawBody);
});
