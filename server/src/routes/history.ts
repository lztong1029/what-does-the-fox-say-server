import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../auth/middleware.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

// GET /v1/history/sync-status
// Returns hasUnread, unreadCount, processingCount, latestUpdatedAt
router.get('/sync-status', async (req: AuthRequest, res: Response) => {
  try {
    const sessions = await prisma.practiceSession.findMany({
      where:   { userId: req.userId! },
      select:  { status: true, resultVersion: true, lastReadVersion: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });

    const unreadCount    = sessions.filter(s => s.lastReadVersion < s.resultVersion).length;
    const processingCount = sessions.filter(s => s.status === 'processing').length;
    const latestUpdatedAt = sessions[0]?.updatedAt ?? null;

    res.json({ hasUnread: unreadCount > 0, unreadCount, processingCount, latestUpdatedAt });
  } catch (e) {
    logger.error('GET /history/sync-status error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
