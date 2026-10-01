import { useMemo, useState } from "react";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useTrustPolicySnapshot } from "../../../features/native-routes/settings/use-trust-policy-snapshot";
import { buildTrustPolicyRows } from "../../../features/native-routes/settings/trust-policy-rows";
import {
  filterTrustPolicyRows,
  formatEvidenceDate,
  formatLastUse,
  formatList,
  labelForCallableState,
  labelForTrustPolicyStatus,
} from "../../../features/native-routes/settings/trust-policy-filters";
import {
  labelForKind,
  normalizeDeclaredGovernance,
} from "../../../features/native-routes/settings/trust-policy-governance";
import {
  STATUS_ORDER,
  type TrustPolicyKindFilter,
  type TrustPolicyMatrixRow,
  type TrustPolicyStatusFilter,
} from "../../../features/native-routes/settings/trust-policy-types";

const PAGE_SIZE = 48;
const fieldClass = "mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg";
const OWNER_LINKS: Record<string, string> = {
  "Settings / Permissions": "/settings/safety#permission-profile",
  "Settings / Tools": "/settings/tools?shell=classic",
  "Settings / MCP": "/settings/connections#mcp-servers",
  "Settings / Add-ons": "/settings/addons?shell=classic",
  "Library / Capabilities": "/library/capabilities?shell=classic",
  "Library / Skills": "/library?type=skill&shell=cockpit",
  "Ops / Approvals": "/ops/approvals?shell=classic",
};

export function TrustPolicySettings() {
  const { navigate } = useCockpitRoute();
  const { loading, error, data, reload } = useTrustPolicySnapshot();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TrustPolicyStatusFilter>("all");
  const [kindFilter, setKindFilter] = useState<TrustPolicyKindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const rows = useMemo(() => buildTrustPolicyRows(data?.snapshot), [data?.snapshot]);
  const filtered = useMemo(
    () => filterTrustPolicyRows(rows, { search, statusFilter, kindFilter }),
    [rows, search, statusFilter, kindFilter],
  );
  const selected = rows.find((row) => row.id === selectedId);
  const ownerHref = selected && OWNER_LINKS[selected.owner ?? ""];
  return (
    <section
      id="trust-policy"
      aria-label="Trust and policy"
      className="mt-4 space-y-3 border-t border-line-subtle pt-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-base font-semibold text-fg">Trust and policy</h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Read-only Gateway snapshot across recorded scopes. Profiles, grants, sources and retained usage evidence may
            have different scopes.
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            Recorded posture does not authorize a specific invocation. Policy, approvals and grants are enforced by
            their runtime owners.
          </p>
        </div>
        <Button size="sm" disabled={loading} onClick={() => void reload()}>
          Refresh trust snapshot
        </Button>
      </header>
      {loading ? (
        <p role="status" className="text-sm text-fg-muted">
          {data ? "Refreshing trust evidence; previous observation remains visible." : "Loading trust snapshot…"}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-status-failed">
          Trust snapshot unavailable: {error}
        </p>
      ) : null}
      {data ? (
        <>
          <p className="text-xs text-fg-muted">
            Snapshot observed: {formatEvidenceDate(data.snapshot.generatedAt) ?? "Time unavailable"}
          </p>
          {data.issues.length ? (
            <div role="status" className="rounded-md border border-line p-3 text-sm text-status-waiting">
              <p>Partial snapshot. Unavailable sources are not empty or healthy.</p>
              <ul className="mt-1 list-disc pl-5">
                {data.issues.map((issue, index) => (
                  <li key={`${issue.label}:${index}`}>
                    {issue.label}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <details className="rounded-md border border-line-subtle p-3 text-sm text-fg-secondary">
            <summary className="cursor-pointer">Snapshot sources and enforcement</summary>
            <ul className="mt-2 space-y-1">
              {data.snapshot.sources.map((source) => (
                <li key={source.key}>
                  {source.owner} ·{" "}
                  {source.status === "available" ? `${source.itemCount} records returned` : "Unavailable"}
                </li>
              ))}
            </ul>
            <p className="mt-2">Enforcement sources: {data.snapshot.enforcementSources.join(", ") || "Not supplied"}</p>
          </details>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm text-fg-secondary">
              Search trust evidence
              <input
                type="search"
                className={fieldClass}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setLimit(PAGE_SIZE);
                }}
              />
            </label>
            <label className="text-sm text-fg-secondary">
              Recorded posture
              <select
                className={fieldClass}
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as TrustPolicyStatusFilter);
                  setLimit(PAGE_SIZE);
                }}
              >
                <option value="all">All postures</option>
                <option value="needs_review">Needs review</option>
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {labelForTrustPolicyStatus(status)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-fg-secondary">
              Evidence type
              <select
                className={fieldClass}
                value={kindFilter}
                onChange={(event) => {
                  setKindFilter(event.target.value as TrustPolicyKindFilter);
                  setLimit(PAGE_SIZE);
                }}
              >
                <option value="all">All types</option>
                <option value="capability">Capabilities</option>
                <option value="tool">Tools</option>
                <option value="source">Sources</option>
              </select>
            </label>
          </div>
          <p role="status" className="text-xs text-fg-muted">
            {filtered.length} matching rows · {rows.length} rows returned by available sources
          </p>
          {filtered.length ? (
            <ul
              aria-label="Trust evidence rows"
              className="divide-y divide-line-subtle rounded-md border border-line-subtle"
            >
              {filtered.slice(0, limit).map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="w-full rounded-md p-3 text-left hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent"
                    onClick={() => setSelectedId(row.id)}
                    aria-label={`Inspect trust evidence ${row.label}`}
                  >
                    <span className="block break-words text-sm font-medium text-fg">{row.label}</span>
                    <span className="mt-1 block text-xs text-fg-secondary">
                      {labelForKind(row.kind)} · {labelForTrustPolicyStatus(row.status)} · {row.owner}
                    </span>
                    <span className="mt-1 block break-words text-xs text-fg-muted">
                      {row.blockers?.[0] ?? row.actionNeeded}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">
              {rows.length
                ? "No trust evidence matches these filters."
                : "No rows were returned by the available snapshot sources."}
            </p>
          )}
          {filtered.length > limit ? (
            <Button size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              Show more trust evidence
            </Button>
          ) : null}
        </>
      ) : null}
      <Dialog
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        title={selected ? `Trust evidence: ${selected.label}` : "Trust evidence unavailable"}
        description="Recorded evidence from the Gateway snapshot. Open the responsible owner to review or change runtime state."
      >
        {selected && data ? (
          <>
            <TrustEvidenceDetail row={selected} />
            {ownerHref?.includes("shell=classic") ? (
              <ClassicOwnerLink
                href={ownerHref}
                scope={selected.id}
                label={`Open ${selected.owner} in detailed settings`}
                className="mt-4 inline-block text-sm font-medium text-accent hover:underline"
              />
            ) : ownerHref ? (
              <a
                href={ownerHref}
                className="mt-4 inline-block text-sm font-medium text-accent hover:underline"
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  setSelectedId(null);
                  navigate(ownerHref);
                }}
              >
                Open {selected.owner}
              </a>
            ) : null}
          </>
        ) : (
          <p role="status" className="text-sm text-fg-secondary">
            This row is unavailable in the latest snapshot. Refresh or inspect the responsible owner.
          </p>
        )}
      </Dialog>
    </section>
  );
}

