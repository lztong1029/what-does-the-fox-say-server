import { WebSocket, type WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { verifyWsToken } from '../auth/wsAuth.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { safeParseJson } from '../utils/safeJson.js';
import {
  checkWsConnRate,
  checkAudioRate,
  cleanupAudioRate,
} from '../rateLimit/limiter.js';
import {
  isControlMessage,
  isAudioMessage,
  type ServerMessage,
} from './protocol.js';
import { GeminiLiveSession } from './upstream/geminiLive.js';
import { saveFinalSegment, clearSeqCounter } from '../services/transcriptService.js';
import { markSessionError } from '../services/sessionService.js';

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function setupLiveGateway(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Fire async handler; errors are caught inside
    void handleConnection(ws, req);
  });
}

async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const token     = url.searchParams.get('token');
  const sessionId = url.searchParams.get('sessionId');
  const connId    = randomUUID();

  // ── Auth ────────────────────────────────────────────────────────────────
  if (!token) {
    ws.close(1008, 'Missing token');
    return;
  }
  const payload = verifyWsToken(token);
  if (!payload) {
    ws.close(1008, 'Invalid token');
    return;
  }
  const { userId } = payload;

  // ── Session validation ──────────────────────────────────────────────────
  if (!sessionId) {
    ws.close(1008, 'Missing sessionId');
    return;
  }

  let dbSession;
  let userProfile;
  try {
    [dbSession, userProfile] = await Promise.all([
      prisma.practiceSession.findUnique({ where: { id: sessionId } }),
      prisma.userProfile.findUnique({ where: { userId } }),
    ]);
  } catch (e) {
    logger.error('DB error on WS connect', { error: (e as Error).message });
    ws.close(1008, 'DB error');
    return;
  }

  if (!dbSession || dbSession.userId !== userId) {
    ws.close(1008, 'Session not found or not owned');
    return;
  }
  if (dbSession.status !== 'active') {
    ws.close(1008, 'Session is not active');
    return;
  }

  // Build system prompt from session + profile
  const nativeLang   = dbSession.nativeLanguage;
  const targetLang   = dbSession.targetLanguage;
  const persona      = dbSession.persona ?? userProfile?.persona ?? 'a friendly language tutor';
  const systemPrompt =
    `You are ${persona}. You are helping a ${nativeLang} speaker practice ${targetLang}. ` +
    `Speak only in ${targetLang}. Be encouraging, natural, and conversational. ` +
    `Gently correct mistakes inline without breaking the flow of conversation.`;

  // ── Rate limit: WS connections per user per minute ──────────────────────
  if (!checkWsConnRate(userId, config.maxWsConnPerUserPerMin)) {
    ws.close(1008, 'Too many connections');
    return;
  }

  logger.info('WS connected', { sessionId, userId, connId });

  // ── Per-connection state ────────────────────────────────────────────────
  let muted = false;
  let started = false;
  let speakingStarted = false;
  let userSpoke = false;
  let gemini: GeminiLiveSession | null = null;
  let sessionTimer: NodeJS.Timeout | null = null;

  function cleanup(): void {
    if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
    cleanupAudioRate(connId);
    clearSeqCounter(sessionId!);
    gemini?.close();
    gemini = null;
  }

  function doEndSession(): void {
    // Just clean up the realtime resources.
    // The client is responsible for calling PATCH /practice-sessions/:id/finalize,
    // which sets status → processing and enqueues the analysis job.
    cleanup();
  }

  // ── Initial state ───────────────────────────────────────────────────────
  send(ws, { type: 'state', value: 'idle' });

  // ── Message handler ─────────────────────────────────────────────────────
  ws.on('message', (raw: Buffer | string) => {
    void handleMessage(raw);
  });

  async function handleMessage(raw: Buffer | string): Promise<void> {
    const result = safeParseJson(
      typeof raw === 'string' ? raw : raw.toString('utf8'),
    );
    if (!result.ok) {
      send(ws, { type: 'error', message: `Invalid JSON: ${result.error}` });
      return;
    }

    const msg = result.value;

    if (isControlMessage(msg)) {
      switch (msg.op) {

        case 'start': {
          if (started) return;
          started = true;
          muted = false;
          speakingStarted = false;
          userSpoke = false;
          send(ws, { type: 'state', value: 'listening' });

          // Session timeout
          sessionTimer = setTimeout(() => {
            logger.info('Session timeout', { sessionId });
            send(ws, { type: 'error', message: 'Session timeout (5 min)' });
            ws.close(1000, 'timeout');
          }, config.maxSessionDurationMs);

          // Connect Gemini Live with injected system prompt
          gemini = new GeminiLiveSession({
            onPartialTranscript(speaker, text) {
              send(ws, { type: 'partial_transcript', speaker, text });
            },

            onFinalTranscript(speaker, text) {
              send(ws, { type: 'final_transcript', speaker, text });
              void saveFinalSegment(sessionId!, speaker, text);
              if (speaker === 'user') {
                userSpoke = true;
                speakingStarted = false;
                send(ws, { type: 'state', value: 'thinking' });
              }
            },

            onAudioOutput(pcmBase64, sampleRate, channels) {
              if (!speakingStarted && userSpoke) {
                speakingStarted = true;
                send(ws, { type: 'state', value: 'speaking' });
              }
              send(ws, { type: 'audio_reply', pcmBase64, sampleRate, channels });
            },

            onSpeakingStarted() {
              if (!speakingStarted) {
                speakingStarted = true;
                send(ws, { type: 'state', value: 'speaking' });
              }
            },

            onTurnComplete() {
              speakingStarted = false;
              userSpoke = false;
              send(ws, { type: 'state', value: 'idle' });
            },

            onError(message) {
              logger.error('Gemini upstream error', { sessionId, message });
              send(ws, { type: 'error', message });
              void markSessionError(sessionId!);
              ws.close(1011, 'Upstream error');
            },

            onClose() {
              if (ws.readyState === WebSocket.OPEN) {
                send(ws, { type: 'state', value: 'idle' });
              }
            },
          }, systemPrompt);

          try {
            await gemini.connect();
          } catch (e) {
            const err = (e as Error).message;
            logger.error('Failed to connect Gemini Live', { sessionId, error: err });
            send(ws, { type: 'error', message: 'Failed to connect upstream' });
            ws.close(1011, 'Upstream connection failed');
          }
          break;
        }

        case 'mute': {
          muted = true;
          break;
        }

        case 'unmute': {
          muted = false;
          break;
        }

        case 'end': {
          doEndSession();
          ws.close(1000, 'ended');
          break;
        }
      }

    } else if (isAudioMessage(msg)) {
      if (!started || muted) return;
      if (!checkAudioRate(connId, config.maxAudioMsgPerSecond)) {
        // Silently drop — log at debug to avoid spam
        logger.debug('Audio rate limit exceeded, dropping frame', { connId });
        return;
      }
      gemini?.sendAudio(msg.pcmBase64, msg.sampleRate);

    } else {
      const unknownType = (msg as Record<string, unknown>)?.type ?? 'unknown';
      send(ws, { type: 'error', message: `Unknown message type: ${unknownType}` });
    }
  }

  // ── Close / error ───────────────────────────────────────────────────────
  ws.on('close', () => {
    logger.info('WS closed', { sessionId, connId });
    cleanup();
  });

  ws.on('error', (err: Error) => {
    logger.error('WS socket error', { sessionId, connId, error: err.message });
  });
}
