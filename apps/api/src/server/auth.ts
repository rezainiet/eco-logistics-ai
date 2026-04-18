import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Merchant, MERCHANT_COUNTRIES, MERCHANT_LANGUAGES } from "@ecom/db";
import { env } from "../env.js";
import { loginLimiter, signupLimiter } from "../middleware/rateLimit.js";

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

function issueToken(merchant: { _id: unknown; email: string; role: string }) {
  return jwt.sign(
    { id: String(merchant._id), email: merchant.email, role: merchant.role },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

authRouter.post("/signup", signupLimiter, async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password, businessName, phone, country, language } = parsed.data;

  const existing = await Merchant.findOne({ email });
  if (existing) return res.status(409).json({ error: "email already registered" });

  const passwordHash = await bcrypt.hash(password, 10);
  const merchant = await Merchant.create({ email, passwordHash, businessName, phone, country, language });

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
