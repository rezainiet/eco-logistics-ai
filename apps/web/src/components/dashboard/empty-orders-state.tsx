import Link from "next/link";
import { ArrowRight, FileSpreadsheet, Package, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function EmptyOrdersState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 px-4 py-10 text-center sm:px-12">
        <div className="rounded-full bg-info/15 p-3 text-info" aria-hidden>
          <Package className="h-6 w-6" />
        </div>
        <div className="max-w-md space-y-1.5">
          <h2 className="text-lg font-semibold text-fg">No orders yet</h2>
          <p className="text-sm text-fg-muted">
            Once you create your first order, you will see live status,
            tracking, fraud signals, and automation activity here.
          </p>
        </div>
        <div className="flex w-full max-w-md flex-col gap-2 sm:flex-row sm:justify-center">
          <Button asChild>
            <Link href="/dashboard/orders?new=1">
              Create your first order
              <ArrowRight className="ml-1 h-3 w-3" aria-hidden />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard/orders/import">
              <FileSpreadsheet className="mr-1 h-3 w-3" aria-hidden /> Bulk
              upload (CSV)
            </Link>
          </Button>
        </div>
        <p className="mt-2 text-xs text-fg-faint">
          <Sparkles className="mr-1 inline h-3 w-3" aria-hidden /> Tip: connect
          Shopify or WooCommerce in Integrations to auto-import every new order.
        </p>
      </CardContent>
    </Card>
  );
}
