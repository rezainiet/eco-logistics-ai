/**
 * Deterministic BullMQ custom job ids.
 *
 * BullMQ 5.x rejects a custom `jobId` that contains ":" (it only tolerates
 * exactly three ":"-separated parts, for legacy repeatable keys) or that is
 * a plain integer. Ids like `email:verify:<merchantId>:<hash>` or
 * `auto-book:<orderId>` therefore throw "Custom Id cannot contain :" at
 * `queue.add`, and the job falls through to the dead-letter store instead
 * of running.
 *
 * `bullJobId("auto-book", orderId)` → `auto-book-<orderId>`. Every ":" inside
 * a part becomes "_", so ids stay deterministic: the same logical job always
 * maps to the same id, which is what keeps enqueue idempotent (BullMQ ignores
 * an `add` whose id already exists).
 *
 * Repeatable-job keys (`jobId` next to `repeat:`) are NOT built with this —
 * BullMQ derives the real job ids for those itself, and renaming an existing
 * repeat key would register a second schedule next to the old one.
 */
export function bullJobId(prefix: string, ...parts: Array<string | number>): string {
  const id = [prefix, ...parts].map((p) => String(p).replace(/:/g, "_")).join("-");
  if (!isBullSafeJobId(id)) throw new Error(`unsafe BullMQ job id: ${id}`);
  return id;
}

/**
 * Mirrors BullMQ 5.x `Job.validateOptions` for custom ids: rejected when it
 * is an integer, or contains ":" without being exactly three parts.
 */
export function isBullSafeJobId(id: string): boolean {
  if (id.length === 0) return false;
  if (`${parseInt(id, 10)}` === id) return false;
  if (id.includes(":") && id.split(":").length !== 3) return false;
  return true;
}
