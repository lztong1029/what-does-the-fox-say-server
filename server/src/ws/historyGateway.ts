import { WebSocket, type WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { verifyWsToken } from '../auth/wsAuth.js';
import { logger } from '../utils/logger.js';

// In-memory subscribers: userId → Set of open WS connections
const subscribers = new Map<string, Set<WebSocket>>();

/**
 * Called by feedbackService when a session transitions processing → ready.
 * Pushes { type: "session_updated", sessionId } to all history WS connections
 * for that user.
 */
export function notifySessionUpdated(userId: string, sessionId: string): void {
  const conns = subscribers.get(userId);
  if (!conns || conns.size === 0) return;
  const payload = JSON.stringify({ type: 'session_updated', sessionId });
  for (const ws of conns) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

export function setupHistoryGateway(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url   = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) { ws.close(1008, 'Missing token'); return; }

    const payload = verifyWsToken(token);
    if (!payload) { ws.close(1008, 'Invalid token'); return; }

    const { userId } = payload;
    logger.info('History WS connected', { userId });

    if (!subscribers.has(userId)) subscribers.set(userId, new Set());
    subscribers.get(userId)!.add(ws);

    ws.on('close', () => {
      logger.info('History WS closed', { userId });
      const set = subscribers.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) subscribers.delete(userId);
      }
    });

    ws.on('error', (err: Error) => {
      logger.error('History WS error', { userId, error: err.message });
    });
  });
}
