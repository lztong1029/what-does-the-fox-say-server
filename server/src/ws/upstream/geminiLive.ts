/**
 * Wraps a Gemini Live API session.
 *
 * Gemini Live model: gemini-2.0-flash-live-001 (or value of GEMINI_LIVE_MODEL)
 * SDK: @google/genai  — ai.live.connect()
 *
 * Audio format notes
 * ------------------
 * Input  : PCM16 mono, 16 kHz   (mimeType "audio/pcm;rate=16000")
 * Output : PCM16 mono, 24 kHz   (mimeType "audio/pcm;rate=24000")
 * Both sides are raw base-64 encoded PCM — no container.
 * The iOS client must resample/play accordingly.
 *
 * Node 18 does NOT ship a global WebSocket; we polyfill with the `ws` package
 * before the first SDK call (done in src/index.ts).
 */

import { GoogleGenAI, Modality } from '@google/genai';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { parseAudioMimeType } from './mapper.js';

export interface GeminiLiveCallbacks {
  onPartialTranscript: (speaker: 'user' | 'assistant', text: string) => void;
  onFinalTranscript:   (speaker: 'user' | 'assistant', text: string) => void;
  onAudioOutput:       (pcmBase64: string, sampleRate: number, channels: number) => void;
  onSpeakingStarted:   () => void;
  onTurnComplete:      () => void;
  onError:             (message: string) => void;
  onClose:             () => void;
}

// The SDK's LiveSession type is not fully exported — use `any` defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LiveSession = any;

export class GeminiLiveSession {
  private session: LiveSession | null = null;
  private closed = false;
  private callbacks: GeminiLiveCallbacks;
  private systemInstruction: string | undefined;

  constructor(callbacks: GeminiLiveCallbacks, systemInstruction?: string) {
    this.callbacks = callbacks;
    this.systemInstruction = systemInstruction;
  }

  /** Establishes the upstream WebSocket connection to Gemini. */
  async connect(): Promise<void> {
    if (!config.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }

    const genAI = new GoogleGenAI({ apiKey: config.geminiApiKey });

    this.session = await genAI.live.connect({
      model: config.geminiLiveModel,
      callbacks: {
        onopen: () => {
          logger.info('Gemini Live upstream connected', { model: config.geminiLiveModel });
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onmessage: (msg: any) => {
          try {
            this.handleMessage(msg);
          } catch (e) {
            logger.error('Gemini message handler threw', { error: (e as Error).message });
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onerror: (e: any) => {
          const msg = (e as Error)?.message ?? String(e);
          logger.error('Gemini Live upstream error', { error: msg });
          if (!this.closed) {
            this.callbacks.onError('Upstream error');
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onclose: (e: any) => {
          logger.info('Gemini Live upstream closed', { code: e?.code ?? 'unknown' });
          if (!this.closed) {
            this.callbacks.onClose();
          }
        },
      },
      config: {
        ...(this.systemInstruction ? { systemInstruction: this.systemInstruction } : {}),
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Puck' },
          },
        },
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(msg: any): void {
    if (!msg) return;

    const sc = msg.serverContent;
    if (!sc) return;

    // ── User speech transcription ─────────────────────────────────────────
    if (sc.inputTranscription) {
      const { text, finished } = sc.inputTranscription as { text?: string; finished?: boolean };
      if (text) {
        if (finished) {
          this.callbacks.onFinalTranscript('user', text);
        } else {
          this.callbacks.onPartialTranscript('user', text);
        }
      }
    }

    // ── Assistant speech transcription ────────────────────────────────────
    if (sc.outputTranscription) {
      const { text, finished } = sc.outputTranscription as { text?: string; finished?: boolean };
      if (text) {
        if (finished) {
          this.callbacks.onFinalTranscript('assistant', text);
        } else {
          this.callbacks.onPartialTranscript('assistant', text);
        }
      }
    }

    // ── Model turn parts (audio / inline text) ────────────────────────────
    if (sc.modelTurn?.parts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const part of sc.modelTurn.parts as any[]) {
        if (part.inlineData?.data) {
          const mimeType: string = part.inlineData.mimeType ?? 'audio/pcm;rate=24000';
          const { sampleRate, channels } = parseAudioMimeType(mimeType);
          this.callbacks.onAudioOutput(part.inlineData.data as string, sampleRate, channels);
          this.callbacks.onSpeakingStarted();
        }
        // Inline text parts (fallback when no separate transcription track)
        if (part.text && !sc.outputTranscription) {
          this.callbacks.onPartialTranscript('assistant', part.text as string);
        }
      }
    }

    // ── Turn complete ─────────────────────────────────────────────────────
    if (sc.turnComplete) {
      this.callbacks.onTurnComplete();
    }
  }

  /**
   * Send a chunk of raw PCM16 audio to Gemini.
   * @param pcmBase64 Base-64 encoded PCM16 audio
   * @param sampleRate Hz (default 16000)
   */
  sendAudio(pcmBase64: string, sampleRate = 16000): void {
    if (!this.session || this.closed) return;
    try {
      this.session.sendRealtimeInput({
        media: {
          data: pcmBase64,
          mimeType: `audio/pcm;rate=${sampleRate}`,
        },
      });
    } catch (e) {
      logger.error('GeminiLive sendAudio error', { error: (e as Error).message });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
  }
}
