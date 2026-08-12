import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Gate every `/api/*` route behind one shared token, checked via
 * `Authorization: Bearer <token>`.
 *
 * This is deliberately not a multi-user system — just the fix for a
 * dashboard that otherwise lets anyone who finds the URL spend credits,
 * dispatch ships, or repoint the Discord webhook. Per-operator API keys are
 * a separate, larger piece of work.
 *
 * When `token` is undefined the gate is a no-op — the caller is expected to
 * warn loudly about running unauthenticated rather than silently refuse to
 * start, so a first `npm start` with no `.env` still works.
 */
export function createAuthMiddleware(token: string | undefined): RequestHandler {
  if (!token) return (_req, _res, next) => next();
  // Hash both sides to a fixed 32-byte digest before comparing: timingSafeEqual
  // throws on a length mismatch, and a presented token of the wrong length is
  // exactly the input an attacker controls, so the raw values can never be
  // compared directly.
  const expected = createHash("sha256").update(token).digest();
  return (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (presented) {
      const actual = createHash("sha256").update(presented).digest();
      if (timingSafeEqual(actual, expected)) return next();
    }
    res.status(401).json({ error: "unauthorized" });
  };
}
