import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Merchant, MERCHANT_COUNTRIES, MERCHANT_LANGUAGES, PHONE_RE } from "@ecom/db";
import { env } from "../env.js";
import {
  loginLimiter,
  passwordResetLimiter,
  signupLimiter,
} from "../middleware/rateLimit.js";
import {
  buildPasswordResetEmail,
  buildVerifyEmail,
  sendEmail,
  webUrl,
} from "../lib/email.js";
import { writeAudit } from "../lib/audit.js";
import { sendPasswordResetAlertSms } from "../lib/sms/index.js";
import {
  createSession,
  revokeAllSessions,
  revokeSession,
  rotateSession,
} from "../lib/sessionStore.js";

export const authRouter: Router = Router();

// Lifetime split — short-lived access (1h) limits the blast radius of a
// stolen token; refresh (14d) gives the merchant a usable browser session
// without nightly logins. Refresh tokens are HttpOnly so JS cannot read
// them; the access cookie is also HttpOnly (no JS path needed since CSRF
// is enforced via the double-submit token below).
const ACCESS_TOKEN_TTL_S = 60 * 60; // 1h
const REFRESH_TOKEN_TTL_S = 14 * 24 * 60 * 60; // 14d
const ACCESS_COOKIE = "access_token";
const REFRESH_COOKIE = "refresh_token";
const CSRF_COOKIE = "csrf_token";
const isProd = env.NODE_ENV === "production";

function cookieOpts(maxAgeSec: number, opts: { httpOnly?: boolean } = {}) {
  return {
    httpOnly: opts.httpOnly ?? true,
    secure: isProd,
    sameSite: "strict" as const,
    path: "/",
    maxAge: maxAgeSec * 1000,
  };
}

function issueAccessToken(
  merchant: { _id: unknown; email: string; role: string },
  sid: string,
) {
  return jwt.sign(
    {
      id: String(merchant._id),
      email: merchant.email,
      role: merchant.role,
      sid,
      typ: "access",
    },
    env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_S, algorithm: "HS256" },
  );
}

function issueRefreshToken(merchant: { _id: unknown }, sessionId: string) {
  return jwt.sign(
    { id: String(merchant._id), sid: sessionId, typ: "refresh" },
    env.JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_TTL_S, algorithm: "HS256" },
  );
}

/**
 * Mint cookies for a fresh session. Creates the sid in the session store
 * BEFORE issuing the JWTs so an immediate API call already has a valid
 * server-side anchor — there's no window where the client holds a JWT that
 * the store hasn't seen yet.
 *
 * Both access AND refresh tokens carry the same sid claim. The access path
 * uses it to short-circuit revocation (logout-all flips a session off and
 * every in-flight access JWT is dead within the next protected-procedure
 * cache miss).
 */
async function setAuthCookies(
  req: Request,
  res: Response,
  merchant: { _id: unknown; email: string; role: string },
  sessionId?: string,
): Promise<{ accessToken: string; csrfToken: string; sessionId: string }> {
  const ua = typeof req.headers["user-agent"] === "string"
    ? req.headers["user-agent"].slice(0, 500)
    : null;
  const ip = typeof req.ip === "string" ? req.ip : null;
  const sid =
    sessionId ??
    (await createSession({
      merchantId: String(merchant._id),
      ip,
      userAgent: ua,
      ttlSec: REFRESH_TOKEN_TTL_S,
    }));
  const accessToken = issueAccessToken(merchant, sid);
  const refreshToken = issueRefreshToken(merchant, sid);
  // Double-submit CSRF: random token in a non-HttpOnly cookie that the SPA
  // mirrors into the X-CSRF-Token header on mutations. Same-origin policy
  // keeps a third-party site from reading it; cross-site requests can carry
  // the cookie but cannot set the header to match.
  const csrfToken = randomBytes(24).toString("base64url");
  res.cookie(ACCESS_COOKIE, accessToken, cookieOpts(ACCESS_TOKEN_TTL_S, { httpOnly: true }));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts(REFRESH_TOKEN_TTL_S, { httpOnly: true }));
  res.cookie(CSRF_COOKIE, csrfToken, cookieOpts(ACCESS_TOKEN_TTL_S, { httpOnly: false }));
  return { accessToken, csrfToken, sessionId: sid };
}

function clearAuthCookies(res: Response) {
  const baseOpts = { path: "/", sameSite: "strict" as const, secure: isProd };
  res.clearCookie(ACCESS_COOKIE, baseOpts);
  res.clearCookie(REFRESH_COOKIE, baseOpts);
  res.clearCookie(CSRF_COOKIE, baseOpts);
}

