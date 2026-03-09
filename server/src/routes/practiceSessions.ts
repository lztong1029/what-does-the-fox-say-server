import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../auth/middleware.js';
import { prisma } from '../db/prisma.js';
import { enqueueAnalysisJob } from '../services/feedbackService.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

// POST /v1/practice-sessions
router.post('/', async (req: AuthRequest, res: Response) => {
  const { nativeLanguage, targetLanguage, persona, deviceId } =
    (req.body ?? {}) as {
      nativeLanguage?: unknown;
      targetLanguage?: unknown;
      persona?: unknown;
      deviceId?: unknown;
    };

  if (!nativeLanguage || typeof nativeLanguage !== 'string') {
    res.status(400).json({ error: 'nativeLanguage is required' });
    return;
  }
  if (!targetLanguage || typeof targetLanguage !== 'string') {
    res.status(400).json({ error: 'targetLanguage is required' });
    return;
  }

  try {
    const session = await prisma.practiceSession.create({
      data: {
        userId:        req.userId!,
        deviceId:      typeof deviceId === 'string' ? deviceId : null,
        nativeLanguage,
        targetLanguage,
        persona:       typeof persona === 'string' ? persona : null,
        status:        'active',
      },
    });
    res.status(201).json({ sessionId: session.id, status: session.status });
  } catch (e) {
    logger.error('POST /practice-sessions error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /v1/practice-sessions/:id/finalize
router.patch('/:id/finalize', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { transcriptFullJson, durationSec, audioUrl } =
    (req.body ?? {}) as {
      transcriptFullJson?: unknown;
      durationSec?: unknown;
      audioUrl?: unknown;
    };

  try {
    const session = await prisma.practiceSession.findUnique({ where: { id } });
    if (!session || session.userId !== req.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'active') {
      res.json({ sessionId: id, status: session.status });
      return;
    }

    const endedAt = new Date();
    const computedDuration =
      typeof durationSec === 'number'
        ? durationSec
        : Math.floor((endedAt.getTime() - session.startedAt.getTime()) / 1000);

    // Use client-provided transcript; fall back to saved segments
    let finalTranscript: unknown = transcriptFullJson ?? null;
    if (!finalTranscript) {
      const segments = await prisma.transcriptSegment.findMany({
        where: { sessionId: id },
        orderBy: { seq: 'asc' },
        select: { seq: true, speaker: true, text: true },
      });
      if (segments.length > 0) finalTranscript = segments;
    }

    await prisma.practiceSession.update({
      where: { id },
      data: {
        status:            'processing',
        endedAt,
        durationSec:       computedDuration,
        transcriptFullJson: finalTranscript as never ?? undefined,
        audioUrl:          typeof audioUrl === 'string' ? audioUrl : undefined,
      },
    });

    enqueueAnalysisJob(id);
    res.json({ sessionId: id, status: 'processing' });
  } catch (e) {
    logger.error('PATCH /practice-sessions/:id/finalize error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/practice-sessions?cursor=<id>&limit=20
router.get('/', async (req: AuthRequest, res: Response) => {
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const limit  = Math.min(Number(req.query.limit ?? 20), 50);

  try {
    const sessions = await prisma.practiceSession.findMany({
      where:   { userId: req.userId! },
      orderBy: { startedAt: 'desc' },
      take:    limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, nativeLanguage: true, targetLanguage: true, persona: true,
        status: true, failureReason: true, topicTitle: true, transcriptPreview: true,
        startedAt: true, endedAt: true, durationSec: true,
        resultVersion: true, lastReadVersion: true, updatedAt: true,
      },
    });

    const hasMore = sessions.length > limit;
    const items   = sessions.slice(0, limit).map(s => ({
      sessionId:        s.id,
      nativeLanguage:   s.nativeLanguage,
      targetLanguage:   s.targetLanguage,
      persona:          s.persona,
      status:           s.status,
      failureReason:    s.failureReason,
      topicTitle:       s.topicTitle,
      transcriptPreview: s.transcriptPreview,
      startedAt:        s.startedAt,
      endedAt:          s.endedAt,
      durationSec:      s.durationSec,
      updatedAt:        s.updatedAt,
      isUnread:         s.lastReadVersion < s.resultVersion,
    }));

    res.json({ items, nextCursor: hasMore ? sessions[limit - 1].id : null });
  } catch (e) {
    logger.error('GET /practice-sessions error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/practice-sessions/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const session = await prisma.practiceSession.findUnique({ where: { id } });
    if (!session || session.userId !== req.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({
      sessionId:         session.id,
      nativeLanguage:    session.nativeLanguage,
      targetLanguage:    session.targetLanguage,
      persona:           session.persona,
      status:            session.status,
      failureReason:     session.failureReason,
      topicTitle:        session.topicTitle,
      transcriptPreview: session.transcriptPreview,
      transcriptFullJson: session.transcriptFullJson,
      feedbackJson:      session.feedbackJson,
      startedAt:         session.startedAt,
      endedAt:           session.endedAt,
      durationSec:       session.durationSec,
      audioUrl:          session.audioUrl,
      modelAudioUrl:     session.modelAudioUrl,
      resultVersion:     session.resultVersion,
      lastReadVersion:   session.lastReadVersion,
      updatedAt:         session.updatedAt,
    });
  } catch (e) {
    logger.error('GET /practice-sessions/:id error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/practice-sessions/:id/read
router.post('/:id/read', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { version } = (req.body ?? {}) as { version?: unknown };

  if (typeof version !== 'number') {
    res.status(400).json({ error: 'version (number) is required' });
    return;
  }

  try {
    const session = await prisma.practiceSession.findUnique({ where: { id } });
    if (!session || session.userId !== req.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await prisma.practiceSession.update({
      where: { id },
      data:  { lastReadVersion: version },
    });
    res.json({ ok: true });
  } catch (e) {
    logger.error('POST /practice-sessions/:id/read error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /v1/practice-sessions/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const session = await prisma.practiceSession.findUnique({ where: { id } });
    if (!session || session.userId !== req.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await prisma.transcriptSegment.deleteMany({ where: { sessionId: id } });
    await prisma.practiceSession.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    logger.error('DELETE /practice-sessions/:id error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/practice-sessions/:id/retry-analysis
router.post('/:id/retry-analysis', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const session = await prisma.practiceSession.findUnique({ where: { id } });
    if (!session || session.userId !== req.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'failed') {
      res.status(409).json({ error: 'Session is not in failed state' });
      return;
    }
    await prisma.practiceSession.update({
      where: { id },
      data:  { status: 'processing', failureReason: null },
    });
    enqueueAnalysisJob(id);
    res.json({ sessionId: id, status: 'processing' });
  } catch (e) {
    logger.error('POST /practice-sessions/:id/retry-analysis error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
