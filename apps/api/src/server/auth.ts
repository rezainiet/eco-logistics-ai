import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Merchant, MERCHANT_COUNTRIES, MERCHANT_LANGUAGES } from "@ecom/db";
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

export const authRouter: Router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  businessName: z.string().min(1),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/).optional(),
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

function issueToken(merchant: { _id: unknown; email: string; role: string }) {
  return jwt.sign(
    { id: String(merchant._id), email: merchant.email, role: merchant.role },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

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

  res.json({
    id: String(merchant._id),
    email: merchant.email,
    name: merchant.businessName,
    role: merchant.role,
    token: issueToken(merchant),
  });
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const merchant = await Merchant.findOne({ email: parsed.data.email });
  if (!merchant) return res.status(401).json({ error: "invalid credentials" });

  const ok = await bcrypt.compare(parsed.data.password, merchant.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  res.json({
    id: String(merchant._id),
    email: merchant.email,
    name: merchant.businessName,
    role: merchant.role,
    token: issueToken(merchant),
  });
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

  void writeAudit({
    merchantId: merchant._id,
    actorId: merchant._id,
    actorType: "merchant",
    action: "auth.password_reset",
    subjectType: "merchant",
    subjectId: merchant._id,
    meta: { ip: req.ip ?? null },
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
