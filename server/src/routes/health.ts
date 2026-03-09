import { Router } from 'express';
import { prisma } from '../db/prisma.js';

const router = Router();

router.get('/', (_req, res) => {
  res.status(200).send('ok');
});

// Diagnostic: check DB connectivity and whether tables exist
router.get('/db', async (_req, res) => {
  try {
    const userCount = await prisma.user.count();
    const deviceCount = await prisma.device.count();
    res.json({ ok: true, userCount, deviceCount });
  } catch (e) {
    const err = e as Record<string, unknown>;
    res.status(500).json({
      ok: false,
      message: (e as Error).message,
      code: err['code'],
      meta: err['meta'],
    });
  }
});

export default router;
