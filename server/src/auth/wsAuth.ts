import { verifyToken, type JwtPayload } from './jwt.js';
import { logger } from '../utils/logger.js';

export function verifyWsToken(token: string): JwtPayload | null {
  const masked = `${token.slice(0, 6)}...`;
  logger.debug('Verifying WS token', { masked });
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}
