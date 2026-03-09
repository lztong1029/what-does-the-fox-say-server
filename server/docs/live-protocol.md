# What Does the Fox Say — API Protocol

## Base URL

- **Local dev** : `http://localhost:8080`
- **Railway**   : `https://<your-app>.railway.app`
- **iPhone (real device, local dev)**: use your Mac's LAN IP, e.g. `http://192.168.1.x:8080`

> `localhost` only works in the iOS Simulator. On a real device use the LAN IP or Railway URL.

---

## REST Endpoints (all under `/v1`)

### Health

```
GET /health
GET /v1/health
→ 200 "ok"
```

---

### Auth

#### POST /v1/auth/anonymous

Create or reuse an anonymous user by device ID. Returns a signed JWT.

**Request body**
```json
{
  "device_id":    "550e8400-e29b-41d4-a716-446655440000",
  "device_model": "iPhone 16 Pro",
  "os":           "iOS 18.3",
  "language":     "zh-Hans",
  "timezone":     "America/Chicago"
}
```

**Response**
```json
{
  "token":     "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "userId":    "550e8400-...",
  "deviceId":  "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 86400
}
```

---

### Devices

#### POST /v1/devices

Idempotent device registration / metadata update. Requires `Authorization: Bearer <token>`.

**Request body**
```json
{
  "device_id":    "550e8400-...",
  "device_model": "iPhone 16 Pro",
  "os":           "iOS 18.3",
  "language":     "zh-Hans",
  "timezone":     "America/Chicago"
}
```

**Response** `201`
```json
{ "deviceId": "550e8400-..." }
```

---

### Profile

All profile endpoints require `Authorization: Bearer <token>`.

#### GET /v1/profile

```json
{
  "nativeLanguage": "Chinese",
  "targetLanguage": "English",
  "persona":        "a friendly barista"
}
```

#### PATCH /v1/profile

**Request body** (any subset of fields)
```json
{
  "nativeLanguage": "Chinese",
  "targetLanguage": "Japanese",
  "persona":        "a Tokyo tour guide"
}
```

**Response** — updated profile object.

---

### Practice Sessions

All session endpoints require `Authorization: Bearer <token>`.

#### POST /v1/practice-sessions — create session

**Request body**
```json
{
  "nativeLanguage": "Chinese",
  "targetLanguage": "English",
  "persona":        "a friendly barista",
  "deviceId":       "550e8400-..."
}
```

**Response** `201`
```json
{ "sessionId": "abc123...", "status": "active" }
```

`persona` is optional — falls back to the user's profile persona.

#### PATCH /v1/practice-sessions/:id/finalize — end session

Called by the client after the realtime WS closes. Submits the final transcript and triggers async analysis.

**Request body**
```json
{
  "transcriptFullJson": [
    { "seq": 1, "speaker": "user",      "text": "Hello!" },
    { "seq": 2, "speaker": "assistant", "text": "Hi there!" }
  ],
  "durationSec": 42,
  "audioUrl":    "https://..."
}
```

All fields are optional — if `transcriptFullJson` is omitted the server uses the segments it saved in real-time; if `durationSec` is omitted the server computes it from timestamps.

**Response**
```json
{ "sessionId": "abc123...", "status": "processing" }
```

If the session is already past `active`, returns current status without re-triggering analysis.

#### GET /v1/practice-sessions?cursor=&limit= — history list

```
GET /v1/practice-sessions?cursor=<sessionId>&limit=20
```

**Response**
```json
{
  "items": [
    {
      "sessionId":        "abc123...",
      "nativeLanguage":   "Chinese",
      "targetLanguage":   "English",
      "persona":          "a friendly barista",
      "status":           "ready",
      "topicTitle":       "Ordering Coffee",
      "transcriptPreview": "user: Hello! assistant: Hi there!...",
      "startedAt":        "2026-03-08T10:00:00Z",
      "endedAt":          "2026-03-08T10:00:42Z",
      "durationSec":      42,
      "updatedAt":        "2026-03-08T10:01:05Z",
      "isUnread":         true
    }
  ],
  "nextCursor": "xyz789..."
}
```

`isUnread` is `true` when `lastReadVersion < resultVersion`.
`nextCursor` is `null` when there are no more pages.

#### GET /v1/practice-sessions/:id — session detail

