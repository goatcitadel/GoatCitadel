import type { ReactNode } from "react";

interface FieldHelpProps {
  children: ReactNode;
  className?: string;
}

export function FieldHelp({ children, className }: FieldHelpProps) {
  return <p className={`field-help${className ? ` ${className}` : ""}`}>{children}</p>;
}
