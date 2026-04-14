import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "./alert";

type GCAlertTone = "info" | "success" | "warning" | "error";

interface GCAlertProps {
  tone?: GCAlertTone;
  title?: string;
  children: ReactNode;
}

export function GCAlert({ tone = "info", title, children }: GCAlertProps) {
  const variant = tone === "error" ? "destructive" : "default";
  return (
    <Alert
      variant={variant}
      role={tone === "error" ? "alert" : "status"}
      className={cn("gc-alert mc-gc-alert", `gc-alert-${tone}`, `mc-gc-alert-${tone}`)}
    >
      {title ? <AlertTitle className="gc-alert-title">{title}</AlertTitle> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
