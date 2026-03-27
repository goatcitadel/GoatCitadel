import type { ReactNode } from "react";
import { useEmbeddedPageChrome } from "./EmbeddedPageChrome";

interface DataToolbarProps {
  primary?: ReactNode;
  secondary?: ReactNode;
  className?: string;
}

export function DataToolbar({ primary, secondary, className }: DataToolbarProps) {
  const embedded = useEmbeddedPageChrome();
  return (
    <div
      className={`${embedded ? "action-bar" : "data-toolbar"}${primary ? ` ${embedded ? "action-bar-has-primary" : "data-toolbar-has-primary"}` : ""}${secondary ? ` ${embedded ? "action-bar-has-secondary" : "data-toolbar-has-secondary"}` : ""}${className ? ` ${className}` : ""}`}
    >
      <div className={embedded ? "action-bar-primary" : "data-toolbar-primary"}>{primary}</div>
      <div className={embedded ? "action-bar-secondary" : "data-toolbar-secondary"}>{secondary}</div>
    </div>
  );
}
