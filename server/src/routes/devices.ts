import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../auth/middleware.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

// POST /v1/devices — idempotent device registration
router.post('/', async (req: AuthRequest, res: Response) => {
  const { device_id, device_model, os, language, timezone } =
    (req.body ?? {}) as {
      device_id?: unknown;
      device_model?: unknown;
      os?: unknown;
      language?: unknown;
      timezone?: unknown;
    };

  if (!device_id || typeof device_id !== 'string') {
    res.status(400).json({ error: 'device_id is required' });
    return;
  }

  try {
    const device = await prisma.device.upsert({
      where: { deviceId: device_id },
      create: {
        userId:      req.userId!,
        deviceId:    device_id,
        deviceModel: typeof device_model === 'string' ? device_model : null,
        os:          typeof os           === 'string' ? os           : null,
        language:    typeof language     === 'string' ? language     : null,
        timezone:    typeof timezone     === 'string' ? timezone     : null,
      },
      update: {
        deviceModel: typeof device_model === 'string' ? device_model : undefined,
        os:          typeof os           === 'string' ? os           : undefined,
        language:    typeof language     === 'string' ? language     : undefined,
        timezone:    typeof timezone     === 'string' ? timezone     : undefined,
      },
    });
    res.status(201).json({ deviceId: device.deviceId });
  } catch (e) {
    logger.error('POST /devices error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
