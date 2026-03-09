import { GoogleGenAI } from '@google/genai';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { notifySessionUpdated } from '../ws/historyGateway.js';

export interface TranscriptEntry {
  speaker: 'user' | 'fox';
  text:    string;
}

export interface AnalysisResult {
  topic_title:      string;
  summary:          string;
  feedback_overall: string;
  transcript:       TranscriptEntry[];
}

// Simple in-process FIFO queue with concurrency limit
const queue: string[] = [];
let running = 0;

export function enqueueAnalysisJob(sessionId: string): void {
  queue.push(sessionId);
  logger.info('Analysis job enqueued', { sessionId, queueLen: queue.length });
  drainQueue();
}

function drainQueue(): void {
  while (running < config.feedbackConcurrency && queue.length > 0) {
    const sessionId = queue.shift()!;
    running++;
    runJob(sessionId).finally(() => { running--; drainQueue(); });
  }
}

async function runJob(sessionId: string): Promise<void> {
  logger.info('Analysis job started', { sessionId });
  try {
    const session = await prisma.practiceSession.findUnique({
      where:   { id: sessionId },
      include: { transcriptSegments: { orderBy: { seq: 'asc' } } },
    });

    if (!session) {
      logger.warn('Session not found for analysis', { sessionId });
      return;
    }

    // Build transcript text from real-time segments or the stored JSON blob
    let transcriptText = '';
    if (session.transcriptSegments.length > 0) {
      transcriptText = session.transcriptSegments
        .map(s => `${s.speaker}: ${s.text}`)
        .join('\n');
    } else if (session.transcriptFullJson) {
      const segs = session.transcriptFullJson as Array<{ speaker: string; text: string }>;
      transcriptText = segs.map(s => `${s.speaker}: ${s.text}`).join('\n');
    }

    if (!transcriptText) {
      logger.info('No transcript for analysis — marking failed', { sessionId });
      const failed = await prisma.practiceSession.update({
        where: { id: sessionId },
        data:  {
          status:        'failed',
          failureReason: 'Session ended before feedback could be generated',
          resultVersion: { increment: 1 },
        },
      });
      notifySessionUpdated(failed.userId, sessionId);
      return;
    }

    // Build structured transcript from segments
    const transcriptEntries: TranscriptEntry[] = session.transcriptSegments.length > 0
      ? session.transcriptSegments.map(s => ({ speaker: s.speaker as 'user' | 'fox', text: s.text }))
      : (session.transcriptFullJson as TranscriptEntry[] | null) ?? [];

    const analysis = await generateAnalysis(transcriptText, session.nativeLanguage, session.targetLanguage);
    const result: AnalysisResult = { ...analysis, transcript: transcriptEntries };

    const updated = await prisma.practiceSession.update({
      where: { id: sessionId },
      data: {
        status:        'ready',
        topicTitle:    result.topic_title,
        feedbackJson:  result as never,
        resultVersion: { increment: 1 },
      },
    });

    logger.info('Analysis job completed', { sessionId, resultVersion: updated.resultVersion });
    notifySessionUpdated(session.userId, sessionId);
  } catch (e) {
    logger.error('Analysis job failed', { sessionId, error: (e as Error).message });
    try {
      const failed = await prisma.practiceSession.update({
        where: { id: sessionId },
        data:  {
          status:        'failed',
          failureReason: (e as Error).message,
          resultVersion: { increment: 1 },
        },
      });
      notifySessionUpdated(failed.userId, sessionId);
    } catch { /* ignore secondary failure */ }
  }
}

// Gemini only generates the three text fields; transcript is assembled from segments.
interface GeminiAnalysis {
  topic_title:      string;
  summary:          string;
  feedback_overall: string;
}

async function generateAnalysis(
  transcript: string,
  nativeLanguage: string,
  targetLanguage: string,
): Promise<GeminiAnalysis> {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const genAI  = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const prompt = `You are a language learning coach. The learner's native language is "${nativeLanguage}" and they are practicing "${targetLanguage}".

Write summary and feedback_overall in ${nativeLanguage}. The transcript will be in ${targetLanguage} — that is expected and correct.

Analyze the conversation transcript below and respond with a single JSON object only (no markdown fences, no extra text):
{
  "topic_title":      "short title of what was discussed (max 8 words)",
  "summary":          "2–3 sentence summary of the conversation",
  "feedback_overall": "2–3 sentences of overall performance feedback"
}

Transcript:
${transcript}`;

  const response = await genAI.models.generateContent({
    model:    config.feedbackModel,
    contents: prompt,
  });

  const raw     = response.text ?? '';
  const cleaned = raw.replace(/```(?:json)?\n?/g, '').trim();
  return JSON.parse(cleaned) as GeminiAnalysis;
}

