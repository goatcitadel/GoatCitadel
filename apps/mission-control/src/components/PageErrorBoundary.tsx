import { Component, type ErrorInfo, type ReactNode } from "react";

interface PageErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
  pageLabel: string;
  onReturnToChat: () => void;
}

interface PageErrorBoundaryState {
  hasError: boolean;
}

export class PageErrorBoundary extends Component<
  PageErrorBoundaryProps,
  PageErrorBoundaryState
> {
  public override state: PageErrorBoundaryState = {
    hasError: false,
  };

  public static getDerivedStateFromError(): PageErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[PageErrorBoundary] page render failed", {
      pageLabel: this.props.pageLabel,
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  public override componentDidUpdate(prevProps: PageErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  private readonly handleRetry = () => {
    this.setState({ hasError: false });
  };

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section className="shell-page-error" role="alert" aria-live="assertive">
          <div className="shell-page-error-card">
            <p className="shell-page-error-kicker">Page unavailable</p>
            <h3>{this.props.pageLabel} hit a render failure.</h3>
            <p>Retry this surface or return to Chat while Mission Control recovers.</p>
            <div className="shell-page-error-actions">
              <button type="button" onClick={this.handleRetry} className="gc-button">Retry page</button>
              <button type="button" className="gc-button secondary" onClick={this.props.onReturnToChat}>Return to Chat</button>
            </div>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
