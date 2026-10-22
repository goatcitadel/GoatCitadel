import type { AddonCatalogEntry, AddonStatusRecord } from "@goatcitadel/contracts";
import { presentErrorText } from "../../lib/present-error";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";

export function AddonCommands({ addon }: { addon: AddonCatalogEntry }) {
  return (
    <section aria-label="Repository and installation commands" className="space-y-2 text-sm">
      <h4 className="font-semibold">Repository and installation commands</h4>
      <p className="break-all">Repository: {addon.repoUrl}</p>
      <p>
        Publisher: {addon.owner} · Trust tier: {addon.trustTier}
      </p>
      <p>
        {addon.sameOwnerAsGoatCitadel
          ? "The catalog lists the same publisher as GoatCitadel."
          : "Published by a separate repository."}{" "}
        The trust label does not isolate downloaded code from this host.
      </p>
      <ol className="list-decimal space-y-3 pl-5">
        {addon.installCommands.map((command, index) => (
          <li key={index}>
            <code className="whitespace-pre-wrap break-all text-xs">
              {command.command}
              {(command.args ?? []).map((arg) => ` ${JSON.stringify(arg)}`).join("")}
            </code>
            {command.note ? <p className="mt-1 break-words text-xs text-fg-secondary">{command.note}</p> : null}
          </li>
        ))}
      </ol>
      {!addon.installCommands.length ? <p>This add-on lists no commands.</p> : null}
    </section>
  );
}

export function AddonEvidence({ status }: { status: AddonStatusRecord }) {
  const record = status.installed;
  return (
    <div className="space-y-3">
      <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2 text-sm">
        <dt>Status</dt>
        <dd>{status.status.replaceAll("_", " ")}</dd>
        <dt>Runtime</dt>
        <dd>{status.addon.runtimeType.replaceAll("_", " ")}</dd>
        <dt>Web entry</dt>
        <dd>{status.addon.webEntryMode.replaceAll("_", " ")}</dd>
        <dt>Launch URL</dt>
        <dd className="break-all">{record?.launchUrl ?? status.addon.launchUrl ?? "Not reported"}</dd>
        {record ? (
          <>
            <dt>Enabled</dt>
            <dd>{record.enabled === false || status.status === "disabled" ? "No" : "Yes"}</dd>
            <dt>Installed path</dt>
            <dd className="break-all">{record.installedPath}</dd>
            <dt>Installed version</dt>
            <dd className="break-all">{record.installRef ?? "Not reported"}</dd>
            <dt>Installed</dt>
            <dd className="break-words">
              <TimeText value={record.installedAt} />
            </dd>
            <dt>Updated</dt>
            <dd className="break-words">
              <TimeText value={record.updatedAt} />
            </dd>
            <dt>Consent</dt>
            <dd className="break-words">
              {record.consentedBy} · <TimeText value={record.consentedAt} />
            </dd>
            {record.pid ? (
              <>
                <dt>Recorded process</dt>
                <dd>{record.pid}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {record?.lastError ? <AddonRecordedError error={record.lastError} /> : null}
      <section aria-label="Add-on health checks" className="space-y-2">
        <h4 className="text-sm font-semibold">Health checks</h4>
        <ul className="space-y-2 text-sm">
          {status.healthChecks.map((check, index) => (
            <li key={`${check.key}:${index}`} className="break-words">
              <span className="font-medium">
                {check.key}: {check.status}
              </span>{" "}
              · {check.message}
            </li>
          ))}
        </ul>
        {!status.healthChecks.length ? <p className="text-sm text-fg-muted">No health checks returned.</p> : null}
      </section>
    </div>
  );
}

/** The add-on's recorded error: one plain line, with the recorded text in technical details. */
function AddonRecordedError({ error }: { error: string }) {
  const { summary, detail } = presentErrorText(error);
  return (
    <div className="space-y-1">
      <p role="status" className="break-words text-sm text-status-failed">
        Recorded error: {summary}
      </p>
      {detail ? (
        <TechnicalDetails label="Recorded error">
          <p className="break-all font-mono text-xs">{detail}</p>
        </TechnicalDetails>
      ) : null}
    </div>
  );
}
