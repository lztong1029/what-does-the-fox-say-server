import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';

// Called by the realtime WS gateway when the Gemini upstream errors out.
// The session is left in a terminal state; the client should surface an error.
export async function markSessionError(sessionId: string): Promise<void> {
  try {
    const session = await prisma.practiceSession.findUnique({ where: { id: sessionId } });
    if (!session || session.status === 'ready' || session.status === 'failed') return;
    const endedAt     = new Date();
    const durationSec = Math.floor((endedAt.getTime() - session.startedAt.getTime()) / 1000);
    await prisma.practiceSession.update({
      where: { id: sessionId },
      data:  { status: 'failed', failureReason: 'Realtime connection error', endedAt, durationSec },
    });
    logger.warn('Session marked failed', { sessionId });
  } catch (e) {
    logger.error('markSessionError error', { sessionId, error: (e as Error).message });
  }
}
