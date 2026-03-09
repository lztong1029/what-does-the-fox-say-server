export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function safeParseJson(raw: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