function readCookieFromHeader(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const parts = raw.split(";");
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    if (p.slice(0, eq).trim() === name) {
      return decodeURIComponent(p.slice(eq + 1).trim());
    }
  }
  return null;
}

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  businessName: z.string().min(1),
  phone: z.string().regex(PHONE_RE).optional(),
  country: z.enum(MERCHANT_COUNTRIES).optional(),
  language: z.enum(MERCHANT_LANGUAGES).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const requestResetSchema = z.object({ email: z.string().email() });

const resetPasswordSchema = z.object({
  token: z.string().min(16).max(200),
  password: z.string().min(8).max(200),
});

const verifyEmailSchema = z.object({ token: z.string().min(16).max(200) });

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 60 minutes
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Mint a single-use token. The plaintext lives only in the email/URL; the DB
 * gets the SHA-256 so a leaked backup can't be replayed.
 */
function mintToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, hash };
}

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

async function fireVerificationEmail(merchant: {
  _id: unknown;
  email: string;
  businessName: string;
}): Promise<void> {
  const { plaintext, hash } = mintToken();
  await Merchant.updateOne(
    { _id: merchant._id },
    {
      $set: {
        emailVerification: {
          hash,
          expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
          requestedAt: new Date(),
        },
      },
    },
  );
  const verifyUrl = webUrl(`/verify-email?token=${encodeURIComponent(plaintext)}`);
  const tpl = buildVerifyEmail({
    businessName: merchant.businessName,
    verifyUrl,
  });
  await sendEmail({
    to: merchant.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    tag: "verify_email",
  });
}

authRouter.post("/signup", signupLimiter, async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password, businessName, phone, country, language } = parsed.data;

  const existing = await Merchant.findOne({ email });
  if (existing) return res.status(409).json({ error: "email already registered" });

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + env.TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const merchant = await Merchant.create({
    email,
    passwordHash,
    businessName,
    phone,
    country,
    language,
    emailVerified: false,
    subscription: {
      status: "trial",
      tier: "starter",
      startDate: now,
      trialEndsAt,
    },
  });

  // Best-effort verification email; never block signup on email failures so a
  // misconfigured RESEND_API_KEY doesn't lock new merchants out.
  void fireVerificationEmail(merchant).catch((err) =>
    console.error("[auth] verify email send failed", (err as Error).message),
  );

  // Funnel-event audit. Lets ops answer "how many signups landed today?"
  // by scanning AuditLog rather than diff-counting Merchant docs (which
  // also includes seed/admin-created accounts). `subjectType:"merchant"`
  // + `action:"auth.signup"` is the canonical signal for the activation
  // funnel measurement (signup → integration.connected → first_event).
  void writeAudit({
    merchantId: merchant._id as import("mongoose").Types.ObjectId,
    actorId: merchant._id as import("mongoose").Types.ObjectId,
    actorEmail: merchant.email,
    actorType: "merchant",
    action: "auth.signup",
    subjectType: "merchant",
    subjectId: merchant._id as import("mongoose").Types.ObjectId,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
    meta: {
      country: merchant.country,
      language: merchant.language,
      hasPhone: Boolean(phone),
      tier: "starter",
      trialEndsAt,
    },
  });

  const { accessToken, csrfToken } = await setAuthCookies(req, res, merchant);
  res.json({
    id: String(merchant._id),
    email: merchant.email,
    name: merchant.businessName,
    role: merchant.role,
    token: accessToken,
    csrfToken,
  });
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const merchant = await Merchant.findOne({ email: parsed.data.email });
  if (!merchant) return res.status(401).json({ error: "invalid credentials" });

  const ok = await bcrypt.compare(parsed.data.password, merchant.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  const { accessToken, csrfToken } = await setAuthCookies(req, res, merchant);
  res.json({
    id: String(merchant._id),
    email: merchant.email,
    name: merchant.businessName,
    role: merchant.role,
    token: accessToken,
    csrfToken,
  });
});

/**
 * Refresh the access cookie using the long-lived refresh cookie. The sid
 * claim on the inbound refresh JWT MUST exist in the session store — this
 * is what closes the "stolen refresh token" hole (without the store the
 * JWT alone is enough). On success we ROTATE: revoke the old sid, mint a
 * new one. So a captured refresh token used after the legitimate user has
 * also refreshed is rejected — there's only ever one valid sid per session
 * at a time.
 */
