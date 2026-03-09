import { GoogleGenAI } from '@google/genai';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { notifySessionUpdated } from '../ws/historyGateway.js';

export interface AnalysisResult {
  topic_title:         string;
  summary:             string;
  feedback_overall:    string;
  pronunciation_notes: string[];
  grammar_notes:       string[];
  vocabulary_notes:    string[];
  fluency_notes:       string[];
  next_reply_prompt:   string;
  transcript_preview:  string;
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
      await prisma.practiceSession.update({
        where: { id: sessionId },
        data:  { status: 'failed', failureReason: 'No transcript available' },
      });
      return;
    }

    const result  = await generateAnalysis(transcriptText, session.nativeLanguage, session.targetLanguage);
    const updated = await prisma.practiceSession.update({
      where: { id: sessionId },
      data: {
        status:            'ready',
        topicTitle:        result.topic_title,
        transcriptPreview: result.transcript_preview,
        feedbackJson:      result as never,
        resultVersion:     { increment: 1 },
      },
    });

    logger.info('Analysis job completed', { sessionId, resultVersion: updated.resultVersion });
    notifySessionUpdated(session.userId, sessionId);
  } catch (e) {
    logger.error('Analysis job failed', { sessionId, error: (e as Error).message });
    try {
      await prisma.practiceSession.update({
        where: { id: sessionId },
        data:  { status: 'failed', failureReason: (e as Error).message },
      });
    } catch { /* ignore secondary failure */ }
  }
}

async function generateAnalysis(
  transcript: string,
  nativeLanguage: string,
  targetLanguage: string,
): Promise<AnalysisResult> {
  if (!config.geminiApiKey) {
    logger.warn('GEMINI_API_KEY not set — using stub analysis');
    return stubAnalysis();
  }

  try {
    const genAI  = new GoogleGenAI({ apiKey: config.geminiApiKey });
    const prompt = `You are a language learning coach. The learner's native language is "${nativeLanguage}" and they are practicing "${targetLanguage}".

Write ALL feedback text fields (summary, feedback_overall, all notes, next_reply_prompt) in ${nativeLanguage}. The transcript will be in ${targetLanguage} — that is expected and correct.

Analyze the conversation transcript below and respond with a single JSON object only (no markdown fences, no extra text):
{
  "topic_title":         "short title of what was discussed (max 8 words)",
  "summary":             "2–3 sentence summary of the conversation",
  "feedback_overall":    "2–3 sentences of overall performance feedback",
  "pronunciation_notes": ["note1", "note2"],
  "grammar_notes":       ["note1", "note2"],
  "vocabulary_notes":    ["note1", "note2"],
  "fluency_notes":       ["note1", "note2"],
  "next_reply_prompt":   "a suggested topic or question for the next practice session",
  "transcript_preview":  "first ~100 characters of the conversation"
}

Transcript:
${transcript}`;

    const response = await genAI.models.generateContent({
      model:    config.feedbackModel,
      contents: prompt,
    });

    const raw     = response.text ?? '';
    const cleaned = raw.replace(/```(?:json)?\n?/g, '').trim();
    return JSON.parse(cleaned) as AnalysisResult;
  } catch (e) {
    logger.error('Gemini analysis failed — using stub', { error: (e as Error).message });
    return stubAnalysis();
  }
}

function stubAnalysis(): AnalysisResult {
  return {
    topic_title:         'Conversation Practice',
    summary:             'The learner engaged in a language practice session.',
    feedback_overall:    'Good effort! Keep practising regularly to build fluency.',
    pronunciation_notes: ['Focus on clear enunciation of consonants'],
    grammar_notes:       ['Watch verb tense consistency'],
    vocabulary_notes:    ['Try to vary your vocabulary more'],
    fluency_notes:       ['Aim for a more natural pace'],
    next_reply_prompt:   'Tell me about your favourite hobby.',
    transcript_preview:  'Practice session completed.',
  };
}
