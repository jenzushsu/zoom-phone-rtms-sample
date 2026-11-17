# Zoom Phone RTMS

A Node.js proof of concept for receiving Zoom Phone Real-Time Media Streams (RTMS) and displaying live transcripts alongside webhook and WebSocket payloads.

One Express service handles signed Zoom webhooks, manages signaling and media WebSockets, and serves a browser viewer using Server-Sent Events (SSE). No database or frontend build is required.

> **Public demo viewer:** anyone who can access the service can view transcripts, call metadata, complete call start/stop webhook bodies, and sampled inbound audio payloads. There is no viewer authentication. Use calls intended for your demo audience, or add access controls before sharing the service.

## Try the demo

Requires **Node.js 20+** and npm. From the project directory:

```bash
npm install
npm run demo
```

Open [http://localhost:3002](http://localhost:3002) and click **Play demo**. No Zoom credentials are needed. Sample conversation text stays in your browser and is not broadcast to other viewers.

Demo mode disables incoming Zoom webhooks. Stop the demo process before starting live mode on the same port.

## Connect live Zoom Phone calls

You will need a Zoom app configured for Zoom Phone RTMS, RTMS enabled for the target calls, and your app's Client ID, Client Secret, and Webhook Secret Token.

> **Zoom web portal setup:** the steps below cover this service and its webhook configuration only. Additional setup in the Zoom web portal is required to enable Zoom Phone RTMS for your account and users. That portal setup is not covered here, and the relevant Zoom documentation is not yet available. Refer to Zoom's official documentation for the portal setup steps once it is published.

### 1. Configure and start the service

```bash
npm install
cp .env.example .env
```

Edit `.env` and set:

- `RTMS_ZOOM_CLIENT_ID`: Zoom app Client ID
- `RTMS_ZOOM_CLIENT_SECRET`: Zoom app Client Secret
- `ZOOM_SECRET_TOKEN`: Zoom webhook verification secret
- `RTMS_DEMO_MODE=false`

Keep `.env` private; it is excluded by `.gitignore`. For demos that should not log transcript text, also set `RTMS_LOG_TRANSCRIPTS=false`.

```bash
npm start
```

For automatic restarts during development, use `npm run dev`.

### 2. Expose the webhook endpoint

With [ngrok](https://ngrok.com/) installed and configured, run this in another terminal:

```bash
ngrok http 3002
```

In your Zoom app, configure the event notification endpoint as `https://<your-ngrok-host>/api/webhooks/zoom` and subscribe to:

- `phone.call_rtms_started`
- `phone.call_rtms_stopped`

The `/webhook` path is an alias. This implementation requires valid Zoom signatures for endpoint validation requests as well as call events.

### 3. Verify and view a call

```bash
curl http://localhost:3002/healthz
curl http://localhost:3002/api/status
```

Open [http://localhost:3002](http://localhost:3002), then start an RTMS-enabled Zoom Phone call. The ngrok HTTPS URL also serves the viewer for remote demo participants.

## Viewer features

- Live transcripts with speaker labels, receipt times, a call selector, auto-scroll, and text download.
- A chronological payload inspector for call start/stop webhooks and RTMS messages `2`, `4`, `12`, `14`, and `17`.
- **Exact body** to view the original received JSON; **Follow latest** to resume following new events after inspecting an earlier payload.
- Automatic SSE reconnection and replay of recent server history. Ended calls remain selectable while their transcripts are retained.

Audio diagnostics sample at most one packet per second per stream. Each sampled packet includes its full received JSON, including audio data. Transcript segments are displayed as received; explicit `is_final: false` values are marked interim, and revisions are not merged.

The call selector filters the display only. It does not restrict access to other calls. Credentials, outbound authentication signatures, request headers, and endpoint validation tokens are excluded from the viewer, but received payloads can contain metadata and signaling URLs. A displayed webhook confirms receipt, not a successful RTMS connection.

## How it works

1. A signed `phone.call_rtms_started` webhook supplies the call ID, stream ID, and signaling URL.
2. The service verifies the signature against the raw request body and checks timestamp freshness.
3. A signaling WebSocket performs the RTMS handshake and receives media server URLs.
4. Separate WebSockets connect for each enabled media type: audio (`1`) and transcript (`8`).
5. After each successful media handshake, the service sends a readiness acknowledgment over signaling.
6. Incoming transcripts and diagnostic payloads are pushed to browser viewers over SSE.
7. A stop webhook or any session socket closure releases all sockets for that stream.

To connect downstream processing, register listeners on `manager` in `src/server.js` before the HTTP server starts. `SessionManager` emits `transcript` and `audio` events with `{ callId, streamId, content }`, and `signaling` events with `{ callId, streamId, message }`. Check the negotiated audio codec, sample rate, and channels before decoding or forwarding audio.

## Configuration

Copy [.env.example](.env.example) for the complete configuration template. Credentials are required in live mode only. At least one media type must be enabled.

| Variable                       | Default               | Description                                           |
| ------------------------------ | --------------------- | ----------------------------------------------------- |
| `RTMS_PORT`                    | `3002`                | HTTP listener port                                    |
| `RTMS_DEMO_MODE`               | `false`               | Run without credentials and disable Zoom webhooks     |
| `RTMS_ZOOM_CLIENT_ID`          | Required in live mode | Client ID; falls back to `ZOOM_APP_CLIENT_ID`         |
| `RTMS_ZOOM_CLIENT_SECRET`      | Required in live mode | Client secret; falls back to `ZOOM_APP_CLIENT_SECRET` |
| `ZOOM_SECRET_TOKEN`            | Required in live mode | Webhook verification secret                           |
| `RTMS_PROTOCOL_VERSION`        | `2`                   | RTMS protocol version sent in handshakes              |
| `RTMS_AUDIO_SEND_RATE_MS`      | `20`                  | Requested audio send rate in milliseconds             |
| `RTMS_ENABLE_AUDIO`            | `true`                | Connect the audio media WebSocket                     |
| `RTMS_ENABLE_TRANSCRIPT`       | `true`                | Connect the transcript media WebSocket                |
| `RTMS_LOG_TRANSCRIPTS`         | `true`                | Include transcript content in process logs            |
| `RTMS_WEBHOOK_MAX_AGE_SECONDS` | `300`                 | Allowed webhook timestamp skew in either direction    |
| `RTMS_MAX_SESSIONS`            | `100`                 | Maximum concurrent RTMS sessions per process          |
| `RTMS_LOG_LEVEL`               | `info`                | `debug`, `info`, `warn`, or `error`                   |

## Endpoints

| Method | Path                      | Purpose                                        |
| ------ | ------------------------- | ---------------------------------------------- |
| `GET`  | `/`                       | Public transcript and payload viewer           |
| `GET`  | `/api/transcripts/events` | Public SSE feed with recent history            |
| `POST` | `/api/webhooks/zoom`      | Signed Zoom webhook receiver; alias `/webhook` |
| `GET`  | `/healthz`                | Process health response                        |
| `GET`  | `/api/status`             | Service status and active stream count         |

When using a reverse proxy, disable response buffering for the SSE endpoint and allow long-lived streaming responses.

## Data retention and limitations

The service keeps rolling history in process memory:

| Data                     | Retention limit                                                       |
| ------------------------ | --------------------------------------------------------------------- |
| Transcripts              | 500 segments or 512 KiB; text capped at 16,000 characters per segment |
| Call start/stop webhooks | 20 events or 512 KiB                                                  |
| RTMS diagnostic messages | 200 messages or 512 KiB, including sampled audio                      |

Each buffer evicts its oldest entries when either limit is exceeded. A restart clears all history and ends active streams. The application does not write audio or transcripts to files; browser downloads and hosting-provider logs have separate retention. Transcript logging is enabled by default.

This is a single-process PoC with these operational limits:

- Up to 100 concurrent viewer connections. Slow viewers with excessive queued data are disconnected and can reconnect automatically.
- No automatic RTMS session recovery. Any session socket closure ends that session.
- Duplicate start events are ignored only while the stream is active. Webhook delivery IDs are not persisted for replay deduplication.
- Multiple replicas require stream ownership, webhook routing, and shared-state design.
- WebSocket URLs must use `wss:`, but hostnames are not allowlisted. Signed webhook verification is the initial trust boundary.
- The implementation sends protocol version `2` by default and one readiness acknowledgment per media type, including `media_type`. Confirm these settings against your Zoom Phone RTMS integration before a live demo.

## Development

```bash
npm test
npm run check
```

Tests use Node.js's built-in test runner. `npm run check` checks the server entry point's JavaScript syntax.

```text
src/
  server.js                 Service startup and graceful shutdown
  app.js                    HTTP routes and raw webhook body capture
  config/index.js           Environment configuration validation
  lib/                      Signature verification and structured logging
  rtms/                     Protocol constants and WebSocket session lifecycle
  webhooks/router.js        Signed Zoom event handling
  transcripts/hub.js        Bounded history and SSE broadcasting
public/                     Browser viewer, sample conversation, and text export
test/                       Security, session, and transcript tests
```

## References

- [Zoom RTMS data types](https://developers.zoom.us/docs/rtms/data-types/)
- [Zoom RTMS universal events](https://developers.zoom.us/docs/rtms/event-reference/universal-events/)
- [Zoom Meetings RTMS WebSocket quickstart](https://developers.zoom.us/docs/rtms/meetings/quickstart-websockets/) — background reference for the WebSocket flow; this project handles Zoom Phone events.
