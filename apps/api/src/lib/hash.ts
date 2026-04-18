import { createHash } from "node:crypto";

export function filterHash(obj: unknown): string {
  return createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 12);
}