**Response**
```json
{
  "sessionId":          "abc123...",
  "nativeLanguage":     "Chinese",
  "targetLanguage":     "English",
  "persona":            "a friendly barista",
  "status":             "ready",
  "failureReason":      null,
  "topicTitle":         "Ordering Coffee",
  "transcriptPreview":  "user: Hello!...",
  "transcriptFullJson": [...],
  "feedbackJson": {
    "topic_title":         "Ordering Coffee",
    "summary":             "The learner practiced ordering a latte.",
    "feedback_overall":    "Great effort! Your vocabulary was strong.",
    "pronunciation_notes": ["Watch the 'th' sound in 'the'"],
    "grammar_notes":       ["Use 'could I have' instead of 'can I have' for politeness"],
    "vocabulary_notes":    ["'venti' is a Starbucks-specific size"],
    "fluency_notes":       ["Good pace overall"],
    "next_reply_prompt":   "Tell me about your favourite café.",
    "transcript_preview":  "user: Hello! assistant: Hi there!..."
  },
  "startedAt":          "2026-03-08T10:00:00Z",
  "endedAt":            "2026-03-08T10:00:42Z",
  "durationSec":        42,
  "audioUrl":           null,
  "modelAudioUrl":      null,
  "resultVersion":      1,
  "lastReadVersion":    0,
  "updatedAt":          "2026-03-08T10:01:05Z"
}
```

#### POST /v1/practice-sessions/:id/read — mark as read

**Request body**
```json
{ "version": 1 }
```

Sets `lastReadVersion` to the given version, clearing the unread indicator.

**Response** `{ "ok": true }`

---

### History

#### GET /v1/history/sync-status

Lightweight poll endpoint for the home screen badge.

**Response**
```json
{
  "hasUnread":        true,
  "unreadCount":      2,
  "processingCount":  1,
  "latestUpdatedAt":  "2026-03-08T10:01:05Z"
}
```

Poll every 15 s when the history WS is not available.

---

## WebSocket Endpoints

### Realtime Voice Gateway

```
WS  /v1/realtime/ws?sessionId=<uuid>&token=<jwt>
```

- JWT is passed as a **query parameter** (headers are not supported on WS connections).
- Session must be `status = "active"` and owned by the authenticated user.
- The server reads the session's `nativeLanguage`, `targetLanguage`, and `persona` to build the Gemini system prompt automatically.

**On connection failure:** server closes with code **1008** and a reason string.

**Rate limits**
| Limit | Value |
|-------|-------|
| WS connections per user per minute | 5 |
| Maximum session duration | 5 minutes |
| Audio frames per second per connection | 20 |

#### Full Flow

```
1. POST /v1/auth/anonymous             →  token + userId + deviceId
2. PATCH /v1/profile                   →  set nativeLanguage, targetLanguage, persona
3. POST /v1/practice-sessions          →  sessionId
4. WS /v1/realtime/ws?sessionId=...&token=...
5. ← server: {"type":"state","value":"idle"}
6. → client: {"type":"control","op":"start"}
7. ← server: {"type":"state","value":"listening"}
8. → client: {"type":"audio","pcmBase64":"...","sampleRate":16000,"channels":1}
   (repeat for each audio chunk)
9. ← server: {"type":"partial_transcript","speaker":"user","text":"Hello..."}
10. ← server: {"type":"final_transcript","speaker":"user","text":"Hello!"}
11. ← server: {"type":"state","value":"thinking"}
12. ← server: {"type":"state","value":"speaking"}
13. ← server: {"type":"audio_reply","pcmBase64":"...","sampleRate":24000,"channels":1}
14. ← server: {"type":"final_transcript","speaker":"assistant","text":"Hi there!"}
15. ← server: {"type":"state","value":"idle"}
16. → client: {"type":"control","op":"end"}
17. WS closed 1000 "ended"
18. PATCH /v1/practice-sessions/:id/finalize  →  status: "processing"
19. ← history WS: {"type":"session_updated","sessionId":"..."}
    (or poll GET /v1/history/sync-status every 15 s as fallback)
20. GET /v1/practice-sessions/:id      →  status: "ready", feedbackJson: {...}
21. POST /v1/practice-sessions/:id/read  →  { "version": 1 }
```

#### Client → Server Messages

##### control

