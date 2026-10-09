import type { ReactNode } from "react";
import { TriangleAlert, Info } from "lucide-react";

export function Callout({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" | "error" }) {
  const Icon = tone === "info" ? Info : TriangleAlert;
  return <div role={tone === "error" ? "alert" : "status"} className="flex min-w-0 max-w-full items-start gap-2 rounded-md border border-line bg-sunken p-3 text-sm text-fg-secondary">
    <Icon aria-hidden="true" className="size-4 shrink-0" /><div className="min-w-0 flex-1 break-words"><strong>{tone === "error" ? "Problem: " : tone === "warning" ? "Attention: " : "Information: "}</strong>{children}</div>
  </div>;
}
