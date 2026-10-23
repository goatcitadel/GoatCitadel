import type { ReactNode } from "react";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { sourceFailed, type OpsRuntimeData } from "../../../features/native-routes/ops/runtime-overview-model";
import { useOperatorInbox } from "../../data/use-operator-inbox";
import { Section } from "../../ui/Section";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { inboxMatchesWorkspace } from "../inbox/inbox-presentation";
import { backupTrustFromInbox } from "./backup-trust";
import { HealthBackupAction } from "./HealthBackupAction";
import { backupHealthCheck } from "./health-overview";
import { integrationRows, localModelStatus } from "./runtime-page-model";
import { SystemOwnerLink } from "./SystemOwnerLink";

const ROWS = "divide-y divide-line-subtle";
const LINK = "mt-2 inline-block text-sm font-medium text-accent hover:underline";

function Unavailable({ children }: { children: ReactNode }) {
  return <p className="text-sm text-fg-muted">{children}</p>;
}

/** Backup status in the same words as System › Health: the summary lists records, the Inbox reports verification. */
function BackupsSection({
  data,
  workspaceId,
  onRefresh,
}: {
  data: OpsRuntimeData;
  workspaceId: string;
  onRefresh: () => Promise<unknown>;
}) {
  const inbox = useOperatorInbox(workspaceId);
  const latest = data.health?.backups?.latest;
  const trust = backupTrustFromInbox(
    !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined,
    sourceFailed(data, "health") ? undefined : latest,
  );
  const check = backupHealthCheck(trust, Boolean(latest));
  return (
    <Section
      id="ops-runtime-backups"
      title="Backups"
      description={check.detail}
      actions={<StatusBadge status={check.status} />}
    >
      <HealthBackupAction readAvailable={!sourceFailed(data, "health")} onRefresh={onRefresh} />
      {sourceFailed(data, "backups") ? (
        <Unavailable>Backup records could not be read.</Unavailable>
      ) : data.backups.length ? (
        <ul className={`mt-2 ${ROWS}`} aria-label="Backup records">
          {data.backups.map((item) => (
            <li key={item.backupId} className="py-2 text-sm text-fg-secondary">
              <TimeText value={item.createdAt} /> · {plural(item.files.length, "file")}
              <TechnicalDetails>
                <p className="break-all font-mono text-xs">{item.backupId}</p>
              </TechnicalDetails>
            </li>
          ))}
        </ul>
      ) : (
        <Unavailable>No backup records yet.</Unavailable>
      )}
    </Section>
  );
}

function LocalModelSection({ data, workspaceId }: { data: OpsRuntimeData; workspaceId: string }) {
  const status = localModelStatus(data);
  return (
    <Section title="Local model runtime" description={status.detail} actions={<StatusBadge status={status} />}>
      {data.llamaCpp?.lastError ? (
        <TechnicalDetails label="Last reported error">
          <p className="break-words font-mono text-xs">{data.llamaCpp.lastError}</p>
        </TechnicalDetails>
      ) : null}
      <SystemOwnerLink href="/settings/advanced#managed-runtime" scope={[workspaceId, "local-model"]} className={LINK}>
        Open Settings › Advanced
      </SystemOwnerLink>
    </Section>
  );
}

function IntegrationsSection({ data, workspaceId }: { data: OpsRuntimeData; workspaceId: string }) {
  const rows = integrationRows(data);
  return (
    <Section id="runtime-integrations" title="Integrations" description="MCP servers this workspace has configured.">
      {sourceFailed(data, "mcpServers") ? (
        <Unavailable>MCP servers could not be read.</Unavailable>
      ) : rows.length ? (
        <ul className={ROWS} aria-label="MCP servers">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium text-fg">{row.name}</span>
                <span className="ml-2 text-fg-muted">{row.kind}</span>
              </span>
              <StatusBadge status={row.status} />
            </li>
          ))}
        </ul>
      ) : (
        <Unavailable>No MCP servers are configured.</Unavailable>
      )}
      <SystemOwnerLink href="/settings/connections#mcp-servers" scope={[workspaceId, "mcp"]} className={LINK}>
        Open Settings › Connections
      </SystemOwnerLink>
    </Section>
  );
}

function RecordsAndCapabilitiesSection({ workspaceId }: { workspaceId: string }) {
  return (
    <Section title="Runtime records and capabilities">
      <ul className={ROWS}>
        <li className="py-2 text-sm text-fg-secondary">
          Runtime authority: what each part of the system last reported, and how fresh it is.
          <br />
          <SystemOwnerLink href="/system/diagnostics" scope={[workspaceId, "authority"]} className={LINK}>
            Open System › Diagnostics
          </SystemOwnerLink>
        </li>
        <li className="py-2 text-sm text-fg-secondary">
          Mesh capabilities: published tools, activation requests and revocations.
          <br />
          <SystemOwnerLink href="/library" scope={[workspaceId, "mesh"]} className={LINK}>
            Open Library › Skills and tools
          </SystemOwnerLink>
        </li>
      </ul>
    </Section>
  );
}

export function RuntimeRecordSections({
  data,
  workspaceId,
  onRefresh,
}: {
  data: OpsRuntimeData;
  workspaceId: string;
  onRefresh: () => Promise<unknown>;
}) {
  return (
    <>
      <BackupsSection data={data} workspaceId={workspaceId} onRefresh={onRefresh} />
      <LocalModelSection data={data} workspaceId={workspaceId} />
      <IntegrationsSection data={data} workspaceId={workspaceId} />
      <RecordsAndCapabilitiesSection workspaceId={workspaceId} />
    </>
  );
}
