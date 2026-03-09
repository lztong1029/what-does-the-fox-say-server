import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import { enqueueAnalysisJob } from './feedbackService.js';

// Called by the realtime WS gateway when the Gemini upstream errors out.
// We still attempt analysis — the session may have partial transcript segments.
// If there is no transcript, the analysis job itself will mark the session failed.
export async function markSessionError(sessionId: string): Promise<void> {
  try {
    const session = await prisma.practiceSession.findUnique({ where: { id: sessionId } });
    if (!session || session.status === 'ready' || session.status === 'failed' || session.status === 'processing') return;
    const endedAt     = new Date();
    const durationSec = Math.floor((endedAt.getTime() - session.startedAt.getTime()) / 1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma.practiceSession as any).update({
      where: { id: sessionId },
      data:  { status: 'processing', processingStage: 'finalize_received', endedAt, durationSec },
    });
    enqueueAnalysisJob(sessionId);
    logger.info('Session error — queued for analysis', { sessionId });
  } catch (e) {
    logger.error('markSessionError error', { sessionId, error: (e as Error).message });
  }
}
