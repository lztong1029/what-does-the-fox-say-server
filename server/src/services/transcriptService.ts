import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';

// Per-session sequence counters (in-memory).
// Node.js is single-threaded so no lock needed for the read-increment-write.
const seqCounters = new Map<string, number>();
const lastSavedSegments = new Map<string, { speaker: 'user' | 'fox'; text: string }>();

function normalizeSpeaker(speaker: 'user' | 'assistant' | 'system'): 'user' | 'fox' {
  return speaker === 'user' ? 'user' : 'fox';
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export async function saveFinalSegment(
  sessionId: string,
  speaker: 'user' | 'assistant' | 'system',
  text: string,
): Promise<void> {
  const normalizedSpeaker = normalizeSpeaker(speaker);
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return;
  }

  const lastSaved = lastSavedSegments.get(sessionId);
  if (lastSaved && lastSaved.speaker === normalizedSpeaker && lastSaved.text === normalizedText) {
    logger.debug('Final segment deduped', { sessionId, speaker: normalizedSpeaker });
    return;
  }

  const seq = (seqCounters.get(sessionId) ?? 0) + 1;
  seqCounters.set(sessionId, seq);
  try {
    await prisma.transcriptSegment.create({
      data: { sessionId, seq, speaker: normalizedSpeaker, text: normalizedText, isFinal: true },
    });
    lastSavedSegments.set(sessionId, { speaker: normalizedSpeaker, text: normalizedText });
    logger.debug('Final segment saved', { sessionId, seq, speaker: normalizedSpeaker });
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
  lastSavedSegments.delete(sessionId);
}
