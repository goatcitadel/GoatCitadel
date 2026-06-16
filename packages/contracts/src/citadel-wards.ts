export type WardEffect =
  | "allow"
  | "deny"
  | "require_approval"
  | "require_dry_run"
  | "redact"
  | "route_local";

export interface CitadelWard {
  name: string;
  actionPattern: string;
  effect: WardEffect;
}

/** A persisted Ward belonging to a Citadel. */
export interface CitadelWardRecord extends CitadelWard {
  wardId: string;
  citadelId: string;
  createdAt: string;
}

export interface CitadelWardInput {
  citadelId: string;
  name: string;
  actionPattern: string;
  effect: WardEffect;
}

export function wardMatchesAction(actionPattern: string, action: string): boolean {
  // Escape all regex metacharacters except "*", then replace "*" with ".*"
  const escaped = actionPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexSource = escaped.replace(/\*/g, ".*");
  const regex = new RegExp(`^${regexSource}$`);
  return regex.test(action);
}

export function evaluateWards(wards: CitadelWard[], action: string): WardEffect {
  const matching = wards.filter((w) => wardMatchesAction(w.actionPattern, action));

  if (matching.length === 0) {
    return "allow";
  }

  // Deny-wins precedence order
  if (matching.some((w) => w.effect === "deny")) return "deny";
  if (matching.some((w) => w.effect === "require_approval")) return "require_approval";
  if (matching.some((w) => w.effect === "require_dry_run")) return "require_dry_run";
  if (matching.some((w) => w.effect === "route_local")) return "route_local";
  if (matching.some((w) => w.effect === "redact")) return "redact";

  return "allow";
}
