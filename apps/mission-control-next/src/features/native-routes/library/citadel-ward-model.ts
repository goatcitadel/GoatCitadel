import type { WardEffect } from "@goatcitadel/contracts";
export const WARD_EFFECTS: WardEffect[] = [
  "allow",
  "deny",
  "require_approval",
  "require_dry_run",
  "redact",
  "route_local",
];
export const WARD_EFFECT_META: Record<WardEffect, { label: string; detail: string }> = {
  allow: { label: "Allow", detail: "Permit the matching action unless a stricter Ward also matches." },
  deny: { label: "Deny", detail: "Block the matching action. Deny always wins." },
  require_approval: { label: "Require approval", detail: "Pause for an operator decision before execution." },
  require_dry_run: { label: "Require dry run", detail: "Require a preview before execution." },
  redact: { label: "Redact", detail: "Apply redaction to matching action data." },
  route_local: { label: "Route local", detail: "Keep matching model work on a local route." },
};
export interface WardDraft {
  name: string;
  actionPattern: string;
  effect: WardEffect;
}
export const EMPTY_WARD: WardDraft = { name: "", actionPattern: "", effect: "deny" };
