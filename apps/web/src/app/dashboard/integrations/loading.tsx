import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

export default function IntegrationsLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-1/3" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
      <SkeletonRows count={3} rowClassName="h-20" />
    </div>
  );
}
