/**
 * Order-verification queue paging helpers (audit OV-2).
 *
 * The API pages the queue by a compound (riskScore, _id) cursor, so pages
 * never overlap. The flatten step still de-duplicates by id: if an order is
 * re-scored or a page is refetched while the merchant is reading, a row can
 * legitimately appear in two fetched pages, and React keys must stay unique.
 */
export interface QueuePage<T extends { id: string }> {
  items: T[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export function flattenQueuePages<T extends { id: string }>(
  pages: ReadonlyArray<QueuePage<T>> | undefined,
): { items: T[]; total: number } {
  if (!pages || pages.length === 0) return { items: [], total: 0 };
  const seen = new Set<string>();
  const items: T[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  // The newest page carries the freshest count.
  return { items, total: pages[pages.length - 1]!.total };
}

/** Cursor for the next page, or undefined when there is none (React Query contract). */
export function nextQueueCursor<T extends { id: string }>(last: QueuePage<T>): string | undefined {
  return last.hasMore && last.nextCursor ? last.nextCursor : undefined;
}
