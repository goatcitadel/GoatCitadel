export type RuntimeAuthorityClass =
  | "canonical_record"
  | "derived_projection"
  | "retained_signal"
  | "inferred"
  | "unavailable";

export type RuntimeAuthorityDomain = "runs" | "approvals" | "workers" | "backups" | "reconciliation";

export type RuntimeAuthorityFreshness = "current" | "stale" | "missing" | "contradictory" | "unknown";

export type RuntimeAuthorityPosture = "ok" | "neutral" | "attention" | "critical" | "unavailable";

export interface RuntimeAuthorityScope {
  kind: "workspace" | "citadel";
  workspaceId?: string;
}

/**
 * A semantic, server-authored navigation reference. Mission Control maps these
 * values to its own route model instead of accepting arbitrary hrefs from data.
 */
export type RuntimeAuthorityReference =
  | {
      kind: "durable_run";
      label: "Open run detail";
      runId: string;
    }
  | {
      kind: "approval";
      label: "Open approval detail";
      approvalId: string;
    }
  | {
      kind: "release_evidence";
      label: "Open release evidence";
    }
  | {
      kind: "external_side_effects";
      label: "Open reconciliation ledger";
    };

/**
 * A bounded public projection of runtime trust. All authority, owner, source,
 * basis, and reference fields are assigned by Gateway code; callers cannot
 * promote a cache, realtime signal, or client join into canonical truth.
 */
export interface RuntimeAuthorityItem {
  id: string;
  domain: RuntimeAuthorityDomain;
  label: string;
  authorityClass: RuntimeAuthorityClass;
  owner: string;
  source: string;
  observedAt?: string;
  freshness: RuntimeAuthorityFreshness;
  posture: RuntimeAuthorityPosture;
  state: string;
  basis: string;
  caveat?: string;
  scope: RuntimeAuthorityScope;
  canonicalRef?: RuntimeAuthorityReference;
}

export interface RuntimeAuthorityProjectionResponse {
  schemaVersion: 1;
  generatedAt: string;
  workspaceId: string;
  items: RuntimeAuthorityItem[];
}
