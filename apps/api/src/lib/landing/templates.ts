import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { Types } from "mongoose";
import {
  SYSTEM_TEMPLATES,
  type TemplateSpec,
  canonicalJson,
  parseTemplateSpec,
} from "@ecom/landing";
import { LandingPageTemplate, LandingPageTemplateVersion } from "@ecom/db";

export function specHash(spec: TemplateSpec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

export interface LoadedVersion {
  id: string;
  templateId: string;
  version: number;
  status: "draft" | "published";
  spec: TemplateSpec;
}

/**
 * Published versions are immutable, so they are cached indefinitely (LRU
 * bounded). Drafts are never cached — an admin may be editing them.
 */
const publishedCache = new LRUCache<string, LoadedVersion>({ max: 500 });

export function __resetTemplateCacheForTests(): void {
  publishedCache.clear();
}

export async function loadTemplateVersion(id: Types.ObjectId | string): Promise<LoadedVersion | null> {
  const key = String(id);
  const hit = publishedCache.get(key);
  if (hit) return hit;
  if (!Types.ObjectId.isValid(key)) return null;
  const row = await LandingPageTemplateVersion.findById(key).lean();
  if (!row) return null;
  // Stored specs were validated on write; re-validate anyway so a corrupted
  // row can never reach the renderer as a "trusted" spec.
  const parsed = parseTemplateSpec(row.spec);
  if (!parsed.ok) {
    console.error(`[landing] template version ${key} has an invalid spec`, parsed.issues.slice(0, 3));
    return null;
  }
  const loaded: LoadedVersion = {
    id: key,
    templateId: String(row.templateId),
    version: row.version,
    status: row.status as LoadedVersion["status"],
    spec: parsed.spec,
  };
  if (loaded.status === "published") publishedCache.set(key, loaded);
  return loaded;
}

/**
 * Idempotently mirror the code-defined system templates into Mongo.
 *
 * - Missing template → created with version 1 published, status active.
 * - Code spec changed (hash differs from the current published version) →
 *   a NEW version is published and becomes current. Existing pages stay
 *   pinned to their old version.
 * - Unchanged → no writes.
 *
 * Admin status choices (disable/archive) are preserved across reseeds.
 */
export async function ensureSystemTemplates(): Promise<{ created: number; versioned: number }> {
  let created = 0;
  let versioned = 0;
  for (const [idx, def] of SYSTEM_TEMPLATES.entries()) {
    const parsed = parseTemplateSpec(def.spec);
    if (!parsed.ok) {
      console.error(`[landing] system template "${def.key}" has an invalid spec — skipped`, parsed.issues);
      continue;
    }
    const hash = specHash(parsed.spec);
    let tpl = await LandingPageTemplate.findOne({ key: def.key });
    if (!tpl) {
      try {
        tpl = await LandingPageTemplate.create({
          key: def.key,
          name: def.name,
          description: def.description,
          category: def.category,
          origin: "system",
          status: "active",
          latestVersion: 0,
          sortOrder: idx,
        });
        created += 1;
      } catch (err) {
        // Another replica won the race; continue with its row.
        if ((err as { code?: number }).code !== 11000) throw err;
        tpl = await LandingPageTemplate.findOne({ key: def.key });
        if (!tpl) continue;
      }
    } else if (tpl.origin !== "system") {
      console.error(`[landing] template key "${def.key}" is taken by a custom template — system seed skipped`);
      continue;
    }

    const current = tpl.currentVersionId
      ? await LandingPageTemplateVersion.findById(tpl.currentVersionId).select("specHash").lean()
      : null;
    if (current?.specHash === hash) continue;

    // Allocate the next version number atomically.
    const bumped = await LandingPageTemplate.findOneAndUpdate(
      { _id: tpl._id },
      { $inc: { latestVersion: 1 } },
      { new: true },
    ).lean();
    if (!bumped) continue;
    const version = await LandingPageTemplateVersion.create({
      templateId: tpl._id,
      version: bumped.latestVersion,
      status: "published",
      spec: parsed.spec,
      specVersion: parsed.spec.specVersion,
      specHash: hash,
      publishedAt: new Date(),
      notes: "System template seed",
    });
    await LandingPageTemplate.updateOne(
      { _id: tpl._id },
      {
        $set: {
          currentVersionId: version._id,
          currentVersion: version.version,
          name: def.name,
          description: def.description,
          category: def.category,
        },
      },
    );
    versioned += 1;
  }
  return { created, versioned };
}
