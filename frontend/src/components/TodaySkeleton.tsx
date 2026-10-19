import { LoadingRegion, Skeleton } from '@/components/ui/States'

/** Today's loading layout. Also shown while the session is being restored, so the screen doesn't jump. */
export function TodaySkeleton() {
  return (
    <LoadingRegion label="Loading your plan">
      <div className="px-5 pt-6 lg:px-8">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-2 h-5 w-56" />
        <Skeleton className="mt-6 h-40 w-full rounded-card" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="mt-6 grid grid-cols-[3.5rem_1.5rem_1fr] gap-x-3">
            <Skeleton className="h-6 w-12" />
            <Skeleton className="mx-auto h-24 w-1.5 rounded-full" />
            <div>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="mt-2 h-4 w-24" />
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  )
}
