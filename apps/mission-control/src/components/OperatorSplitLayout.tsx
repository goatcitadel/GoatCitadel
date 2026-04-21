import type { ReactNode } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { ResizablePaneLayout } from "./ResizablePaneLayout";

export function OperatorSplitLayout({
  topbar,
  primary,
  inspector,
  emptyInspector,
  className,
  inspectorMode = "sticky",
}: {
  topbar?: ReactNode;
  primary: ReactNode;
  inspector?: ReactNode | null;
  emptyInspector?: ReactNode | null;
  className?: string;
  inspectorMode?: "sticky" | "collapsible" | "empty-selection";
}) {
  const stackInspector = useMediaQuery("(max-width: 1279px)");
  const inspectorContent = inspector ?? emptyInspector;
  const shouldUseResizableLayout = Boolean(inspectorContent) && !stackInspector;

  return (
    <div className={`operator-split-layout${className ? ` ${className}` : ""}`}>
      {topbar ? <div className="operator-split-topbar">{topbar}</div> : null}
      {shouldUseResizableLayout ? (
        <ResizablePaneLayout
          storageKey={`operator-split.${inspectorMode}`}
          className="operator-split-grid operator-split-grid-resizable"
          panes={[
            {
              id: "primary",
              minSize: 520,
              className: "operator-split-pane operator-split-pane-primary",
              children: <div className="operator-split-primary">{primary}</div>,
            },
            {
              id: "inspector",
              defaultSize: 380,
              minSize: 320,
              maxSize: 520,
              className: "operator-split-pane operator-split-pane-inspector",
              children: (
                <aside className={`operator-split-inspector operator-split-inspector-${inspectorMode}`}>
                  {inspectorContent}
                </aside>
              ),
            },
          ]}
        />
      ) : (
        <div className="operator-split-grid">
          <div className="operator-split-primary">{primary}</div>
          <aside className={`operator-split-inspector operator-split-inspector-${inspectorMode}`}>
            {inspectorContent}
          </aside>
        </div>
      )}
    </div>
  );
}
