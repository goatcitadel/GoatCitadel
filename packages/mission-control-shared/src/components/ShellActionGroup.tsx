import type { ReactNode } from "react";

interface ShellActionGroupProps {
  children: ReactNode;
  className?: string;
}

export function ShellActionGroup({ children, className }: ShellActionGroupProps) {
  return <div className={`shell-action-group${className ? ` ${className}` : ""}`}>{children}</div>;
}
