const path = require('node:path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

function integer(name, fallback, min = 0) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${name}`);
  return value;
}
function boolean(name, fallback) {
  const value = process.env[name];
  if (value == null) return fallback;
  if (!['true', 'false'].includes(value.toLowerCase())) throw new Error(`Invalid ${name}`);
  return value.toLowerCase() === 'true';
}
function loadConfig() {
  const config = {
    demoMode: boolean('RTMS_DEMO_MODE', false),
    port: integer('RTMS_PORT', 3002, 1),
    clientId: process.env.RTMS_ZOOM_CLIENT_ID || process.env.ZOOM_APP_CLIENT_ID,
    clientSecret: process.env.RTMS_ZOOM_CLIENT_SECRET || process.env.ZOOM_APP_CLIENT_SECRET,
    webhookSecret: process.env.ZOOM_SECRET_TOKEN,
    protocolVersion: integer('RTMS_PROTOCOL_VERSION', 2, 1),
    audioSendRateMs: integer('RTMS_AUDIO_SEND_RATE_MS', 20, 1),
    enableAudio: boolean('RTMS_ENABLE_AUDIO', true),
    enableTranscript: boolean('RTMS_ENABLE_TRANSCRIPT', true),
    logTranscripts: boolean('RTMS_LOG_TRANSCRIPTS', true),
    webhookMaxAgeSeconds: integer('RTMS_WEBHOOK_MAX_AGE_SECONDS', 300, 1),
    maxSessions: integer('RTMS_MAX_SESSIONS', 100, 1),
    logLevel: process.env.RTMS_LOG_LEVEL || 'info'
  };
  for (const key of ['clientId', 'clientSecret', 'webhookSecret']) {
    if (!config[key] && !config.demoMode) throw new Error(`Missing ${key}; review .env.example`);
  }
  if (!config.enableAudio && !config.enableTranscript) throw new Error('Enable at least one media stream');
  return config;
}
module.exports = { loadConfig };
