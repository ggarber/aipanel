// Panel codes: 8 characters, uppercase letters and digits.

export const CODE_LENGTH = 8;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_RE = /^[A-Z0-9]{8}$/;

export function isPanelCode(value: string): boolean {
  return CODE_RE.test(value);
}

// Uppercases and drops anything that can't be part of a code (spaces, dashes…).
export function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
}

export function generateCode(): string {
  const out: string[] = [];
  const bytes = new Uint8Array(16);
  while (out.length < CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    // 252 = 7 * 36: rejecting higher bytes keeps every character equally likely.
    for (const b of bytes) if (b < 252 && out.length < CODE_LENGTH) out.push(ALPHABET[b % 36]);
  }
  return out.join("");
}
