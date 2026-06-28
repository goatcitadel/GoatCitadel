import { Shield, Activity, AlertTriangle } from "lucide-react";
import type { TrustPolicySkillDeclaredMetadata } from "@goatcitadel/mission-control-shared/api/trust";
import type { TrustPolicyDeclaredGovernanceView, TrustPolicyMatrixRow } from "./TrustPolicySection";

export function labelForKind(kind: TrustPolicyMatrixRow["kind"]): string {
  if (kind === "capability") {
    return "Capability";
  }
  if (kind === "tool") {
    return "Tool";
  }
  return "Source";
}

export function hasDeclaredDependencies(deps: TrustPolicyDeclaredGovernanceView["dependencies"]): boolean {
  return Boolean((deps.tools?.length ?? 0) || (deps.skillIds?.length ?? 0) || (deps.capabilities?.length ?? 0));
}

export function normalizeDeclaredGovernance(
  meta: TrustPolicySkillDeclaredMetadata | undefined,
): TrustPolicyDeclaredGovernanceView | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const dependencies = isRecord(meta.dependencies) ? meta.dependencies : {};
  return {
    requiredEnv: readObjectArray(meta.requiredEnv)
      .map((env) => ({
        name: readString(env.name),
        secret: env.secret === true,
      }))
      .filter((env): env is { name: string; secret: boolean } => Boolean(env.name)),
    stateDirs: readObjectArray(meta.stateDirs)
      .map((dir) => ({
        path: readString(dir.path),
        writeable: dir.writeable === true,
      }))
      .filter((dir): dir is { path: string; writeable: boolean } => Boolean(dir.path)),
    dependencies: {
      tools: readStringArray(dependencies.tools),
      skillIds: readStringArray(dependencies.skillIds),
      capabilities: readStringArray(dependencies.capabilities),
    },
  };
}

function readObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => readString(item)).filter((item): item is string => Boolean(item))
    : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function TrustPolicyRowDetails({ row }: { row: TrustPolicyMatrixRow }) {
  const meta = normalizeDeclaredGovernance(row.declaredMetadata);
  const warnings = row.bundleWarnings?.map((item) => item.trim()).filter(Boolean) ?? [];
  const missingEnv = row.missingRequiredEnv?.map((item) => item.trim()).filter(Boolean) ?? [];
  const hasGovernance = Boolean(
    meta && (meta.requiredEnv.length > 0 || meta.stateDirs.length > 0 || hasDeclaredDependencies(meta.dependencies)),
  );

  return (
    <div className="mc-next-trust-details-grid">
      {/* Governance Details Card */}
      {(hasGovernance || missingEnv.length > 0 || warnings.length > 0) && (
        <div className="mc-next-trust-details-card">
          <h4>
            <Shield size={14} /> Security &amp; Declarations
          </h4>
          <div className="mc-next-trust-details-card-body">
            {missingEnv.length > 0 && (
              <div>
                <strong>Missing Env Vars:</strong>
                <div className="mc-next-trust-badge-list">
                  {missingEnv.map((env) => (
                    <span key={env} className="mc-next-trust-badge is-missing">
                      {env}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {meta && meta.requiredEnv.length > 0 && (
              <div>
                <strong>Required Env:</strong>
                <div className="mc-next-trust-badge-list">
                  {meta.requiredEnv.map((env) => (
                    <span key={env.name} className={`mc-next-trust-badge ${env.secret ? "is-secret" : ""}`}>
                      {env.name}
                      {env.secret && " (secret)"}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {meta && meta.stateDirs.length > 0 && (
              <div>
                <strong>State Directories:</strong>
                <div className="mc-next-trust-badge-list">
                  {meta.stateDirs.map((dir) => (
                    <span key={dir.path} className="mc-next-trust-badge">
                      {dir.path}
                      {dir.writeable && " (writeable)"}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {meta && hasDeclaredDependencies(meta.dependencies) && (
              <div>
                <strong>Dependencies:</strong>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem", marginTop: "0.2rem" }}>
                  {meta.dependencies.tools.length > 0 && <span>Tools: {meta.dependencies.tools.join(", ")}</span>}
                  {meta.dependencies.skillIds.length > 0 && (
                    <span>Skills: {meta.dependencies.skillIds.join(", ")}</span>
                  )}
                  {meta.dependencies.capabilities.length > 0 && (
                    <span>Capabilities: {meta.dependencies.capabilities.join(", ")}</span>
                  )}
                </div>
              </div>
            )}
            {warnings.length > 0 && (
              <div>
                <strong>Compilation Warnings:</strong>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.2rem",
                    color: "var(--warning)",
                    marginTop: "0.2rem",
                  }}
                >
                  {warnings.map((warn) => (
                    <span key={warn} style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                      <AlertTriangle size={10} /> {warn}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Evidence & Runtime Details Card */}
      <div className="mc-next-trust-details-card">
        <h4>
          <Activity size={14} /> Execution &amp; Evidence
        </h4>
        <div className="mc-next-trust-details-card-body">
          <div>
            <strong>Identifier:</strong> <code>{row.id}</code>
          </div>
          <div>
            <strong>Type:</strong> {labelForKind(row.kind)}
          </div>
          <div>
            <strong>Current Trust Label:</strong> {row.trustState ?? "None"}
          </div>
          {row.lastUse ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginTop: "0.25rem" }}>
              <div>
                <strong>Last Active:</strong> {row.lastUse.at ? new Date(row.lastUse.at).toLocaleString() : "Unknown"}
              </div>
              <div>
                <strong>Usage:</strong> {row.lastUse.label ?? "1+ times"}
              </div>
              {row.lastUse.runId && (
                <div>
                  <strong>Run ID:</strong> <code>{row.lastUse.runId}</code>
                </div>
              )}
              {row.lastUse.approvalId && (
                <div>
                  <strong>Approval ID:</strong> <code>{row.lastUse.approvalId}</code>
                </div>
              )}
              {row.lastUse.evidenceRef && (
                <div>
                  <strong>Evidence Hash:</strong> <code>{row.lastUse.evidenceRef}</code>
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontStyle: "italic", marginTop: "0.25rem" }}>
              No recorded runtime activations or security events.
            </div>
          )}
        </div>
      </div>

      {/* Resolution & Remediation Card */}
      <div className="mc-next-trust-details-card">
        <h4>Owner Action &amp; Remediation</h4>
        <div className="mc-next-trust-details-card-body" style={{ gap: "0.6rem" }}>
          <div>
            <strong>Governance Surface:</strong> {row.owner}
          </div>
          {row.blockers && row.blockers.length > 0 && (
            <div>
              <strong>Enforced Blockers:</strong>
              <ul style={{ margin: "0.2rem 0 0 0", paddingLeft: "1rem", color: "var(--critical)" }}>
                {row.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
          <div
            className={`mc-next-trust-action-box ${
              row.status === "blocked" || row.status === "quarantined"
                ? "is-critical"
                : row.status === "approval_required" || row.status === "medium_trust"
                  ? "is-warning"
                  : ""
            }`}
          >
            <strong>Action Needed:</strong>
            <p style={{ margin: "0.2rem 0 0 0", lineHeight: "1.3" }}>{row.actionNeeded}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
