import { useEffect, type ReactNode } from "react";
import { useCopy } from "./locale.tsx";
import type { useCatalog } from "./use-catalog.ts";

export type Paging = Pick<
  ReturnType<typeof useCatalog>,
  "hasMore" | "loadingMore" | "moreFailed" | "loadMore"
>;

export function BrowseLoading({
  remaining,
  expanded,
  paging,
  children,
}: {
  remaining: number;
  expanded: boolean;
  paging: Paging;
  children: ReactNode;
}) {
  const copy = useCopy();
  const { hasMore, loadingMore, moreFailed, loadMore } = paging;
  useEffect(() => {
    if (remaining <= 5 && hasMore && !loadingMore && !moreFailed) void loadMore();
  }, [remaining, hasMore, loadingMore, moreFailed, loadMore]);
  const retry = moreFailed && (
    <div>
      <output>{copy.loadFailure}</output>
      <button type="button" className="text-button" onClick={() => void loadMore()}>
        {copy.retry}
      </button>
    </div>
  );
  if (!remaining && !expanded && hasMore)
    return <div className="empty-card">{moreFailed ? retry : <output>{copy.loading}</output>}</div>;
  return (
    <>
      {children}
      {retry}
    </>
  );
}
