import { createHash } from "node:crypto";
import { Router } from "express";
import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { ALLOWED_ASSET_MIME, ASSET_ID_RE, MAX_ASSET_BYTES } from "@ecom/landing";
import { LandingAsset } from "@ecom/db";

type AssetMime = (typeof ALLOWED_ASSET_MIME)[number];

/**
 * Identify an image by its leading bytes. The declared content type is
 * never trusted: a file is stored only if its bytes are one of the four
 * raster formats below. SVG (script-capable), HTML, PDFs and polyglots
 * that do not start with a raster signature are all rejected.
 */
export function sniffImageMime(buf: Buffer): AssetMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

const DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

export async function storeLandingAsset(input: {
  merchantId: Types.ObjectId;
  actorId: Types.ObjectId;
  dataUrl: string;
}): Promise<{ id: string; mime: AssetMime; bytes: number; deduplicated: boolean }> {
  const m = DATA_URL_RE.exec(input.dataUrl);
  if (!m) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload must be a base64 image data URL" });
  const declared = m[1]!;
  if (!(ALLOWED_ASSET_MIME as readonly string[]).includes(declared)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Only PNG, JPEG, WebP and GIF images are allowed" });
  }
  const buf = Buffer.from(m[2]!, "base64");
  if (buf.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Empty file" });
  if (buf.length > MAX_ASSET_BYTES) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Images must be ${Math.round(MAX_ASSET_BYTES / 1024)} KB or smaller`,
    });
  }
  const mime = sniffImageMime(buf);
  if (!mime) throw new TRPCError({ code: "BAD_REQUEST", message: "File content is not a supported image" });

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const existing = await LandingAsset.findOne({ merchantId: input.merchantId, sha256 }).select("_id mime bytes").lean();
  if (existing) {
    return { id: String(existing._id), mime: existing.mime as AssetMime, bytes: existing.bytes, deduplicated: true };
  }
  const doc = await LandingAsset.create({
    merchantId: input.merchantId,
    mime,
    bytes: buf.length,
    sha256,
    data: buf,
    createdBy: input.actorId,
  });
  return { id: String(doc._id), mime, bytes: buf.length, deduplicated: false };
}

/** Walk content and collect every referenced asset id. */
export function collectAssetIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectAssetIds(v, out);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.assetId === "string") out.add(obj.assetId);
    for (const v of Object.values(obj)) collectAssetIds(v, out);
  }
  return out;
}

/**
 * Every image a page references must belong to the page's merchant. Stops
 * one tenant embedding (or probing for) another tenant's uploads.
 */
export async function assertAssetsOwned(merchantId: Types.ObjectId, content: unknown): Promise<void> {
  const ids = [...collectAssetIds(content)];
  if (!ids.length) return;
  if (ids.some((id) => !ASSET_ID_RE.test(id))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid image reference" });
  }
  const owned = await LandingAsset.countDocuments({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    merchantId,
  });
  if (owned !== ids.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "One or more images were not found in your library" });
  }
}

/**
 * GET /api/landing-assets/:id — serves stored bytes. Assets are public
 * (they appear on public pages). The response is locked down so a stored
 * file can only ever be treated as an image: fixed content type from the
 * sniffed mime, nosniff, a deny-all CSP, and no cookies read.
 */
export const landingAssetRouter: Router = Router();

landingAssetRouter.get("/:id", async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!ASSET_ID_RE.test(id)) {
    res.status(404).end();
    return;
  }
  try {
    const asset = await LandingAsset.findById(id).select("mime data sha256").lean();
    if (!asset) {
      res.status(404).end();
      return;
    }
    const data = Buffer.isBuffer(asset.data)
      ? asset.data
      : Buffer.from((asset.data as unknown as { buffer: ArrayBuffer }).buffer);
    res.setHeader("Content-Type", asset.mime);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", "inline");
    // Pages and the dashboard live on other origins than the API.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", `"${asset.sha256}"`);
    res.status(200).end(data);
  } catch (err) {
    console.error("[landing-assets] read failed", (err as Error).message);
    res.status(500).end();
  }
});
