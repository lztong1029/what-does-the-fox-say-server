import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../auth/middleware.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

// GET /v1/profile
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const profile = await prisma.userProfile.findUnique({
      where: { userId: req.userId! },
    });
    res.json({
      nativeLanguage: profile?.nativeLanguage ?? null,
      targetLanguage: profile?.targetLanguage ?? null,
      persona:        profile?.persona        ?? null,
    });
  } catch (e) {
    logger.error('GET /profile error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /v1/profile
router.patch('/', async (req: AuthRequest, res: Response) => {
  const { nativeLanguage, targetLanguage, persona } =
    (req.body ?? {}) as {
      nativeLanguage?: unknown;
      targetLanguage?: unknown;
      persona?: unknown;
    };

  try {
    const profile = await prisma.userProfile.upsert({
      where: { userId: req.userId! },
      create: {
        userId:        req.userId!,
        nativeLanguage: typeof nativeLanguage === 'string' ? nativeLanguage : null,
        targetLanguage: typeof targetLanguage === 'string' ? targetLanguage : null,
        persona:        typeof persona        === 'string' ? persona        : null,
      },
      update: {
        nativeLanguage: typeof nativeLanguage === 'string' ? nativeLanguage : undefined,
        targetLanguage: typeof targetLanguage === 'string' ? targetLanguage : undefined,
        persona:        typeof persona        === 'string' ? persona        : undefined,
      },
    });
    res.json({
      nativeLanguage: profile.nativeLanguage,
      targetLanguage: profile.targetLanguage,
      persona:        profile.persona,
    });
  } catch (e) {
    logger.error('PATCH /profile error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