```json
{ "type": "control", "op": "start" }
{ "type": "control", "op": "mute" }
{ "type": "control", "op": "unmute" }
{ "type": "control", "op": "end" }
```

- `start` — opens the Gemini Live upstream connection.
- `mute` / `unmute` — toggle microphone; frames sent while muted are dropped.
- `end` — close session cleanly; WS closes 1000. Client must then call `/finalize`.

##### audio

```json
{
  "type":       "audio",
  "pcmBase64":  "<base64 encoded PCM16 mono>",
  "sampleRate": 16000,
  "channels":   1
}
```

Send raw PCM16 mono at 16 kHz. Do not send before `control:start`.

#### Server → Client Messages

##### state

```json
{ "type": "state", "value": "idle" }
{ "type": "state", "value": "listening" }
{ "type": "state", "value": "thinking" }
{ "type": "state", "value": "speaking" }
```

##### partial_transcript

Forwarded live from Gemini; **not** written to the database.

```json
{ "type": "partial_transcript", "speaker": "user",      "text": "Hel..." }
{ "type": "partial_transcript", "speaker": "assistant",  "text": "Hi th..." }
```

##### final_transcript

Written to `TranscriptSegment` (final only).

```json
{ "type": "final_transcript", "speaker": "user",      "text": "Hello!" }
{ "type": "final_transcript", "speaker": "assistant",  "text": "Hi there!" }
```

##### audio_reply

PCM16 audio from Gemini at 24 kHz mono.

```json
{
  "type":       "audio_reply",
  "pcmBase64":  "<base64 PCM16>",
  "sampleRate": 24000,
  "channels":   1
}
```

##### error

```json
{ "type": "error", "message": "Unknown message type: foo" }
```

Non-fatal errors keep the connection open; fatal errors are followed by a WS close.

---

### History Push Gateway

```
WS  /v1/history/ws?token=<jwt>
```

Server-push only — the client does not send messages. When an analysis job completes and a session transitions `processing → ready`, the server pushes:

```json
{ "type": "session_updated", "sessionId": "abc123..." }
```

The client should then refresh the relevant session row. If the WS is unavailable, fall back to polling `GET /v1/history/sync-status` every 15 s.

---

## Session Status Lifecycle

```
active  ──(PATCH /finalize)──►  processing  ──(analysis done)──►  ready
                                             ──(analysis error)──► failed
```

| Status | Meaning |
|--------|---------|
| `active` | Realtime session in progress |
| `processing` | Finalized; analysis job running |
| `ready` | Analysis complete; `feedbackJson` available |
| `failed` | Analysis or realtime error; `failureReason` set |

---

## Transcript Storage

| Kind | Forwarded to client | Written to DB (segments) | Stored in session JSON |
|------|---------------------|--------------------------|------------------------|
| Partial | ✅ Yes | ❌ No | ❌ No |
| Final (realtime) | ✅ Yes | ✅ Yes | — |
| Final (finalize body) | — | — | ✅ Yes (`transcriptFullJson`) |

The analysis job uses whichever is available: realtime segments take priority, then `transcriptFullJson`.

---

## Audio Codec Reference

| Direction        | Codec       | Sample rate | Channels |
|------------------|-------------|-------------|----------|
| Client → Server  | PCM16 (raw) | 16 000 Hz   | Mono     |
| Server → Client  | PCM16 (raw) | 24 000 Hz   | Mono     |

Both sides carry audio as raw base-64 encoded PCM16LE bytes — no container, no header.

---

## Railway Deployment

### 1. Create project

```bash
railway init
railway add --database postgres
```

### 2. Set environment variables

```
PORT              = 8080           (Railway sets automatically)
DATABASE_URL      = <Railway Postgres — set automatically>
JWT_SECRET        = <long random string>
GEMINI_API_KEY    = <Google AI Studio key>
GEMINI_LIVE_MODEL = gemini-2.0-flash-live-001
FEEDBACK_MODEL    = gemini-1.5-flash
LOG_LEVEL         = info
```

### 3. Deploy

```bash
# Build (Prisma codegen + TS compile)
npm run build

# Migrate + start
npm run migrate:deploy && npm run start
```

### 4. First-time DB setup (local dev)

```bash
npx prisma migrate dev --name init
```

### 5. Health check

Set Railway health check path to `/health`.
