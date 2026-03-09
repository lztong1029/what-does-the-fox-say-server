/**
 * Entry point — "What Does the Fox Say" backend.
 *
 * Node 18 does not ship a global `WebSocket` class.
 * The Gemini Live SDK uses WebSocket internally, so we polyfill it with
 * the `ws` package BEFORE any SDK import occurs.
 */
import { WebSocket as WsWebSocket } from 'ws';
if (!('WebSocket' in globalThis)) {
  // @ts-expect-error — polyfill for Node 18
  globalThis.WebSocket = WsWebSocket;
}

import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { logger } from './utils/logger.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import devicesRouter from './routes/devices.js';
import profileRouter from './routes/profile.js';
import practiceSessionsRouter from './routes/practiceSessions.js';
import historyRouter from './routes/history.js';
import { setupLiveGateway } from './ws/liveGateway.js';
import { setupHistoryGateway } from './ws/historyGateway.js';

const app = express();

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.disable('x-powered-by');
app.disable('etag'); // prevent 304s — iOS URLSession doesn't handle them reliably

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/health',                healthRouter);
app.use('/v1/health',             healthRouter);
app.use('/v1/auth',               authRouter);
app.use('/v1/devices',            devicesRouter);
app.use('/v1/profile',            profileRouter);
app.use('/v1/practice-sessions',  practiceSessionsRouter);
app.use('/v1/history',            historyRouter);

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket servers ────────────────────────────────────────────────────────
const realtimeWss = new WebSocketServer({ noServer: true });
const historyWss  = new WebSocketServer({ noServer: true });
setupLiveGateway(realtimeWss);
setupHistoryGateway(historyWss);

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '', 'http://localhost').pathname;
  if (pathname === '/v1/realtime/ws') {
    realtimeWss.handleUpgrade(req, socket, head, ws => realtimeWss.emit('connection', ws, req));
  } else if (pathname === '/v1/history/ws') {
    historyWss.handleUpgrade(req, socket, head, ws => historyWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(config.port, () => {
  logger.info('Server listening', { port: config.port });
});

// Graceful shutdown
function shutdown(): void {
  logger.info('Shutting down');
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
