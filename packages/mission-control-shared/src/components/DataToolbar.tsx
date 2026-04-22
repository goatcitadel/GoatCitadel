import type { ReactNode } from "react";
import { useEmbeddedPageChrome } from "./EmbeddedPageChrome";

interface DataToolbarProps {
  primary?: ReactNode;
  center?: ReactNode;
  secondary?: ReactNode;
  className?: string;
}

export function DataToolbar({ primary, center, secondary, className }: DataToolbarProps) {
  const embedded = useEmbeddedPageChrome();
  const rootClassName = embedded ? "action-bar" : "data-toolbar";
  return (
    <div
      className={`${rootClassName}${primary ? ` ${rootClassName}-has-primary` : ""}${center ? ` ${rootClassName}-has-center` : ""}${secondary ? ` ${rootClassName}-has-secondary` : ""}${className ? ` ${className}` : ""}`}
    >
      {primary ? <div className={embedded ? "action-bar-primary" : "data-toolbar-primary"}>{primary}</div> : null}
      {center ? <div className={embedded ? "action-bar-center" : "data-toolbar-center"}>{center}</div> : null}
      {secondary ? (
        <div className={embedded ? "action-bar-secondary" : "data-toolbar-secondary"}>{secondary}</div>
      ) : null}
    </div>
  );
}
