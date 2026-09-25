import { Badge } from "@/components/ui/badge";

const MAP: Record<string, { label: string; variant: "success" | "secondary" | "warning" | "outline" }> = {
  published: { label: "Published", variant: "success" },
  draft: { label: "Draft", variant: "secondary" },
  unpublished: { label: "Unpublished", variant: "warning" },
  archived: { label: "Archived", variant: "outline" },
};

export function LandingStatusBadge({ status }: { status: string }) {
  const s = MAP[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}
