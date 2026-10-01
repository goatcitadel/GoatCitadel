import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

export interface WorkspacePolicyEvidence {
  profileLabel: string;
  approvalMode: string;
  localOverride: boolean;
}

export function readWorkspacePolicyEvidence(value: Record<string, unknown> | undefined, workspaceId: string): WorkspacePolicyEvidence | null {
  if (!value || value.workspaceId !== workspaceId || value.surface !== "tools") return null;
  const profile = value.permissionProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const record = profile as Record<string, unknown>;
  if (typeof record.label !== "string" || typeof record.approvalMode !== "string") return null;
  return {
    profileLabel: record.label,
    approvalMode: record.approvalMode,
    localOverride: typeof value.localOperatorOverrideId === "string" && value.localOperatorOverrideId.length > 0,
  };
}

export function CapabilityPolicyEvidence({ item, callableKnown, workspacePolicy, workspacePolicyState }: {
  item: CapabilityCatalogEntry;
  callableKnown: boolean;
  workspacePolicy?: WorkspacePolicyEvidence | null;
  workspacePolicyState?: "loading" | "unavailable" | "ready";
}) {
  return <>
    <p>{callableKnown ? item.callable ? "Listed as callable. Runtime policy and approvals still govern use." : "Visible for inspection. It is not listed as callable." : "Callability could not be verified."}</p>
    {item.lifecycleState ? <p>Lifecycle: {humanizeToken(item.lifecycleState)}</p> : null}
    {item.mesh ? <p>Mesh publication: {humanizeToken(item.mesh.status)}{item.mesh.reasons.length ? ` · ${item.mesh.reasons.map(humanizeToken).join("; ")}` : ""}</p> : null}
    {item.declaredTools?.length ? <div><p className="font-medium text-fg">Declared tools, not grants</p>
      <ul className="list-disc pl-5">{item.declaredTools.map((tool) => <li key={tool}>{humanizeToken(tool)}</li>)}</ul></div> : null}
    {item.requires?.length ? <div><p className="font-medium text-fg">Declared requirements</p>
      <ul className="list-disc pl-5">{item.requires.map((requirement) => <li key={requirement}>{humanizeToken(requirement)}</li>)}</ul></div> : null}
    {item.wrapperVisibility ? <p>Wrapper declares {item.wrapperVisibility.readOnly ? "read-only" : "write-capable or unspecified"} use, {item.wrapperVisibility.deterministic ? "deterministic" : "non-deterministic or unspecified"} behavior, and {item.wrapperVisibility.codeModeAllowed ? "Code Mode eligibility" : "no Code Mode eligibility"}. These flags are not a grant.</p> : null}
    {item.effectPotential ? <p>Planning-time effect classification: {item.effectPotential.potential === "none" ? "no outside effect predicted" : "outside effect unknown"} ({item.effectPotential.sourceKind === "builtin" ? "Built-in" : humanizeToken(item.effectPotential.sourceKind)} source; {humanizeToken(item.effectPotential.reason)}).</p> : null}
    {workspacePolicyState === "loading" ? <p>Checking this workspace's tools policy…</p> : null}
    {workspacePolicyState === "unavailable" ? <p>Current workspace policy could not be verified.</p> : null}
    {workspacePolicyState === "ready" && workspacePolicy ? <div className="rounded-md border border-line-subtle bg-sunken p-2">
      <p>Current workspace tools profile: {workspacePolicy.profileLabel}</p>
      <p>Approval posture: {humanizeToken(workspacePolicy.approvalMode)}{workspacePolicy.localOverride ? " · Local operator override active" : ""}</p>
    </div> : null}
    <p>Effective policy depends on the workspace, actor, session, and current grants. Evaluate a specific tool context below when a Gateway tool identity is available.</p>
  </>;
}

export function CapabilitySourceEvidence({ item }: { item: CapabilityCatalogEntry }) {
  return <>
    <p>Provider: {item.sourceProvider ? humanizeToken(item.sourceProvider) : "Not recorded"}</p>
    <p className="wrap-anywhere">Source reference: {item.sourceRef ? <code className="text-xs text-fg">{item.sourceRef}</code> : "Not recorded"}</p>
    {item.mesh ? <div className="space-y-1 rounded-md border border-line-subtle bg-sunken p-2">
      <p>Publisher: <code className="wrap-anywhere text-xs text-fg">{item.mesh.nodeId}</code></p>
      <p>Manifest SHA-256: <code className="wrap-anywhere text-xs text-fg">{item.mesh.manifestSha256}</code></p>
      <p>Entry SHA-256: <code className="wrap-anywhere text-xs text-fg">{item.mesh.entrySha256}</code></p>
    </div> : null}
    {!item.sourceRef && !item.mesh ? <p>No version hash or source reference is present in this catalog entry.</p> : null}
  </>;
}
