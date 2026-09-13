import { NativeButton, NoticeBanner } from "../primitives";

interface MemoryEnumerationControlsProps {
  loaded: number;
  visible: number;
  total?: number;
  hasMore: boolean;
  searching: boolean;
  unavailable: boolean;
  loadingMore?: boolean;
  error?: string | null;
  onLoadMore: () => Promise<void>;
  onReload: () => Promise<void>;
}

export function MemoryEnumerationControls(props: MemoryEnumerationControlsProps) {
  return <>
    <p role="status" aria-live="polite">
      {props.searching ? "Searching memory…" : props.unavailable ? "Memory results unavailable."
        : `${props.visible} matching results loaded · ${props.loaded} of ${props.total ?? "unknown"} total. ${props.hasMore ? "Namespace and lifecycle counts cover loaded items." : ""}`}
    </p>
    {props.error ? <>
      <NoticeBanner tone="warning" message={`${props.error} Loaded results may be out of date.`} />
      <NativeButton onClick={() => void props.onReload()} disabled={props.searching}>Reload memory</NativeButton>
    </> : props.hasMore ? <NativeButton
      onClick={() => void props.onLoadMore()}
      disabled={props.searching || props.unavailable || props.loadingMore}
      aria-busy={props.loadingMore || undefined}
    >{props.loadingMore ? "Loading more memory…" : "Load more memory"}</NativeButton> : null}
  </>;
}
