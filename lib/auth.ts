import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const AUTH_COOKIE = "genui_auth";
const AUTH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Fails closed: with no APP_PASSWORD configured nobody can sign in.
function password(): string | null {
  return process.env.APP_PASSWORD || null;
}

function hmac(key: string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

// The cookie holds a value derived from the password, so changing APP_PASSWORD
// signs everyone out.
function sessionToken(pw: string): string {
  return hmac(pw, "aipanel-auth-v1").toString("hex");
}

export function checkPassword(attempt: string): boolean {
  const pw = password();
  if (!pw) return false;
  // Compare fixed-length digests so neither content nor length leaks through timing.
  return timingSafeEqual(hmac("aipanel-pw", attempt), hmac("aipanel-pw", pw));
}

export async function isAuthenticated(): Promise<boolean> {
  // Read cookies before anything else so the page always renders per request
  // (an early return here would let the build prerender the login form).
  const value = (await cookies()).get(AUTH_COOKIE)?.value;
  const pw = password();
  if (!pw || !value) return false;
  const expected = Buffer.from(sessionToken(pw));
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function setAuthCookie() {
  const pw = password();
  if (!pw) return;
  (await cookies()).set(AUTH_COOKIE, sessionToken(pw), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE,
  });
}
