import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Merchant, MERCHANT_COUNTRIES, MERCHANT_LANGUAGES, PHONE_RE, Integration } from "@ecom/db";
import { env } from "../env.js";
import {
  exchangeSessionTokenForOfflineToken,
  registerShopifyWebhooks,
  verifyShopifyAppBridgeSessionToken,
} from "../lib/integrations/shopify.js";
import { encryptSecret } from "../lib/crypto.js";
import {
  loginLimiter,
  passwordResetLimiter,
  signupLimiter,
} from "../middleware/rateLimit.js";
import {
  buildPasswordResetEmail,
  buildVerifyEmail,
  webUrl,
} from "../lib/email.js";
import { enqueueEmail } from "../workers/email.worker.js";
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
  // Enqueue rather than send-inline: signup HTTP response no longer
  // blocks on Resend HTTP latency (typically 100–500ms). The hash
  // prefix correlates the send with this specific token mint so a
  // spam-clicked "resend verify" within the BullMQ retention window
  // mints a new token (new correlation id) and queues a fresh email
  // — repeated clicks for the same token collapse on `jobId`.
  await enqueueEmail({
    correlationId: `verify:${String(merchant._id)}:${hash.slice(0, 12)}`,
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
    // Enqueue (durable + retried). Correlated on the token hash so
    // rapid double-clicks on "Send reset link" collapse to one Resend
    // call, but a genuinely new reset request (new token) enqueues
    // afresh. The HTTP response stays the timing-invariant 200.
    void enqueueEmail({
      correlationId: `reset:${String(merchant._id)}:${hash.slice(0, 12)}`,
      to: merchant.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: "password_reset",
    }).catch((err) =>
      console.error("[auth] reset email enqueue failed", (err as Error).message),
    );

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

/**
 * App Bridge session-token exchange — embedded-app auth bridge.
 *
 * Phase B B3 of the Shopify embedded-app migration. Accepts a Shopify
 * session token (HS256-signed JWT minted by App Bridge inside the iframe
 * and forwarded to us by the SPA) and returns OUR access token in
 * exactly the same JSON shape as `/auth/login` so the SPA's existing
 * tRPC client can consume it without branching.
 *
 * Phase B scope (deliberately limited):
 *
 *   - Verifies the session token signature, audience, issuer, and
 *     freshness via verifyShopifyAppBridgeSessionToken().
 *   - Looks up the Integration row by accountKey == shop. The shop is
 *     extracted from the verified `dest` claim — never trusted from
 *     the request body.
 *   - If the Integration row exists and is connected to a merchant,
 *     mints OUR JWT for that merchant via the same setAuthCookies()
 *     used by /auth/login. Cookie + body parity with the existing
 *     login response means the SPA already knows how to consume it.
 *   - If NO Integration row matches, returns 404 with
 *     `{ error: "no_integration_for_shop" }`. Phase C extends this
 *     branch to auto-provision a Merchant + Integration via the
 *     Token Exchange offline-token flow. Phase B intentionally
 *     stops here so the change is small and reversible.
 *
 * What this endpoint does NOT do (yet):
 *
 *   - Auto-create a Merchant for first-time embedded installs. Phase C.
 *   - Call exchangeSessionTokenForOfflineToken() to mint an offline
 *     access token. Phase C, only when auto-provisioning.
 *   - Set non-strict-SameSite cookies for cross-origin iframe usage.
 *     The existing strict cookies are still set (harmless inside the
 *     iframe; the SPA reads the bearer token from the JSON body).
 *     Phase D revisits cookie SameSite when CSP changes.
 *   - Replace any existing /auth/login or /auth/refresh code path.
 *     Both stay live for the direct (non-iframe) entry.
 *
 * Production stability: this endpoint is additive. No existing route
 * or handler is modified. Removing it (or reverting Phase B entirely)
 * has no behaviour change on the non-embedded surface.
 */
const shopifyExchangeSchema = z.object({
  sessionToken: z.string().min(20).max(4096),
});

authRouter.post("/shopify/exchange", async (req, res) => {
  // Sanity: refuse to operate without app credentials. In dev, an
  // operator running without SHOPIFY_APP_API_KEY/_SECRET env values
  // gets a 503 here so the failure mode is "configure the env" rather
  // than a confusing 401. Production envs always have these set.
  const apiKey = env.SHOPIFY_APP_API_KEY ?? "";
  const apiSecret = env.SHOPIFY_APP_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    console.error(
      "[auth/shopify/exchange] SHOPIFY_APP_API_KEY / SHOPIFY_APP_API_SECRET unset",
    );
    return res
      .status(503)
      .json({ error: "embedded_auth_not_configured" });
  }

  const parsed = shopifyExchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_session_token_request" });
  }

  // Verify Shopify session token. The verifier rejects:
  // - bad/missing signature
  // - aud mismatch (token minted for a different app)
  // - iss/dest mismatch with .myshopify.com hostname
  // - sub/exp/aud claim absence
  let claims;
  try {
    claims = verifyShopifyAppBridgeSessionToken({
      token: parsed.data.sessionToken,
      apiKey,
      apiSecret,
    });
  } catch (err) {
    // Log the specific gate failure on the server but never return it
    // to the client — a noisy 401 reason is a fingerprint helper for
    // attackers iterating on forged tokens.
    console.warn("[auth/shopify/exchange] session token rejected", {
      err: (err as Error).message.slice(0, 200),
    });
    return res.status(401).json({ error: "invalid_session_token" });
  }

  // Look up the Integration row for this shop. The verified `dest`
  // claim is the only source of truth for the shop identity — never
  // trust a body-supplied `shop` field.
  const shop = claims.shop;
  // Narrow type for the integration reference the rest of this
  // handler actually uses. Both the findOne().lean() result and the
  // auto-provision branch's upsert payload satisfy this shape.
  type IntegrationRef = {
    _id: import("mongoose").Types.ObjectId;
    merchantId: import("mongoose").Types.ObjectId;
    provider: string;
    accountKey: string;
    status: string;
  };
  const initialIntegration = await Integration.findOne({
    provider: "shopify",
    accountKey: shop,
    // Accept either connected or pending — pending means the OAuth
    // grant happened but the merchant hasn't claimed yet, which is
    // exactly the window the embedded path can take over from.
    status: { $in: ["connected", "pending", "error"] },
  })
    .select("_id merchantId provider accountKey status")
    .lean();
  let integration: IntegrationRef | null = initialIntegration
    ? {
        _id: initialIntegration._id,
        merchantId: initialIntegration.merchantId,
        provider: initialIntegration.provider,
        accountKey: initialIntegration.accountKey,
        status: initialIntegration.status,
      }
    : null;

  // Auto-provision branch (Phase C C7). When no Integration exists for
  // this shop, the embedded path completes the install via Token
  // Exchange instead of bouncing the merchant back to the legacy
  // /api/shopify/install URL. The session token we already verified
  // is sufficient proof-of-merchant — Shopify will mint an offline
  // access token in exchange.
  //
  // Race protection: Merchant.create is the leader-election point.
  // If a concurrent request races us to create the merchant for the
  // same shop, the unique-email index throws and we re-fetch the
  // existing merchant. The Integration upsert keyed on
  // (merchantId, provider, accountKey) handles its own concurrency
  // via Mongo's atomic findOneAndUpdate.
  if (!integration) {
    let exchange;
    try {
      exchange = await exchangeSessionTokenForOfflineToken({
        shopDomain: shop,
        sessionToken: parsed.data.sessionToken,
        apiKey,
        apiSecret,
      });
    } catch (err) {
      console.warn(
        "[auth/shopify/exchange] auto-provision token exchange failed",
        { shop, err: (err as Error).message?.slice(0, 200) },
      );
      // Token Exchange failures are most often "this app isn't
      // configured for token exchange" or "session token expired
      // mid-flight" — both rare-but-recoverable. Surface a 502 so
      // the SPA can prompt a retry rather than silently 404'ing.
      return res.status(502).json({
        error: "token_exchange_failed",
        shop,
      });
    }

    // Synthesize a merchant row keyed on the shop. The email is
    // recognisable but un-routable; the password hash is random and
    // can never be matched by a credentials login (locking the
    // account to the embedded path). The merchant can update both
    // later from Settings → Workspace once they're in the dashboard.
    const shopSlug = shop.replace(/\.myshopify\.com$/i, "");
    const syntheticEmail = `embedded-${shopSlug}@confirmx.shop`.toLowerCase();
    const lockedPasswordHash = await bcrypt.hash(
      randomBytes(32).toString("base64url"),
      10,
    );
    const now = new Date();
    const trialEndsAt = new Date(
      now.getTime() + env.TRIAL_DAYS * 24 * 60 * 60 * 1000,
    );

    let merchantDoc;
    try {
      merchantDoc = await Merchant.create({
        email: syntheticEmail,
        passwordHash: lockedPasswordHash,
        businessName: shopSlug,
        emailVerified: true,
        subscription: {
          status: "trial",
          tier: "starter",
          startDate: now,
          trialEndsAt,
        },
      });
    } catch (err) {
      // Race: a sibling request just created this merchant. Re-fetch
      // by the synthetic email and continue.
      const e = err as { code?: number; message?: string };
      const isDuplicateEmail =
        e?.code === 11000 || (e?.message ?? "").includes("duplicate key");
      if (!isDuplicateEmail) {
        console.error(
          "[auth/shopify/exchange] merchant create failed",
          { shop, err: e?.message?.slice(0, 200) },
        );
        return res.status(500).json({ error: "merchant_provision_failed" });
      }
      const existing = await Merchant.findOne({ email: syntheticEmail });
      if (!existing) {
        return res.status(500).json({ error: "merchant_provision_race" });
      }
      merchantDoc = existing;
    }

    // Upsert the Integration row. Keyed on
    // (merchantId, provider, accountKey) which has a unique index;
    // findOneAndUpdate with upsert is atomic. If the Token Exchange
    // re-fired for any reason and the row already exists, we reuse
    // it and update its credentials in place.
    const credentialsPayload: Record<string, string | Date> = {
      apiKey: encryptSecret(apiKey),
      apiSecret: encryptSecret(apiSecret),
      siteUrl: shop,
      accessToken: encryptSecret(exchange.accessToken),
    };
    if (
      typeof exchange.refreshToken === "string" &&
      exchange.refreshToken
    ) {
      credentialsPayload.refreshToken = encryptSecret(exchange.refreshToken);
    }
    // Range-check expiresIn before persisting. Shopify documents a
    // typical 24h lifetime for expiring offline tokens; a value under
    // 60 seconds is almost certainly a protocol error and would trip
    // the lazy-refresh path on the very next API call, hot-looping
    // until Shopify rate-limits us. Reject the field entirely in that
    // case — the next API call falls back to the non-expiring code
    // path and we'll pick up a fresh expiresAt on the next exchange.
    if (
      typeof exchange.expiresIn === "number" &&
      Number.isFinite(exchange.expiresIn) &&
      exchange.expiresIn >= 60
    ) {
      credentialsPayload.accessTokenExpiresAt = new Date(
        Date.now() + exchange.expiresIn * 1000,
      );
    } else if (typeof exchange.expiresIn === "number") {
      console.warn(
        "[auth/shopify/exchange] suspicious expiresIn — not persisting",
        { shop, expiresIn: exchange.expiresIn },
      );
    }

    const upserted = await Integration.findOneAndUpdate(
      { merchantId: merchantDoc._id, provider: "shopify", accountKey: shop },
      {
        $set: {
          label: `Shopify · ${shop}`,
          status: "connected",
          credentials: credentialsPayload,
          permissions: exchange.scope
            ? exchange.scope.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          connectedAt: now,
          disconnectedAt: null,
          health: { ok: true, lastCheckedAt: now },
        },
        $setOnInsert: {
          merchantId: merchantDoc._id,
          provider: "shopify",
          accountKey: shop,
          createdAt: now,
        },
      },
      { upsert: true, new: true },
    );

    // Auto-register Shopify webhooks for this fresh embedded install.
    // Without this, the integration sits "connected" but Shopify never
    // POSTs to /api/integrations/webhook/shopify/{id} — order delivery
    // would silently fall back to the 5-min poll worker (up to 5 min
    // of delay). Mirrors the public OAuth callback's registration.
    //
    // Failures DON'T block the exchange (the token is still valid for
    // polling-mode imports); webhookStatus.lastError gets the detail
    // so the dashboard can show a yellow "Retry webhooks" banner.
    const callbackUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/webhook/shopify/${String(upserted._id)}`;
    try {
      const reg = await registerShopifyWebhooks({
        shopDomain: shop,
        accessToken: exchange.accessToken,
        callbackUrl,
      });
      console.log("[auth/shopify/exchange] webhooks registered", {
        shop,
        integrationId: String(upserted._id),
        allRegistered: reg.allRegistered,
        registered: reg.registered,
        errors: reg.errors,
      });
      await Integration.updateOne(
        { _id: upserted._id },
        {
          $set: {
            // Healthy only on FULL registration — partial success
            // (e.g. orders/* registered but app/uninstalled failed)
            // is an order-blind state if we flip it true.
            "webhookStatus.registered": reg.allRegistered,
            "webhookStatus.lastError":
              reg.errors.length > 0
                ? reg.errors.join("; ").slice(0, 500)
                : null,
          },
        },
      );
    } catch (err) {
      // Never fail the exchange on registration. The merchant can hit
      // retryShopifyWebhooks from the dashboard or operate in polling
      // mode if Shopify Admin API is briefly unreachable.
      console.warn(
        "[auth/shopify/exchange] webhook registration threw",
        { shop, err: (err as Error).message?.slice(0, 200) },
      );
      await Integration.updateOne(
        { _id: upserted._id },
        {
          $set: {
            "webhookStatus.registered": false,
            "webhookStatus.lastError": (err as Error).message.slice(0, 500),
          },
        },
      );
    }

    console.log("[auth/shopify/exchange] auto-provisioned", {
      shop,
      merchantId: String(merchantDoc._id),
      integrationId: String(upserted._id),
      hasRefreshToken: !!credentialsPayload.refreshToken,
      hasExpiresAt: !!credentialsPayload.accessTokenExpiresAt,
    });

    integration = {
      _id: upserted._id,
      merchantId: upserted.merchantId,
      provider: upserted.provider,
      accountKey: upserted.accountKey,
      status: upserted.status,
    } satisfies IntegrationRef;
  }

  // After the auto-provision branch, `integration` is guaranteed
  // non-null: either the initial findOne returned a row, or the
  // branch above re-bound it to the upserted document. The
  // assertion is a type-narrow for TS, not a runtime check — the
  // explicit `if (!integration)` would be unreachable, so we fail
  // loud only if the invariant breaks (which would be a
  // programming error).
  if (!integration) {
    console.error(
      "[auth/shopify/exchange] integration unset after auto-provision — invariant violated",
      { shop },
    );
    return res.status(500).json({ error: "integration_unresolved" });
  }

  // Resolve the Merchant. The integration row carries merchantId; load
  // the merchant so we can mint a JWT with the canonical email/role
  // claims (matches the /auth/login response shape).
  const merchant = await Merchant.findById(integration.merchantId)
    .select("_id email businessName role")
    .lean();
  if (!merchant) {
    // Defensive: an Integration row without a merchant is a data
    // integrity failure, not a normal flow. Surface as 410 so the
    // client knows the row is gone and shouldn't retry.
    console.error(
      "[auth/shopify/exchange] integration without merchant — data integrity",
      { shop, integrationId: String(integration._id) },
    );
    return res.status(410).json({ error: "merchant_missing" });
  }

  // Issue our JWT in the same shape as /auth/login. Sets cookies as a
  // side effect (useful for the direct path; harmless for the iframe
  // path since strict cookies are not sent cross-site). The SPA reads
  // the `token` field from the JSON body either way.
  const { accessToken, csrfToken } = await setAuthCookies(req, res, {
    _id: merchant._id,
    email: merchant.email,
    role: merchant.role,
  });

  void writeAudit({
    merchantId: merchant._id as import("mongoose").Types.ObjectId,
    actorId: merchant._id as import("mongoose").Types.ObjectId,
    actorEmail: merchant.email,
    actorType: "merchant",
    action: "auth.shopify_exchange",
    subjectType: "merchant",
    subjectId: merchant._id as import("mongoose").Types.ObjectId,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
    meta: {
      shop,
      integrationId: String(integration._id),
      sub: claims.sub,
      jti: claims.jti ?? null,
    },
  });

  res.json({
    id: String(merchant._id),
    email: merchant.email,
    name: merchant.businessName,
    role: merchant.role,
    token: accessToken,
    csrfToken,
    shop,
    integrationId: String(integration._id),
  });
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
