import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';

// Per-session sequence counters (in-memory).
// Node.js is single-threaded so no lock needed for the read-increment-write.
const seqCounters = new Map<string, number>();

export async function saveFinalSegment(
  sessionId: string,
  speaker: 'user' | 'assistant' | 'system',
  text: string,
): Promise<void> {
  const seq = (seqCounters.get(sessionId) ?? 0) + 1;
  seqCounters.set(sessionId, seq);
  try {
    await prisma.transcriptSegment.create({
      data: { sessionId, seq, speaker, text, isFinal: true },
    });
    logger.debug('Final segment saved', { sessionId, seq, speaker });
  } catch (e) {
    logger.error('saveFinalSegment error', {
      sessionId,
      seq,
      error: (e as Error).message,
    });
  }
}

export function clearSeqCounter(sessionId: string): void {
  seqCounters.delete(sessionId);
}
