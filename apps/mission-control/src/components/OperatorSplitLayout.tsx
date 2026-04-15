import type { ReactNode } from "react";

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
  return (
    <div className={`operator-split-layout${className ? ` ${className}` : ""}`}>
      {topbar ? <div className="operator-split-topbar">{topbar}</div> : null}
      <div className="operator-split-grid">
        <div className="operator-split-primary">{primary}</div>
        <aside className={`operator-split-inspector operator-split-inspector-${inspectorMode}`}>
          {inspector ?? emptyInspector}
        </aside>
      </div>
    </div>
  );
}
