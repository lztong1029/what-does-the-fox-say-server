import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './jwt.js';
import { logger } from '../utils/logger.js';

export interface AuthRequest extends Request {
  userId?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch (e) {
    logger.warn('Invalid JWT in HTTP request', { error: (e as Error).message });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
