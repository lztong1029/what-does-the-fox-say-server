import fs from 'fs';
import path from 'path';
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

function normalizeTranscriptSpeaker(speaker: string): 'user' | 'fox' {
  return speaker === 'user' ? 'user' : 'fox';
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma.practiceSession as any).updateMany({
      where: { id: sessionId, status: 'processing' },
      data:  { processingStage: 'analysis_running' },
    });

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
        .map(s => `${normalizeTranscriptSpeaker(s.speaker)}: ${s.text}`)
        .join('\n');
    } else if (session.transcriptFullJson) {
      const segs = session.transcriptFullJson as Array<{ speaker: string; text: string }>;
      transcriptText = segs
        .map(s => ({ speaker: normalizeTranscriptSpeaker(s.speaker), text: s.text?.trim?.() ?? '' }))
        .filter(s => s.text.length > 0)
        .map(s => `${s.speaker}: ${s.text}`)
        .join('\n');
    }

    // STT fallback: if no transcript but audio file exists on disk, use Gemini audio analysis
    let analysisResult: AnalysisResult | null = null;
    if (!transcriptText) {
      const audioFilePath = path.join(config.audioStoragePath, `${sessionId}.m4a`);
      if (fs.existsSync(audioFilePath)) {
        logger.info('No transcript — attempting audio STT fallback', { sessionId });
        analysisResult = await generateAnalysisFromAudio(audioFilePath, session.nativeLanguage, session.targetLanguage);
      } else {
        logger.info('No transcript for analysis — marking failed', { sessionId });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failed = await (prisma.practiceSession as any).update({
          where: { id: sessionId },
          data:  {
            status:          'failed',
            processingStage: 'failed',
            failureReason:   'Session ended before feedback could be generated',
            resultVersion:   { increment: 1 },
          },
        }) as Awaited<ReturnType<typeof prisma.practiceSession.update>>;
        notifySessionUpdated(failed.userId, sessionId, failed.status, 'failed', failed.resultVersion);
        return;
      }
    }

    // Build structured transcript from segments (or empty if STT path)
    const transcriptEntries: TranscriptEntry[] = session.transcriptSegments.length > 0
      ? session.transcriptSegments.map(s => ({ speaker: normalizeTranscriptSpeaker(s.speaker), text: s.text }))
      : (((session.transcriptFullJson as Array<{ speaker: string; text: string }> | null) ?? [])
        .map(s => ({ speaker: normalizeTranscriptSpeaker(s.speaker), text: s.text?.trim?.() ?? '' }))
        .filter(s => s.text.length > 0));

    const result: AnalysisResult = analysisResult
      ?? { ...await generateAnalysis(transcriptText, session.nativeLanguage, session.targetLanguage), transcript: transcriptEntries };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await (prisma.practiceSession as any).update({
      where: { id: sessionId },
      data: {
        status:          'ready',
        processingStage: 'ready',
        topicTitle:      result.topic_title,
        feedbackJson:    result,
        resultVersion:   { increment: 1 },
      },
    }) as Awaited<ReturnType<typeof prisma.practiceSession.update>>;

    logger.info('Analysis job completed', { sessionId, resultVersion: updated.resultVersion });
    logger.debug('Analysis payload summary', {
      sessionId,
      transcriptCount: result.transcript.length,
      summaryChars: result.summary.length,
      feedbackChars: result.feedback_overall.length,
    });
    notifySessionUpdated(session.userId, sessionId, updated.status, 'ready', updated.resultVersion);
  } catch (e) {
    logger.error('Analysis job failed', { sessionId, error: (e as Error).message });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const failed = await (prisma.practiceSession as any).update({
        where: { id: sessionId },
        data:  {
          status:          'failed',
          processingStage: 'failed',
          failureReason:   (e as Error).message,
          resultVersion:   { increment: 1 },
        },
      }) as Awaited<ReturnType<typeof prisma.practiceSession.update>>;
      notifySessionUpdated(failed.userId, sessionId, failed.status, 'failed', failed.resultVersion);
    } catch { /* ignore secondary failure */ }
  }
}

async function generateAnalysisFromAudio(
  audioFilePath: string,
  nativeLanguage: string,
  targetLanguage: string,
): Promise<AnalysisResult> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY not configured');

  const audioData = fs.readFileSync(audioFilePath).toString('base64');
  const genAI  = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const prompt = `You are a language learning coach. The learner's native language is "${nativeLanguage}" and they are practicing "${targetLanguage}".

The audio contains a conversation between a learner (user) and an AI language tutor (fox).
First transcribe the conversation, then analyze it.

Write summary and feedback_overall in ${nativeLanguage}.

Respond with a single JSON object only (no markdown fences, no extra text):
{
  "topic_title":      "short title of what was discussed (max 8 words)",
  "summary":          "2–3 sentence summary of the conversation",
  "feedback_overall": "2–3 sentences of overall performance feedback",
  "transcript": [
    { "speaker": "user", "text": "..." },
    { "speaker": "fox",  "text": "..." }
  ]
}`;

  const response = await genAI.models.generateContent({
    model:    config.feedbackModel,
    contents: {
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'audio/mp4', data: audioData } },
      ],
    } as never,
  });

  const raw     = response.text ?? '';
  const cleaned = raw.replace(/```(?:json)?\n?/g, '').trim();
  const parsed  = JSON.parse(cleaned) as GeminiAnalysis & { transcript?: TranscriptEntry[] };
  return {
    topic_title:      parsed.topic_title,
    summary:          parsed.summary,
    feedback_overall: parsed.feedback_overall,
    transcript:       parsed.transcript ?? [],
  };
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
