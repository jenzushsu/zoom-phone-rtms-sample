'use strict';
const $ = id => document.getElementById(id);
let sessions = [], entries = [], demoEntries = [], demoMode = false, demoTimer;
let webhooks = [], demoWebhooks = [];
let rtmsPackets = [];
let payloadRenderTimer;
let selectedWebhookId = null;
let connectionText = 'Connecting…', connected = false;
const demoScript = [
  ['Alex', 'Hi Jamie, thanks for joining. Can you hear me clearly?'],
  ['Jamie', 'Loud and clear. I’m calling from my Zoom Phone.'],
  ['Alex', 'Great. The transcript is appearing as we speak, so everyone can follow the conversation.'],
  ['Jamie', 'That’s useful for our support team. Can someone join the page halfway through a call?'],
  ['Alex', 'Yes. They’ll see the recent conversation and new transcript segments as they arrive.'],
  ['Jamie', 'Perfect. Let’s try it with our next customer demo.']
];
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function sourceEntries() { return demoMode ? demoEntries : entries; }
function visibleEntries() { return sourceEntries().filter(entry => !$('call').value || entry.streamId === $('call').value); }
function sourceWebhooks() { return demoMode ? demoWebhooks : [...webhooks, ...rtmsPackets].sort((a, b) => a.id - b.id); }
function renderPayloads() {
  const matching = sourceWebhooks().filter(event => !$('call').value || event.streamId === $('call').value);
  if (!matching.some(event => String(event.id) === selectedWebhookId)) selectedWebhookId = null;
  const selected = matching.find(event => String(event.id) === selectedWebhookId) || matching.at(-1);
  const list = $('event-list');
  const previousScroll = list.scrollTop;
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.eventId : null;
  list.replaceChildren();
  for (const event of matching) {
    const item = node('li');
    const button = node('button', 'event-button');
    button.type = 'button';
    button.dataset.eventId = String(event.id);
    button.setAttribute('aria-pressed', String(event.id === selected?.id));
    button.setAttribute('aria-controls', 'payload');
    const time = node('time', 'event-time', new Date(event.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    time.dateTime = event.receivedAt;
    const details = node('span', 'event-details');
    details.append(node('span', 'event-name', event.event), node('span', 'event-stream', event.streamId || 'Unknown stream'));
    button.append(time, details);
    item.append(button);
    list.append(item);
    if (focusedId === String(event.id)) button.focus({ preventScroll: true });
  }
  list.scrollTop = selectedWebhookId === null ? list.scrollHeight : previousScroll;
  $('latest-event').setAttribute('aria-pressed', String(selectedWebhookId === null));
  $('event-count').textContent = `${matching.length} ${matching.length === 1 ? 'event' : 'events'}`;
  $('event-empty').hidden = matching.length > 0;
  if (!selected) {
    $('payload-meta').textContent = 'Waiting for a call webhook or RTMS message.';
    $('payload').textContent = 'Click a received event to inspect its payload.';
    return;
  }
  const source = demoMode ? 'Sample event' : selected.source === 'rtms' ? 'Received over RTMS WebSocket' : 'Webhook signature verified';
  $('payload-meta').textContent = `${source} · ${new Date(selected.receivedAt).toLocaleString()} · ${selected.event}${selected.sampled ? ' · Audio sampled: at most one packet per second per stream' : ''}`;
  $('payload').textContent = $('exact-body').checked ? selected.rawBody : JSON.stringify(JSON.parse(selected.rawBody), null, 2);
}
function updateConnection() {
  $('connection').textContent = demoMode ? 'Demo preview' : connectionText;
  $('connection').classList.toggle('live', connected && !demoMode);
}
function updateCalls() {
  const current = $('call').value;
  const calls = new Map();
  for (const entry of sourceEntries()) calls.set(entry.streamId, { streamId: entry.streamId, callId: entry.callId });
  for (const event of sourceWebhooks()) {
    if (event.streamId && !calls.has(event.streamId)) calls.set(event.streamId, { streamId: event.streamId, callId: event.callId || event.streamId });
  }
  for (const session of demoMode ? [] : sessions) calls.set(session.streamId, session);
  $('call').replaceChildren(new Option('All calls', ''));
  for (const call of calls.values()) {
    const active = !demoMode && sessions.some(session => session.streamId === call.streamId);
    const label = `${active ? 'Live' : demoMode ? 'Demo' : 'Ended'} · ${call.callId} · ${call.streamId}`;
    $('call').add(new Option(label, call.streamId));
  }
  if (calls.has(current)) $('call').value = current;
  $('summary').textContent = demoMode ? 'Sample conversation · Preview only' : `${sessions.length} active ${sessions.length === 1 ? 'call' : 'calls'}`;
}
function appendEntry(entry) {
  const item = node('article');
  const meta = node('div', 'meta');
  const time = node('time', 'time', new Date(entry.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  time.dateTime = entry.receivedAt;
  meta.append(node('span', 'speaker', entry.speaker), time);
  if (!$('call').value) meta.append(node('span', 'call-label', `Call ${entry.callId}`));
  if (entry.isFinal === false) meta.append(node('span', 'time', 'Interim'));
  item.append(meta, node('p', '', entry.text));
  $('transcript').append(item);
}
function updateCount() {
  const count = visibleEntries().length;
  $('count').textContent = `${count} transcript ${count === 1 ? 'segment' : 'segments'}`;
  $('empty').hidden = count > 0;
  $('download').disabled = count === 0;
  if ($('follow').checked) $('transcript').scrollTop = $('transcript').scrollHeight;
}
function render() {
  $('transcript').replaceChildren();
  visibleEntries().forEach(appendEntry);
  updateCount();
  renderPayloads();
}
const events = new EventSource('/api/transcripts/events');
events.onopen = () => { connected = true; connectionText = 'Connected'; updateConnection(); };
events.onerror = () => { connected = false; connectionText = 'Connection lost · Retrying…'; updateConnection(); };
events.addEventListener('snapshot', event => {
  const data = JSON.parse(event.data);
  sessions = data.sessions;
  entries = data.transcripts;
  webhooks = data.webhooks || [];
  rtmsPackets = data.rtms || [];
  if (!demoMode) { updateCalls(); render(); }
});
events.addEventListener('sessions', event => {
  sessions = JSON.parse(event.data);
  if (!demoMode) {
    const selected = $('call').value;
    updateCalls();
    if (selected !== $('call').value) render();
  }
});
events.addEventListener('webhook', event => {
  const entry = JSON.parse(event.data);
  if (webhooks.some(existing => existing.id === entry.id)) return;
  webhooks.push(entry);
  if (webhooks.length > 20) webhooks.shift();
  if (!demoMode) { updateCalls(); renderPayloads(); }
});
events.addEventListener('rtms', event => {
  const entry = JSON.parse(event.data);
  if (rtmsPackets.some(existing => existing.id === entry.id)) return;
  rtmsPackets.push(entry);
  if (rtmsPackets.length > 200) rtmsPackets.shift();
  if (!demoMode && !payloadRenderTimer) {
    payloadRenderTimer = setTimeout(() => {
      payloadRenderTimer = null;
      if (!demoMode) { updateCalls(); renderPayloads(); }
    }, 100);
  }
});
events.addEventListener('transcript', event => {
  const entry = JSON.parse(event.data);
  if (entries.some(existing => existing.id === entry.id)) return;
  entries.push(entry);
  const trimmed = entries.length > 500;
  if (trimmed) entries.shift();
  if (!demoMode) {
    updateCalls();
    if (trimmed) render();
    else {
      if (!$('call').value || entry.streamId === $('call').value) appendEntry(entry);
      updateCount();
    }
  }
});
$('call').addEventListener('change', () => { selectedWebhookId = null; render(); });
$('event-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-event-id]');
  if (!button) return;
  selectedWebhookId = button.dataset.eventId;
  renderPayloads();
});
$('latest-event').addEventListener('click', () => { selectedWebhookId = null; renderPayloads(); });
$('exact-body').addEventListener('change', renderPayloads);
$('follow').addEventListener('change', updateCount);
$('demo').addEventListener('click', () => {
  clearInterval(demoTimer);
  demoMode = true; demoEntries = []; selectedWebhookId = null;
  demoWebhooks = [{ id: 'demo-start', event: 'phone.call_rtms_started', callId: 'Demo call', streamId: 'demo', receivedAt: new Date().toISOString(), rawBody: JSON.stringify({ event: 'phone.call_rtms_started', payload: { call_id: 'Demo call', rtms_stream_id: 'demo', server_urls: 'wss://signaling.example.invalid' } }) }];
  $('demo-banner').hidden = false;
  $('call').value = '';
  updateConnection(); updateCalls(); render();
  function nextLine() {
    const line = demoScript[demoEntries.length];
    if (!line) { clearInterval(demoTimer); return; }
    const entry = { id: demoEntries.length + 1, streamId: 'demo', callId: 'Demo call', speaker: line[0], text: line[1], receivedAt: new Date().toISOString() };
    demoEntries.push(entry);
    updateCalls(); appendEntry(entry); updateCount();
    if (demoEntries.length === demoScript.length) {
      const receivedAt = new Date().toISOString();
      demoWebhooks.push({ id: 'demo-stop', event: 'phone.call_rtms_stopped', callId: 'Demo call', streamId: 'demo', receivedAt,
        rawBody: JSON.stringify({ event: 'phone.call_rtms_stopped', payload: { call_id: 'Demo call', rtms_stream_id: 'demo' } }) });
      renderPayloads();
      clearInterval(demoTimer);
    }
  }
  nextLine(); demoTimer = setInterval(nextLine, 2200);
});
$('exit-demo').addEventListener('click', () => {
  clearInterval(demoTimer); demoMode = false; selectedWebhookId = null;
  $('demo-banner').hidden = true;
  updateConnection(); updateCalls(); render();
});
$('download').addEventListener('click', () => {
  const text = visibleEntries().map(entry => `[${entry.receivedAt}] ${entry.speaker} (call ${entry.callId}): ${entry.text}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = node('a'); link.href = url; link.download = demoMode ? 'demo-transcript.txt' : 'live-transcript.txt';
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => { events.close(); clearInterval(demoTimer); clearTimeout(payloadRenderTimer); });