authRouter.post("/refresh", async (req, res) => {
  const refreshToken = readCookieFromHeader(req, REFRESH_COOKIE);
  if (!refreshToken) {
    clearAuthCookies(res);
    return res.status(401).json({ error: "no refresh token" });
  }
  let claims: { id: string; sid?: string; typ?: string };
  try {
    claims = jwt.verify(refreshToken, env.JWT_SECRET, {
      algorithms: ["HS256"],
    }) as { id: string; sid?: string; typ?: string };
  } catch {
    clearAuthCookies(res);
    return res.status(401).json({ error: "invalid refresh token" });
  }
  if (claims.typ !== "refresh" || !claims.sid) {
    clearAuthCookies(res);
    return res.status(401).json({ error: "wrong token type" });
  }
  // Always re-load the merchant so a role change / disable / deletion takes
  // effect on the next refresh, not 14 days later.
  const merchant = await Merchant.findById(claims.id)
    .select("_id email role businessName")
    .lean();
  if (!merchant) {
    clearAuthCookies(res);
    return res.status(401).json({ error: "account not found" });
  }
  // Rotate: drops the old sid + mints a new one. If the old sid is gone
  // (revoked, expired, never existed) the rotation returns null and we
  // refuse — caller must re-authenticate.
  const ua = typeof req.headers["user-agent"] === "string"
    ? req.headers["user-agent"].slice(0, 500)
    : null;
  const newSid = await rotateSession({
    merchantId: String(merchant._id),
    oldSid: claims.sid,
    ip: typeof req.ip === "string" ? req.ip : null,
    userAgent: ua,
    ttlSec: REFRESH_TOKEN_TTL_S,
  });
  if (!newSid) {
    clearAuthCookies(res);
    return res.status(401).json({ error: "session revoked" });
  }
  const { accessToken, csrfToken } = await setAuthCookies(
    req,
    res,
    { _id: merchant._id, email: merchant.email, role: merchant.role },
    newSid,
  );
  res.json({
    id: String(merchant._id),
    email: merchant.email,
    role: merchant.role,
    token: accessToken,
    csrfToken,
  });
});

/**
 * Single-session logout. Revokes the sid encoded in the refresh cookie so
 * even if an attacker holds the same cookies, the next access path that
 * checks the store will reject. Other devices stay logged in.
 */
