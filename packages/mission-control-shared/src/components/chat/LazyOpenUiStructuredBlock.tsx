import { Component, lazy, Suspense, type ReactNode } from "react";

// The OpenUI parser and component library (with their own zod build) load only when a generated block is shown.
const OpenUiBlockOrFallback = lazy(async () => {
  const module = await import("./OpenUiStructuredBlock");
  return {
    default: ({ source, fallback }: { source: string; fallback: ReactNode }) =>
      module.canRenderOpenUiStructuredBlock(source) ? (
        <module.OpenUiStructuredBlockRenderer source={source} />
      ) : (
        fallback
      ),
  };
});

interface OpenUiBlockBoundaryProps {
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}

/**
 * Keeps the plain code block when the renderer chunk cannot load or the generated block fails to render, so neither
 * takes down the message. A new streamed source retries rendering, so a partial program can still upgrade once
 * complete; a chunk that failed to load stays failed for the session (the lazy import keeps its rejection).
 */
class OpenUiBlockBoundary extends Component<OpenUiBlockBoundaryProps, { failed: boolean }> {
  public override state = { failed: false };
  private reported = false;

  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  public override componentDidCatch(error: Error): void {
    // One report per block: a block that keeps failing while it streams would otherwise warn on every token.
    if (this.reported) return;
    this.reported = true;
    // eslint-disable-next-line no-console -- a degraded generated block should stay visible to whoever debugs it.
    console.warn("[OpenUiBlockBoundary] OpenUI block fell back to code", { error });
  }

  public override componentDidUpdate(prevProps: OpenUiBlockBoundaryProps): void {
    if (this.state.failed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  public override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** A generated OpenUI block, or the plain code block while the renderer loads and whenever the source cannot render. */
export function LazyOpenUiStructuredBlock({ source, fallback }: { source: string; fallback: ReactNode }) {
  return (
    <OpenUiBlockBoundary resetKey={source} fallback={fallback}>
      <Suspense fallback={fallback}>
        <OpenUiBlockOrFallback source={source} fallback={fallback} />
      </Suspense>
    </OpenUiBlockBoundary>
  );
}
