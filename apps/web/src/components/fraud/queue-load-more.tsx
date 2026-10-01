import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Footer of the verification queue list: "Load more" while there are more
 * pages, a retry when fetching the next page failed (the rows already shown
 * stay put), and a quiet "all shown" line at the end.
 */
export function QueueLoadMore({
  shown,
  total,
  hasMore,
  loading,
  failed,
  onLoadMore,
}: {
  shown: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onLoadMore: () => void;
}) {
  if (shown === 0) return null;
  if (!hasMore && !failed) {
    return (
      <p className="px-4 py-3 text-center text-2xs text-fg-subtle" role="status">
        All {shown.toLocaleString()} shown
      </p>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-3" role="status" aria-live="polite">
      {failed ? (
        <p className="text-2xs text-danger">Couldn&apos;t load more orders. Your queue above is unaffected.</p>
      ) : (
        <p className="text-2xs text-fg-subtle">
          Showing {shown.toLocaleString()} of {total.toLocaleString()}
        </p>
      )}
      <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loading}>
        {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
        {failed ? "Retry" : loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}
