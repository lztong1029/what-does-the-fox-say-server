export interface AudioInfo {
  sampleRate: number;
  channels: number;
}

/**
 * Parses a Gemini audio MIME type like "audio/pcm;rate=24000" into
 * { sampleRate, channels }.  Gemini Live always outputs mono PCM16.
 */
export function parseAudioMimeType(mimeType: string): AudioInfo {
  const rateMatch = mimeType.match(/rate=(\d+)/);
  return {
    sampleRate: rateMatch ? parseInt(rateMatch[1], 10) : 24000,
    channels: 1,
  };
}
