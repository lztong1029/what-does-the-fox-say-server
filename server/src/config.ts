export const config = {
  port: Number(process.env.PORT ?? 8080),
  jwtSecret: process.env.JWT_SECRET ?? 'dev_secret_change_me',
  jwtExpiresIn: 86400, // 24h in seconds
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiLiveModel: process.env.GEMINI_LIVE_MODEL ?? 'gemini-2.0-flash-live-001',
  feedbackModel: process.env.FEEDBACK_MODEL ?? 'gemini-1.5-flash',
  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  maxSessionDurationMs: 5 * 60 * 1000, // 5 minutes
  maxAudioMsgPerSecond: 20,
  maxWsConnPerUserPerMin: 5,
  feedbackConcurrency: 2,
} as const;