function TrustEvidenceDetail({ row }: { row: TrustPolicyMatrixRow }) {
  const governance = normalizeDeclaredGovernance(row.declaredMetadata);
  const facts = [
    ["Evidence ID", row.id],
    ["Recorded posture", labelForTrustPolicyStatus(row.status)],
    ["Recorded callability", labelForCallableState(row)],
    ["Source", row.source ?? "Unavailable"],
    ["Trust state", row.trustState ?? "Unknown"],
    ["Recorded grants and declarations", formatList(row.grants, "None recorded")],
    ["Blockers", formatList(row.blockers, "None reported")],
    ["Owner action", row.actionNeeded ?? "Inspect the owner"],
    ["Last-use evidence", formatLastUse(row)],
  ];
  return (
    <div className="space-y-3 text-sm text-fg-secondary">
      <dl className="space-y-2">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium text-fg">{label}</dt>
            <dd className="whitespace-pre-wrap break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {row.missingRequiredEnv?.length ? (
        <p>Missing required environment names: {row.missingRequiredEnv.join(", ")}</p>
      ) : null}
      {row.bundleWarnings?.length ? (
        <ul className="list-disc pl-5">
          {row.bundleWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {governance ? (
        <details>
          <summary className="cursor-pointer font-medium text-fg">Declared governance</summary>
          <dl className="mt-2 space-y-2">
            <div>
              <dt>Required environment names</dt>
              <dd>
                {governance.requiredEnv
                  .map((item) => `${item.name}${item.secret ? " (secret value not shown)" : ""}`)
                  .join(", ") || "None declared"}
              </dd>
            </div>
            <div>
              <dt>State directories</dt>
              <dd className="break-words">
                {governance.stateDirs
                  .map((item) => `${item.path} (${item.writeable ? "writable" : "read"})`)
                  .join(", ") || "None declared"}
              </dd>
            </div>
            <div>
              <dt>Tool dependencies</dt>
              <dd>{governance.dependencies.tools.join(", ") || "None declared"}</dd>
            </div>
            <div>
              <dt>Skill dependencies</dt>
              <dd>{governance.dependencies.skillIds.join(", ") || "None declared"}</dd>
            </div>
            <div>
              <dt>Capability dependencies</dt>
              <dd>{governance.dependencies.capabilities.join(", ") || "None declared"}</dd>
            </div>
          </dl>
        </details>
      ) : null}
    </div>
  );
}
