export type TerminalInput = {
  text?: string;
  key?: string;
  ctrl?: boolean;
  alt?: boolean;
};

export type TerminalInputActivityDetail =
  | { key: string; ctrl: boolean; alt: boolean }
  | { text_length: number };

export function terminalInputActivityDetail(input: TerminalInput): TerminalInputActivityDetail {
  return typeof input.key === "string"
    ? { key: input.key, ctrl: input.ctrl === true, alt: input.alt === true }
    : { text_length: typeof input.text === "string" ? Array.from(input.text).length : 0 };
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  BTab: "BTab",
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
};

export const MAX_TERMINAL_INPUT_LENGTH = 2000;

function escapeTerminalTmuxSemicolon(text: string): string {
  return text.endsWith(";") ? `${text.slice(0, -1)}\\;` : text;
}

function inputError(message: string): never {
  throw new Error(`invalid terminal input: ${message}`);
}

export function mapTerminalInput(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return inputError("input must be an object");
  const value = input as Record<string, unknown>;
  const hasText = Object.prototype.hasOwnProperty.call(value, "text");
  const hasKey = Object.prototype.hasOwnProperty.call(value, "key");
  const text = value.text;
  const key = value.key;
  if (Object.prototype.hasOwnProperty.call(value, "ctrl") && typeof value.ctrl !== "boolean") return inputError("ctrl must be a boolean");
  if (Object.prototype.hasOwnProperty.call(value, "alt") && typeof value.alt !== "boolean") return inputError("alt must be a boolean");
  const ctrl = value.ctrl === true;
  const alt = value.alt === true;

  if (hasText) {
    if (typeof text !== "string") return inputError("text must be a string");
    if (Array.from(text).length > MAX_TERMINAL_INPUT_LENGTH) return inputError(`text exceeds ${MAX_TERMINAL_INPUT_LENGTH} characters`);
    if (hasKey || ctrl || alt) return inputError("text cannot be combined with a key or modifier");
    return ["-l", "", escapeTerminalTmuxSemicolon(text)];
  }
  if (!hasKey || typeof key !== "string" || key.length === 0) return inputError("a text or whitelisted key is required");
  if (ctrl && alt) return inputError("ctrl and alt cannot be combined");
  if (ctrl || alt) {
    if (Array.from(key).length !== 1 || !/^[\x20-\x7e]$/.test(key)) return inputError("modifier combinations require one printable character");
    return [`${ctrl ? "C" : "M"}-${key}`];
  }
  const mapped = NAMED_KEYS[key];
  if (!mapped) return inputError(`unknown key ${JSON.stringify(key)}`);
  return [mapped];
}

export const terminalInputArgs = mapTerminalInput;
