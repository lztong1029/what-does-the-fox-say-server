import { Router, type Request, type Response } from 'express';
import { prisma } from '../db/prisma.js';
import { signToken } from '../auth/jwt.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const router = Router();

// POST /v1/auth/anonymous
// Body: { device_id, device_model?, os?, language?, timezone? }
// Returns: { token, userId, deviceId, expiresIn }
router.post('/anonymous', async (req: Request, res: Response) => {
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
    let device = await prisma.device.findUnique({ where: { deviceId: device_id } });
    let user;

    if (device) {
      user = await prisma.user.findUnique({ where: { id: device.userId } });
      await prisma.device.update({
        where: { deviceId: device_id },
        data: {
          deviceModel: typeof device_model === 'string' ? device_model : undefined,
          os:          typeof os           === 'string' ? os           : undefined,
          language:    typeof language     === 'string' ? language     : undefined,
          timezone:    typeof timezone     === 'string' ? timezone     : undefined,
        },
      });
    } else {
      user   = await prisma.user.create({ data: {} });
      device = await prisma.device.create({
        data: {
          userId:      user.id,
          deviceId:    device_id,
          deviceModel: typeof device_model === 'string' ? device_model : null,
          os:          typeof os           === 'string' ? os           : null,
          language:    typeof language     === 'string' ? language     : null,
          timezone:    typeof timezone     === 'string' ? timezone     : null,
        },
      });
    }

    const token = signToken({ userId: user!.id });
    res.json({ token, userId: user!.id, deviceId: device.deviceId, expiresIn: config.jwtExpiresIn });
  } catch (e) {
    logger.error('Auth /anonymous error', { error: (e as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
