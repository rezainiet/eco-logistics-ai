import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

export default function OrdersLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-1/3" />
      <Skeleton className="h-12 w-full" />
      <SkeletonRows count={8} rowClassName="h-14" />
    </div>
  );
}
