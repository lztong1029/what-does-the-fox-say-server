import fs from 'fs';
import path from 'path';
import { Router, type Response } from 'express';
import multer from 'multer';
import { requireAuth, type AuthRequest } from '../auth/middleware.js';
import { prisma } from '../db/prisma.js';
import { enqueueAnalysisJob } from '../services/feedbackService.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma.practiceSession as any).update({
      where: { id },
      data: {
        status:             'processing',
        processingStage:    'finalize_received',
        endedAt,
        durationSec:        computedDuration,
        transcriptFullJson: finalTranscript ?? undefined,
        audioUrl:           typeof audioUrl === 'string' ? audioUrl : undefined,
      },
    });

    enqueueAnalysisJob(id);
    res.json({ sessionId: id, status: 'processing', processingStage: 'finalize_received' });
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select: {
        id: true, nativeLanguage: true, targetLanguage: true, persona: true,
        status: true, processingStage: true, failureReason: true, topicTitle: true, transcriptPreview: true,
        startedAt: true, endedAt: true, durationSec: true,
        resultVersion: true, lastReadVersion: true, updatedAt: true,
        feedbackJson: true,
      } as any,
    });

    const hasMore = sessions.length > limit;
    const items   = sessions.slice(0, limit).map((s: any) => ({
      sessionId:       s.id,
      nativeLanguage:  s.nativeLanguage,
      targetLanguage:  s.targetLanguage,
      status:          s.status,
      startedAt:       s.startedAt,
      updatedAt:       s.updatedAt,
      resultVersion:   s.resultVersion,
      lastReadVersion: s.lastReadVersion,
      isUnread:        s.lastReadVersion < s.resultVersion,
      ...(s.persona          != null && { persona:          s.persona }),
      ...(s.processingStage  != null && { processingStage:  s.processingStage }),
      ...(s.failureReason    != null && { failureReason:    s.failureReason }),
      ...(s.topicTitle       != null && { topicTitle:       s.topicTitle }),
      ...(s.transcriptPreview != null && { transcriptPreview: s.transcriptPreview }),
      ...(s.endedAt          != null && { endedAt:          s.endedAt }),
      ...(s.durationSec      != null && { durationSec:      s.durationSec }),
      ...(s.feedbackJson     != null && { summary: (s.feedbackJson as any).summary }),
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
    const session = await prisma.practiceSession.findUnique({
      where:   { id },
      include: { transcriptSegments: { orderBy: { seq: 'asc' }, select: { seq: true, speaker: true, text: true } } },
    });
    if (!session || session.userId !== req.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const s = session as any;
    res.json({
      sessionId:          session.id,
      nativeLanguage:     session.nativeLanguage,
      targetLanguage:     session.targetLanguage,
      persona:            session.persona,
      status:             session.status,
      processingStage:    s.processingStage ?? null,
      failureReason:      session.failureReason,
      topicTitle:         session.topicTitle,
      transcriptPreview:  session.transcriptPreview,
      transcriptFullJson: session.transcriptFullJson,
      transcriptSegments: session.transcriptSegments.length > 0 ? session.transcriptSegments : undefined,
      feedbackJson:       session.feedbackJson,
      startedAt:          session.startedAt,
      endedAt:            session.endedAt,
      durationSec:        session.durationSec,
      audioUrl:           session.audioUrl,
      modelAudioUrl:      session.modelAudioUrl,
      resultVersion:      session.resultVersion,
      lastReadVersion:    session.lastReadVersion,
      updatedAt:          session.updatedAt,
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

// POST /v1/practice-sessions/:id/audio
// Accepts a multipart audio file, saves it to disk, returns { audioUrl }
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(config.audioStoragePath, { recursive: true });
      cb(null, config.audioStoragePath);
    },
    filename: (req, _file, cb) => {
      cb(null, `${(req as AuthRequest).params.id}.m4a`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

router.post('/:id/audio', upload.single('file'), async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    const session = await prisma.practiceSession.findUnique({ where: { id } });
    if (!session || session.userId !== req.userId) {
      fs.unlinkSync(req.file.path);
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const audioUrl = `${config.publicUrl}/v1/practice-sessions/${id}/audio`;
    await prisma.practiceSession.update({ where: { id }, data: { audioUrl } });
    logger.info('Audio uploaded', { sessionId: id, size: req.file.size });
    res.json({ audioUrl });
  } catch (e) {
    logger.error('POST /practice-sessions/:id/audio error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/practice-sessions/:id/audio
router.get('/:id/audio', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const session = await prisma.practiceSession.findUnique({ where: { id } });
    if (!session || session.userId !== req.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const filePath = path.join(config.audioStoragePath, `${id}.m4a`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Audio file not found' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mp4');
    res.sendFile(filePath);
  } catch (e) {
    logger.error('GET /practice-sessions/:id/audio error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/practice-sessions/:id/retry (alias: /retry-analysis)
router.post('/:id/retry', async (req: AuthRequest, res: Response) => {
  return retryAnalysis(req, res);
});

router.post('/:id/retry-analysis', async (req: AuthRequest, res: Response) => {
  return retryAnalysis(req, res);
});

async function retryAnalysis(req: AuthRequest, res: Response): Promise<void> {
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
    const segCount = await prisma.transcriptSegment.count({ where: { sessionId: id } });
    const hasAudio = fs.existsSync(path.join(config.audioStoragePath, `${id}.m4a`));
    if (!session.transcriptFullJson && segCount === 0 && !hasAudio) {
      res.status(422).json({ error: 'No transcript or audio available — cannot retry analysis' });
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
}

export default router;