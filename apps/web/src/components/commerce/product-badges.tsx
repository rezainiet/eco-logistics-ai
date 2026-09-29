import { Badge } from "@/components/ui/badge";

export function StockBadge({ status, available }: { status: string; available: number }) {
  if (status === "out_of_stock") return <Badge variant="destructive" className="whitespace-nowrap">Out of stock</Badge>;
  if (status === "low_stock") return <Badge variant="warning" className="whitespace-nowrap">Low stock · {available}</Badge>;
  return <Badge variant="success" className="whitespace-nowrap">In stock · {available}</Badge>;
}

export function ProductStatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge variant="info">Active</Badge>;
  if (status === "draft") return <Badge variant="outline">Draft</Badge>;
  return <Badge variant="secondary">Inactive</Badge>;
}
