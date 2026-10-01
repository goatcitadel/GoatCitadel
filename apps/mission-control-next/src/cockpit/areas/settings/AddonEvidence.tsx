import type { AddonCatalogEntry, AddonStatusRecord } from "@goatcitadel/contracts";

export function AddonCommands({ addon }: { addon: AddonCatalogEntry }) {
  return (
    <section aria-label="Repository and installation commands" className="space-y-2 text-sm">
      <h4 className="font-semibold">Repository and installation commands</h4>
      <p className="break-all">Repository: {addon.repoUrl}</p>
      <p>
        Owner: {addon.owner} · Trust tier: {addon.trustTier}
      </p>
      <p>
        {addon.sameOwnerAsGoatCitadel ? "Catalog records the same owner as GoatCitadel." : "Separate repository owner."}{" "}
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
      {!addon.installCommands.length ? <p>No commands advertised by this owner.</p> : null}
    </section>
  );
}

export function AddonEvidence({ status }: { status: AddonStatusRecord }) {
  const record = status.installed;
  return (
    <div className="space-y-3">
      <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2 text-sm">
        <dt>Gateway status</dt>
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
            <dt>Installed revision</dt>
            <dd className="break-all">{record.installRef ?? "Not reported"}</dd>
            <dt>Installed</dt>
            <dd className="break-words">{record.installedAt}</dd>
            <dt>Updated</dt>
            <dd className="break-words">{record.updatedAt}</dd>
            <dt>Consent</dt>
            <dd className="break-words">
              {record.consentedBy} · {record.consentedAt}
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
      {record?.lastError ? (
        <p role="status" className="break-words text-sm text-status-failed">
          Recorded error: {record.lastError}
        </p>
      ) : null}
      <section aria-label="Add-on health checks" className="space-y-2">
        <h4 className="text-sm font-semibold">Owner health checks</h4>
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
