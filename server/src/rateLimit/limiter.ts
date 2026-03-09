// In-memory rate limiter — suitable for single-process Railway deployments.

// WS connection rate: max N connections per user per minute
const wsConnMap = new Map<string, number[]>();

export function checkWsConnRate(userId: string, maxPerMin: number): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const timestamps = (wsConnMap.get(userId) ?? []).filter(t => now - t < windowMs);
  if (timestamps.length >= maxPerMin) return false;
  timestamps.push(now);
  wsConnMap.set(userId, timestamps);
  return true;
}

// Audio message rate: max N messages per second per connection
const audioRateMap = new Map<string, number[]>();

export function checkAudioRate(connId: string, maxPerSec: number): boolean {
  const now = Date.now();
  const windowMs = 1_000;
  const timestamps = (audioRateMap.get(connId) ?? []).filter(t => now - t < windowMs);
  if (timestamps.length >= maxPerSec) return false;
  timestamps.push(now);
  audioRateMap.set(connId, timestamps);
  return true;
}

export function cleanupAudioRate(connId: string): void {
  audioRateMap.delete(connId);
}
