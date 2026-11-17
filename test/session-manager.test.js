const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { SessionManager, secureWsUrl } = require('../src/rtms/session-manager');
class FakeWebSocket extends EventEmitter {
  static sockets = [];
  constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 0; this.sent = []; FakeWebSocket.sockets.push(this); }
  open() { this.readyState = 1; this.emit('open'); }
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  close() { this.readyState = 3; this.emit('close', 1000); }
}
const config = { clientId: 'id', clientSecret: 'secret', protocolVersion: 2, audioSendRateMs: 20,
 enableAudio: true, enableTranscript: true, maxSessions: 5, logTranscripts: false };
const logger = Object.fromEntries(['debug','info','warn','error'].map(k => [k, () => {}]));
test('requires encrypted WebSocket URL', () => {
 assert.equal(secureWsUrl('wss://example.com/a'), true);
 assert.equal(secureWsUrl('ws://example.com'), false);
 assert.equal(secureWsUrl('not a url'), false);
});
test('uses snippet connection defaults and cleans up on close rather than error', () => {
 FakeWebSocket.sockets = [];
 const manager = new SessionManager(config, logger, { WebSocketImpl: FakeWebSocket });
 manager.start({ call_id: 'call', rtms_stream_id: 'stream', server_urls: 'wss://signal.example' });
 const signal = FakeWebSocket.sockets[0];
 assert.equal(signal.options, undefined);
 signal.emit('error', new Error('connection failed'));
 assert.equal(manager.size, 1);
 signal.close();
 assert.equal(manager.size, 0);
});
test('selects WSS endpoints from mixed transport lists and rejects SRT-only media', () => {
 FakeWebSocket.sockets = [];
 const manager = new SessionManager(config, logger, { WebSocketImpl: FakeWebSocket });
 manager.start({ call_id: 'call', rtms_stream_id: 'mixed',
   server_urls: 'wss://signal.example:443,srt://signal.example:8801' });
 const signal = FakeWebSocket.sockets[0];
 assert.equal(signal.url, 'wss://signal.example:443');
 signal.open();
 signal.receive({ msg_type: 2, status_code: 0, media_server: { server_urls: {
   audio: 'wss://media.example:443,srt://media.example:8801',
   transcript: 'srt://media.example:8801, wss://media.example:443' } } });
 assert.deepEqual(FakeWebSocket.sockets.slice(1).map(socket => socket.url),
   ['wss://media.example:443', 'wss://media.example:443']);
 assert.equal(manager.size, 1);
 manager.stopAll();
 manager.start({ call_id: 'call', rtms_stream_id: 'unsupported', server_urls: 'wss://signal.example' });
 const unsupported = FakeWebSocket.sockets.at(-1);
 unsupported.open();
 unsupported.receive({ msg_type: 2, status_code: 0, media_server: { server_urls: {
   audio: 'srt://media.example:8801', transcript: 'wss://media.example:443' } } });
 assert.equal(manager.size, 0);
 assert.equal(FakeWebSocket.sockets.length, 4);
});
test('starts signaling, connects both media sockets, ACKs and closes', () => {
 FakeWebSocket.sockets = [];
 const manager = new SessionManager(config, logger, { WebSocketImpl: FakeWebSocket });
 const payload = { call_id: 'call', rtms_stream_id: 'stream', server_urls: 'wss://signal.example' };
 const packets = [];
 manager.on('packet', packet => packets.push(packet));
 assert.deepEqual(manager.start(payload), { duplicate: false });
 assert.deepEqual(manager.start(payload), { duplicate: true });
 const signal = FakeWebSocket.sockets[0]; signal.open();
 assert.equal(signal.sent[0].msg_type, 1);
 assert.equal(signal.sent[0].protocol_version, 2);
 signal.receive({ msg_type: 2, status_code: 0, media_server: { server_urls: {
   audio: 'wss://audio.example', transcript: 'wss://transcript.example' } } });
 assert.equal(FakeWebSocket.sockets.length, 3);
 const audio = FakeWebSocket.sockets[1], transcript = FakeWebSocket.sockets[2];
 audio.open(); transcript.open();
 assert.equal(audio.sent[0].media_type, 1);
 assert.equal(transcript.sent[0].media_type, 8);
 audio.receive({ msg_type: 4, status_code: 0 }); transcript.receive({ msg_type: 4, status_code: 0 });
 assert.deepEqual(signal.sent.slice(1).map(m => m.media_type), [1, 8]);
 audio.receive({ msg_type: 12, timestamp: 123 });
 assert.deepEqual(audio.sent[1], { msg_type: 13, timestamp: 123 });
 audio.receive({ msg_type: 14, content: { data: 'YQ==' } });
 transcript.receive({ msg_type: 17, content: { data: 'hello' } });
 assert.deepEqual(packets.map(packet => packet.msgType), [2, 4, 4, 12, 14, 17]);
 assert.equal(JSON.parse(packets.at(-1).rawBody).content.data, 'hello');
 assert.equal(manager.stats()[0].audioChunks, 1);
 assert.equal(manager.stats()[0].transcripts, 1);
 assert.equal(manager.stop('stream'), true);
 assert.equal(manager.size, 0);
});
