const express = require('express');

// Bounded diagnostic history includes sampled audio packets, in memory only.
function createTranscriptHub({ manager, logger, historyLimit = 500, maxViewers = 100 }) {
  const router = express.Router();
  const viewers = new Set();
  const history = [];
  const webhooks = [];
  const rtms = [];
  const lastAudio = new Map();
  let rtmsBytes = 0;
  let webhookBytes = 0;
  let historyBytes = 0;
  let sequence = 0;
  const listeners = [];
  function write(res, type, data) {
    if (res.destroyed || res.writableEnded) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    // A full snapshot can exceed Node's high-water mark even for fast viewers.
    // Allow that bounded write, then drop viewers whose pending queue exceeds 2 MB.
    if (res.writableLength + Buffer.byteLength(frame) > 2 * 1024 * 1024) return res.destroy();
    res.write(frame);
  }
  function publish(type, data) {
    for (const res of viewers) write(res, type, data);
  }
  function listen(name, handler) {
    manager.on(name, handler);
    listeners.push([name, handler]);
  }
  listen('start', event => publish('sessions', manager.stats()));
  listen('ready', event => publish('sessions', manager.stats()));
  listen('stop', event => {
    lastAudio.delete(event.streamId);
    publish('stopped', event);
    publish('sessions', manager.stats());
  });
  const packetNames = { 2: 'Signaling handshake', 4: 'Media handshake', 12: 'Keep-alive', 14: 'Audio', 17: 'Transcript' };
  listen('packet', packet => {
    if (!packetNames[packet.msgType]) return;
    if (packet.msgType === 14) {
      const now = Date.now();
      if (lastAudio.has(packet.streamId) && now - lastAudio.get(packet.streamId) < 1000) return;
      lastAudio.set(packet.streamId, now);
    }
    const entry = { ...packet, id: ++sequence, source: 'rtms',
      event: `${packet.msgType} · ${packetNames[packet.msgType]} · ${packet.channel}`,
      sampled: packet.msgType === 14 };
    rtms.push(entry);
    rtmsBytes += Buffer.byteLength(JSON.stringify(entry));
    while (rtms.length > 200 || rtmsBytes > 512 * 1024) {
      rtmsBytes -= Buffer.byteLength(JSON.stringify(rtms.shift()));
    }
    publish('rtms', entry);
  });
  listen('transcript', ({ streamId, callId, content }) => {
    const value = typeof content === 'string' ? { data: content } : content;
    const text = value?.data ?? value?.text ?? value?.transcript;
    if (typeof text !== 'string' || !text.trim()) return;
    const entry = {
      id: ++sequence, streamId, callId, text: text.slice(0, 16000),
      speaker: String(value.user_name ?? value.speaker_name ?? value.speaker ?? value.user_id ?? 'Speaker').slice(0, 200),
      receivedAt: new Date().toISOString(), timestamp: value.timestamp ?? null,
      isFinal: typeof value.is_final === 'boolean' ? value.is_final : null
    };
    history.push(entry);
    historyBytes += Buffer.byteLength(JSON.stringify(entry));
    while (history.length > historyLimit || historyBytes > 512 * 1024) {
      historyBytes -= Buffer.byteLength(JSON.stringify(history.shift()));
    }
    publish('transcript', entry);
  });
  router.get('/events', (req, res) => {
    if (viewers.size >= maxViewers) return res.status(503).json({ message: 'Viewer capacity reached. Try again shortly.' });
    res.status(200).set({
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    viewers.add(res);
    write(res, 'snapshot', { sessions: manager.stats(), transcripts: history, webhooks, rtms });
    logger.info('transcript.viewer_connected', { viewers: viewers.size });
    req.on('close', () => {
      viewers.delete(res);
      logger.info('transcript.viewer_disconnected', { viewers: viewers.size });
    });
  });
  const heartbeat = setInterval(() => {
    for (const res of viewers) {
      if (res.writableLength > 2 * 1024 * 1024) res.destroy();
      else res.write(': heartbeat\n\n');
    }
  }, 15000);
  heartbeat.unref();
  return { router, recordWebhook(event) {
    const entry = { ...event, id: ++sequence };
    webhooks.push(entry);
    webhookBytes += Buffer.byteLength(JSON.stringify(entry));
    while (webhooks.length > 20 || webhookBytes > 512 * 1024) {
      webhookBytes -= Buffer.byteLength(JSON.stringify(webhooks.shift()));
    }
    publish('webhook', entry);
    logger.info('webhook.shared_with_viewers', { event: event.event, streamId: event.streamId });
  }, close() {
    clearInterval(heartbeat);
    for (const [name, handler] of listeners) manager.off(name, handler);
    for (const res of viewers) res.end();
    viewers.clear();
  } };
}
module.exports = { createTranscriptHub };
