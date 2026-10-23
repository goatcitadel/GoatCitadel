import type { RemoteWorkerReconciliation, RemoteWorkerRegistryItem } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Section } from "../../../ui/Section";
import { StatusBadge } from "../../../ui/StatusBadge";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { TimeText } from "../../../ui/TimeText";
import { reconciliationStatus, shortDigest, workerStatus } from "./worker-copy";

const CONTROL_WORDS = { quarantine: "Contained", revoke: "Revoked" } as const;

/** Who the worker is, the containment recorded for it, and whether the server's records agree with each other. */
export function WorkerIdentitySection({
  item,
  reconciliation,
}: {
  item: RemoteWorkerRegistryItem;
  reconciliation: RemoteWorkerReconciliation | null;
}) {
  const admission = item.admission.value;
  const control = item.control.value;
  const checks = reconciliation
    ? ([
        ["Joining and containment", reconciliation.admissionControl],
        ["Assignments and leases", reconciliation.assignmentLease],
        ["Results and saved output", reconciliation.settlementMaterialization],
      ] as const)
    : [];
  return (
    <>
      <Section title="Identity">
        {admission ? (
          <>
            <p className="text-sm text-fg-secondary">
              {admission.platform} · {admission.architecture} ·{" "}
              {plural(admission.capabilityClassCount, "capability", "capabilities")} ·{" "}
              {plural(admission.allowedWorkspaceCount, "workspace")} allowed ·{" "}
              <TimeText value={admission.admittedAt} prefix="joined" />
            </p>
            <TechnicalDetails label="Identity details">
              <ul className="space-y-1 break-all font-mono text-xs">
                <li>worker {admission.workerId}</li>
                <li>node {admission.nodeId}</li>
                <li>version {admission.workerGeneration}</li>
                <li>public key {shortDigest(admission.publicKeySpkiSha256)}</li>
                <li>certificate {shortDigest(admission.clientCertificateSha256)}</li>
                <li>runtime manifest {shortDigest(admission.runtimeManifestSha256)}</li>
              </ul>
            </TechnicalDetails>
          </>
        ) : (
          <p className="text-sm text-fg-muted">This worker's identity was not reported.</p>
        )}
      </Section>
      <Section title="Controls" actions={<StatusBadge status={workerStatus(item.posture.value)} />}>
        {control ? (
          <p className="text-sm text-fg-secondary">
            {CONTROL_WORDS[control.action] ?? "Contained"} <TimeText value={control.createdAt} />.
          </p>
        ) : (
          <p className="text-sm text-fg-secondary">No containment is recorded for this worker.</p>
        )}
        <p className="mt-1 text-xs text-fg-muted">
          This page never enrolls, rotates, contains or revokes workers; use the worker tools on the host for that.
        </p>
        {control ? (
          <TechnicalDetails label="Control details">
            <p className="font-mono text-xs">
              {control.action} · revision {control.controlRevision} · version {control.workerGeneration}
            </p>
          </TechnicalDetails>
        ) : null}
      </Section>
      <Section title="Record checks" description="Whether the server's records for this worker agree with each other.">
        {reconciliation ? (
          <ul className="divide-y divide-line-subtle">
            {checks.map(([label, truth]) => (
              <li key={label} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-fg">{label}</span>
                  <StatusBadge status={reconciliationStatus(truth.value?.status)} />
                </div>
                <p className="mt-0.5 text-fg-secondary">{truth.value?.summary ?? "Not checked."}</p>
              </li>
            ))}
            <li className="py-2 text-sm text-fg-secondary">
              Resource cells and cleanup are not checked here; open an assignment to see what it kept.
            </li>
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">Record checks are unavailable.</p>
        )}
      </Section>
    </>
  );
}
