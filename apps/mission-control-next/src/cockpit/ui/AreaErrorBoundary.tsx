import { Component, type ErrorInfo, type ReactNode } from "react";
import { isModuleLoadError } from "@goatcitadel/mission-control-shared/components/PageErrorBoundary";
import { Button } from "./Button";

interface AreaErrorBoundaryProps {
  children: ReactNode;
  /** Names the view in the fallback heading, for example "Inbox". */
  label: string;
  /** A new value clears a caught error, for example after moving to another area. */
  resetKey: string;
  onGoToChat?: () => void;
}

interface AreaErrorBoundaryState {
  /** Kept apart from `error`: `throw null` and `throw undefined` are failures too. */
  hasError: boolean;
  error: Error | null;
}

function reloadDocument(): void {
  window.location.reload();
}

/** One failed view or lazy chunk must not blank the whole cockpit. */
export class AreaErrorBoundary extends Component<AreaErrorBoundaryProps, AreaErrorBoundaryState> {
  public override state: AreaErrorBoundaryState = { hasError: false, error: null };

  public static getDerivedStateFromError(error: unknown): AreaErrorBoundaryState {
    return { hasError: true, error: error instanceof Error ? error : null };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // eslint-disable-next-line no-console -- a caught render failure must stay visible while debugging locally.
    console.error("[AreaErrorBoundary] render failed", {
      label: this.props.label,
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  public override componentDidUpdate(previous: AreaErrorBoundaryProps): void {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey)
      this.setState({ hasError: false, error: null });
  }

  private readonly retry = () => {
    this.setState({ hasError: false, error: null });
  };

  public override render(): ReactNode {
    const { hasError, error } = this.state;
    if (!hasError) return this.props.children;
    const staleBuild = isModuleLoadError(error);
    return (
      <section
        role="alert"
        className="mx-auto my-8 max-w-lg space-y-3 rounded-lg border border-status-failed bg-raised p-5 text-sm"
      >
        <h2 className="font-display text-lg font-semibold text-fg">{this.props.label} couldn't be shown</h2>
        <p className="text-fg-secondary">
          {staleBuild
            ? "Part of Mission Control didn't finish loading, usually because it was just updated. Reload to get the current version."
            : "Something went wrong while showing this view. If you had just sent or approved something, check whether it went through before trying again."}
        </p>
        <div className="flex flex-wrap gap-2">
          {staleBuild ? null : (
            <Button variant="primary" onClick={this.retry}>
              Try again
            </Button>
          )}
          <Button variant={staleBuild ? "primary" : "secondary"} onClick={reloadDocument}>
            Reload app
          </Button>
          {this.props.onGoToChat ? <Button onClick={this.props.onGoToChat}>Go to Chat</Button> : null}
        </div>
      </section>
    );
  }
}
