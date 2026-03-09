// ── Client → Server ──────────────────────────────────────────────────────────

export type ControlOp = 'start' | 'mute' | 'unmute' | 'end';

export interface ControlMessage {
  type: 'control';
  op: ControlOp;
}

export interface AudioMessage {
  type: 'audio';
  pcmBase64: string;
  sampleRate: number;
  channels: number;
}

export type ClientMessage = ControlMessage | AudioMessage;

// ── Server → Client ──────────────────────────────────────────────────────────

export type StateValue = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface StateMessage {
  type: 'state';
  value: StateValue;
}

export interface PartialTranscriptMessage {
  type: 'partial_transcript';
  speaker: 'user' | 'assistant';
  text: string;
}

export interface FinalTranscriptMessage {
  type: 'final_transcript';
  speaker: 'user' | 'assistant';
  text: string;
}

export interface AudioReplyMessage {
  type: 'audio_reply';
  pcmBase64: string;
  sampleRate: number;
  channels: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | StateMessage
  | PartialTranscriptMessage
  | FinalTranscriptMessage
  | AudioReplyMessage
  | ErrorMessage;

// ── Type guards ───────────────────────────────────────────────────────────────

const CONTROL_OPS = new Set<string>(['start', 'mute', 'unmute', 'end']);

export function isControlMessage(msg: unknown): msg is ControlMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as ControlMessage).type === 'control' &&
    CONTROL_OPS.has((msg as ControlMessage).op)
  );
}

export function isAudioMessage(msg: unknown): msg is AudioMessage {
  const m = msg as AudioMessage;
  return (
    typeof msg === 'object' &&
    msg !== null &&
    m.type === 'audio' &&
    typeof m.pcmBase64 === 'string' &&
    typeof m.sampleRate === 'number' &&
    typeof m.channels === 'number'
  );
}
