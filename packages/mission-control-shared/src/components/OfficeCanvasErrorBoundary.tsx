import { Component, type ErrorInfo, type ReactNode } from "react";

interface OfficeCanvasErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

interface OfficeCanvasErrorBoundaryState {
  hasError: boolean;
}

export class OfficeCanvasErrorBoundary extends Component<
  OfficeCanvasErrorBoundaryProps,
  OfficeCanvasErrorBoundaryState
> {
  public override state: OfficeCanvasErrorBoundaryState = {
    hasError: false,
  };

  public static getDerivedStateFromError(): OfficeCanvasErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[OfficeCanvasErrorBoundary] render failed", {
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  public override componentDidUpdate(prevProps: OfficeCanvasErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="office-webgl-stage office-webgl-stage-v5 office-stage-loading">
          <p>Office scene failed to render. Changing motion settings or goat asset inputs will retry the scene. Reload if WebGL is unavailable in this browser.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