authRouter.post("/logout", async (req, res) => {
  const refreshToken = readCookieFromHeader(req, REFRESH_COOKIE);
  if (refreshToken) {
    try {
      const claims = jwt.verify(refreshToken, env.JWT_SECRET, {
        algorithms: ["HS256"],
      }) as { id?: string; sid?: string };
      if (claims?.id && claims?.sid) {
        await revokeSession(claims.id, claims.sid);
      }
    } catch {
      /* a forged/expired token still gets the cookie cleared below */
    }
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

/**
 * Force log-out from every device. Single button on the Settings page —
 * the merchant just clicked "I think someone else is in my account". We
 * scrub every sid for this merchant, so any in-flight access JWT is dead
 * within the protected-procedure cache window (≤30 s).
 *
 * Authenticates via the access cookie/Bearer rather than the refresh
 * cookie, because the merchant might be on a fresh device that just
 * logged in and only has a short-lived access token.
 */
authRouter.post("/logout-all", async (req, res) => {
  const accessToken =
    readCookieFromHeader(req, ACCESS_COOKIE) ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null);
  if (!accessToken) {
    clearAuthCookies(res);
    return res.status(401).json({ error: "not authenticated" });
  }
  let claims: { id?: string };
  try {
    claims = jwt.verify(accessToken, env.JWT_SECRET, {
      algorithms: ["HS256"],
    }) as { id?: string };
  } catch {
    clearAuthCookies(res);
    return res.status(401).json({ error: "invalid token" });
  }
  if (!claims.id) {
    clearAuthCookies(res);
    return res.status(401).json({ error: "invalid token" });
  }
  const revoked = await revokeAllSessions(claims.id);
  void writeAudit({
    merchantId: claims.id as unknown as import("mongoose").Types.ObjectId,
    actorId: claims.id as unknown as import("mongoose").Types.ObjectId,
    actorType: "merchant",
    action: "auth.logout_all",
    subjectType: "merchant",
    subjectId: claims.id as unknown as import("mongoose").Types.ObjectId,
    meta: { revoked, ip: req.ip ?? null },
  });
  clearAuthCookies(res);
  res.json({ ok: true, revoked });
});

/**
 * Always responds 200 — never reveals whether an email is registered. The
 * Resend send happens in the background so timing is mostly invariant too.
 */
authRouter.post("/request-reset", passwordResetLimiter, async (req, res) => {
  const parsed = requestResetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const merchant = await Merchant.findOne({ email: parsed.data.email });
  if (merchant) {
    const { plaintext, hash } = mintToken();
    await Merchant.updateOne(
      { _id: merchant._id },
      {
        $set: {
          passwordReset: {
            hash,
            expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
            requestedAt: new Date(),
            requestedFromIp: typeof req.ip === "string" ? req.ip.slice(0, 64) : undefined,
          },
        },
      },
    );
    const resetUrl = webUrl(`/reset-password?token=${encodeURIComponent(plaintext)}`);
    const tpl = buildPasswordResetEmail({
      businessName: merchant.businessName,
      resetUrl,
      ip: req.ip ?? null,
    });
    void sendEmail({
      to: merchant.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: "password_reset",
    }).catch((err) => console.error("[auth] reset email send failed", (err as Error).message));

    // Side-channel SMS alert (BD merchants live on their phones). Never
    // includes the reset link itself — that stays in email — only a
    // notice that an attempt happened, so the merchant can react fast
    // if it was not them. Best-effort, never blocks the response.
    if (merchant.phone) {
      void sendPasswordResetAlertSms(merchant.phone, {
        brand: merchant.businessName,
        ip: typeof req.ip === "string" ? req.ip : null,
      }).catch((err) =>
        console.error("[auth] reset SMS alert failed", (err as Error).message),
      );
    }
    void writeAudit({
      merchantId: merchant._id,
      actorId: merchant._id,
      actorType: "merchant",
      action: "auth.reset_requested",
      subjectType: "merchant",
      subjectId: merchant._id,
      meta: { ip: req.ip ?? null },
    });
  }

  // Identical response shape for known/unknown emails.
  res.json({ ok: true });
});

authRouter.post("/reset-password", passwordResetLimiter, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const hash = hashToken(parsed.data.token);
  const merchant = await Merchant.findOne({
    "passwordReset.hash": hash,
    "passwordReset.expiresAt": { $gt: new Date() },
    "passwordReset.consumedAt": { $exists: false },
  });
  if (!merchant) {
    return res.status(400).json({ error: "invalid or expired token" });
  }

  merchant.passwordHash = await bcrypt.hash(parsed.data.password, 10);
  merchant.passwordReset = {
    hash,
    expiresAt: merchant.passwordReset?.expiresAt ?? new Date(),
    requestedAt: merchant.passwordReset?.requestedAt ?? new Date(),
    requestedFromIp: merchant.passwordReset?.requestedFromIp,
    consumedAt: new Date(),
  } as typeof merchant.passwordReset;
  await merchant.save();

  // Reset implies "I lost control of this account" — every existing session
  // must die. Without this, an attacker who already minted a refresh token
  // keeps access for 14 days even after the password is changed.
  const revoked = await revokeAllSessions(String(merchant._id));

  void writeAudit({
    merchantId: merchant._id,
    actorId: merchant._id,
    actorType: "merchant",
    action: "auth.password_reset",
    subjectType: "merchant",
    subjectId: merchant._id,
    meta: { ip: req.ip ?? null, sessionsRevoked: revoked },
  });

  res.json({ ok: true, email: merchant.email });
});

authRouter.post("/verify-email", async (req, res) => {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const hash = hashToken(parsed.data.token);
  const merchant = await Merchant.findOne({
    "emailVerification.hash": hash,
    "emailVerification.expiresAt": { $gt: new Date() },
  });
  if (!merchant) return res.status(400).json({ error: "invalid or expired token" });

  if (!merchant.emailVerified) {
    merchant.emailVerified = true;
    void writeAudit({
      merchantId: merchant._id,
      actorId: merchant._id,
      actorType: "merchant",
      action: "auth.email_verified",
      subjectType: "merchant",
      subjectId: merchant._id,
      meta: {},
    });
  }
  // Single-use: stamp consumedAt so a stolen link can't be replayed.
  merchant.emailVerification = {
    hash,
    expiresAt: merchant.emailVerification?.expiresAt ?? new Date(),
    requestedAt: merchant.emailVerification?.requestedAt ?? new Date(),
    consumedAt: new Date(),
  } as typeof merchant.emailVerification;
  await merchant.save();

  res.json({ ok: true });
});

const resendVerifySchema = z.object({ email: z.string().email() });

authRouter.post("/resend-verification", passwordResetLimiter, async (req, res) => {
  const parsed = resendVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const merchant = await Merchant.findOne({ email: parsed.data.email });
  if (merchant && !merchant.emailVerified) {
    void fireVerificationEmail(merchant).catch((err) =>
      console.error("[auth] resend verify failed", (err as Error).message),
    );
  }
  res.json({ ok: true });
});
