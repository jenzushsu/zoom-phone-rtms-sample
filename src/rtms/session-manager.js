const EventEmitter = require('node:events');
const WebSocket = require('ws');
const { MSG, MEDIA } = require('./constants');
const { streamSignature } = require('../lib/security');

function parseJson(data, logger, streamId, channel) {
  try { return JSON.parse(data.toString()); }
  catch { logger.warn('rtms.non_json_message', { streamId, channel }); return null; }
}
function send(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function secureWsUrl(value) {
  if (typeof value !== 'string') return false;
  try { return new URL(value).protocol === 'wss:'; } catch { return false; }
}
function selectWsUrl(value) {
  if (typeof value !== 'string') return undefined;
  return value.split(',').map(url => url.trim()).find(secureWsUrl);
}

class SessionManager extends EventEmitter {
  constructor(config, logger, { WebSocketImpl = WebSocket } = {}) {
    super(); this.config = config; this.logger = logger; this.WebSocketImpl = WebSocketImpl;
    this.sessions = new Map();
  }
  get size() { return this.sessions.size; }
  stats() {
    return Array.from(this.sessions.values(), s => ({
      streamId: s.streamId, callId: s.callId, createdAt: s.createdAt,
      audioChunks: s.audioChunks, transcripts: s.transcripts,
      audioReady: s.ready.has('audio'), transcriptReady: s.ready.has('transcript')
    }));
  }
  signature(s) { return streamSignature(this.config.clientId, this.config.clientSecret, s.callId, s.streamId); }
  start(payload) {
    const callId = payload?.call_id, streamId = payload?.rtms_stream_id;
    const signalingUrl = selectWsUrl(payload?.server_urls);
    if (typeof callId !== 'string' || !callId || typeof streamId !== 'string' || !streamId || !signalingUrl) {
      throw new Error('Invalid RTMS start payload or signaling URL (wss required)');
    }
    if (this.sessions.has(streamId)) return { duplicate: true };
    if (this.size >= this.config.maxSessions) throw new Error('RTMS session capacity reached');
    const s = { callId, streamId, createdAt: new Date().toISOString(), sockets: new Map(),
      audioChunks: 0, transcripts: 0, ready: new Set(), stopped: false };
    this.sessions.set(streamId, s);
    this.emit('start', { streamId, callId, createdAt: s.createdAt });
    this.logger.info('rtms.stream_start', { streamId, callId });
    this.openSocket(s, 'signaling', signalingUrl);
    return { duplicate: false };
  }
  openSocket(s, channel, url) {
    if (s.stopped || s.sockets.has(channel)) return;
    if (!secureWsUrl(url)) return this.stop(s.streamId, `invalid ${channel} URL`);
    let socket;
    try { socket = new this.WebSocketImpl(url); }
    catch (error) { this.logger.error('rtms.socket_create_error', { streamId: s.streamId, channel, message: error.message }); this.stop(s.streamId, 'socket creation failed'); return; }
    s.sockets.set(channel, socket);
    socket.on('open', () => {
      const base = { protocol_version: this.config.protocolVersion, sequence: 0,
        call_id: s.callId, rtms_stream_id: s.streamId, signature: this.signature(s) };
      if (channel === 'signaling') send(socket, { msg_type: MSG.SIGNALING_HANDSHAKE_REQ, ...base });
      else send(socket, { msg_type: MSG.DATA_HANDSHAKE_REQ, ...base,
        media_type: MEDIA[channel], ...(channel === 'audio' ? { media_params: { audio: { send_rate: this.config.audioSendRateMs } } } : {}) });
    });
    socket.on('message', data => this.onMessage(s, channel, socket, data));
    socket.on('error', error => {
      this.logger.error('rtms.socket_error', { streamId: s.streamId, channel, message: error.message });
    });
    socket.on('close', code => { if (!s.stopped) this.stop(s.streamId, `${channel} socket closed (${code})`); });
  }
  onMessage(s, channel, socket, data) {
    if (s.stopped) return;
    const message = parseJson(data, this.logger, s.streamId, channel);
    if (!message) return;
    if ([MSG.SIGNALING_HANDSHAKE_RESP, MSG.DATA_HANDSHAKE_RESP, MSG.KEEP_ALIVE_REQ,
      MSG.MEDIA_DATA_AUDIO, MSG.MEDIA_DATA_TRANSCRIPT].includes(message.msg_type)) {
      this.emit('packet', { streamId: s.streamId, callId: s.callId, channel,
        msgType: message.msg_type, receivedAt: new Date().toISOString(), rawBody: data.toString() });
    }
    if (message.msg_type === MSG.KEEP_ALIVE_REQ) {
      send(socket, { msg_type: MSG.KEEP_ALIVE_RESP, timestamp: message.timestamp }); return;
    }
    if (channel === 'signaling') {
      if (message.msg_type === MSG.SIGNALING_HANDSHAKE_RESP) {
        if (message.status_code !== 0) return this.stop(s.streamId, `signaling handshake rejected: ${message.status_code}`);
        const urls = message.media_server?.server_urls || {};
        const requested = [ ...(this.config.enableAudio ? ['audio'] : []), ...(this.config.enableTranscript ? ['transcript'] : []) ];
        this.logger.info('rtms.media_server_urls', {
          streamId: s.streamId, callId: s.callId, serverUrls: urls, requestedMedia: requested
        });
        const selectedUrls = Object.fromEntries(requested.map(type => [type, selectWsUrl(urls[type])]));
        if (requested.some(type => !selectedUrls[type])) return this.stop(s.streamId, 'requested media URL missing or invalid');
        this.logger.info('rtms.media_urls_selected', { streamId: s.streamId, serverUrls: selectedUrls });
        for (const type of requested) this.openSocket(s, type, selectedUrls[type]);
      } else if ([MSG.EVENT_UPDATE, MSG.STREAM_STATE_UPDATE, MSG.SESSION_STATE_UPDATE].includes(message.msg_type)) {
        this.logger.info('rtms.signaling_event', { streamId: s.streamId, msgType: message.msg_type });
        this.emit('signaling', { streamId: s.streamId, callId: s.callId, message });
      }
      return;
    }
    if (message.msg_type === MSG.DATA_HANDSHAKE_RESP) {
      if (message.status_code !== 0) return this.stop(s.streamId, `${channel} handshake rejected: ${message.status_code}`);
      if (s.ready.has(channel)) return;
      s.ready.add(channel);
      this.emit('ready', { streamId: s.streamId, callId: s.callId, channel });
      // Send one readiness ACK after each media handshake, preserving the supplied Phone RTMS example.
      send(s.sockets.get('signaling'), { msg_type: MSG.CLIENT_READY_ACK, rtms_stream_id: s.streamId, media_type: MEDIA[channel] });
      this.logger.info('rtms.media_ready', { streamId: s.streamId, channel });
    } else if (channel === 'audio' && message.msg_type === MSG.MEDIA_DATA_AUDIO) {
      s.audioChunks += 1;
      if (s.audioChunks % 100 === 0) this.logger.info('rtms.audio_progress', { streamId: s.streamId, chunks: s.audioChunks });
      this.emit('audio', { streamId: s.streamId, callId: s.callId, chunkNumber: s.audioChunks, content: message.content });
    } else if (channel === 'transcript' && message.msg_type === MSG.MEDIA_DATA_TRANSCRIPT) {
      s.transcripts += 1;
      if (this.config.logTranscripts) this.logger.info('rtms.transcript', { streamId: s.streamId, content: message.content });
      this.emit('transcript', { streamId: s.streamId, callId: s.callId, content: message.content });
    }
  }
  stop(streamId, reason = 'stopped by Zoom') {
    const s = this.sessions.get(streamId);
    if (!s || s.stopped) return false;
    s.stopped = true;
    this.sessions.delete(streamId);
    for (const socket of s.sockets.values()) {
      try { if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'RTMS session ended'); }
      catch { try { socket.terminate(); } catch {} }
    }
    this.logger.info('rtms.stream_stop', { streamId, callId: s.callId, reason, audioChunks: s.audioChunks, transcripts: s.transcripts });
    this.emit('stop', { streamId, callId: s.callId, reason });
    return true;
  }
  stopAll(reason = 'shutdown') { for (const streamId of [...this.sessions.keys()]) this.stop(streamId, reason); }
}
module.exports = { SessionManager, secureWsUrl };
