import { useMemo, useState } from "react";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { resolveCockpitContinuation } from "../../app/cockpit-compatibility";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
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
const fieldClass = "mt-1 block min-h-11 w-full rounded-md border border-line-control bg-canvas px-2 text-sm text-fg";
const OWNER_LINKS: Record<string, string> = {
  "Settings / Permissions": "/settings/safety#permission-profile",
  "Settings / Tools": "/settings/safety#approval-mode",
  "Settings / MCP": "/settings/connections#mcp-servers",
  "Settings / Add-ons": "/settings/connections#addons",
  "Library / Candidates and mesh": "/library?shell=cockpit",
  "Capabilities / Skills": "/capabilities/skills?shell=cockpit",
  "Ops / Approvals": "/inbox?view=history&shell=cockpit",
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
  const destination = selected && OWNER_LINKS[selected.owner ?? ""];
  const owner = destination
    ? resolveCockpitContinuation(destination, { search: window.location.search, hash: window.location.hash })
    : undefined;
  const ownerHref = owner?.kind === "native" ? owner.href : undefined;
  return (
    <section
      id="trust-policy"
      aria-label="Trust and policy"
      className="mt-4 space-y-3 border-t border-line-subtle pt-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-fg">Trust and policy</h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Read-only view of recorded trust. Profiles, grants, sources and usage records may cover different scopes.
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            A recorded trust state does not allow any specific action. Policy, approvals and grants are still checked
            every time.
          </p>
        </div>
        <Button size="sm" disabled={loading} onClick={() => void reload()}>
          Refresh trust records
        </Button>
      </header>
      {loading ? (
        <p role="status" className="text-sm text-fg-muted">
          {data ? "Refreshing trust records; the previous records stay visible." : "Loading trust records…"}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-status-failed">
          Trust records unavailable: {error}
        </p>
      ) : null}
      {data ? (
        <>
          <p className="text-xs text-fg-muted">
            Checked: {formatEvidenceDate(data.snapshot.generatedAt) ?? "Time unavailable"}
          </p>
          {data.issues.length ? (
            <div role="status" className="rounded-md border border-line p-3 text-sm text-status-waiting">
              <p>Partial records. Unavailable sources are not empty or healthy.</p>
              <ul className="mt-1 list-disc pl-5">
                {data.issues.map((issue, index) => (
                  <li key={`${issue.label}:${index}`}>
                    {issue.label}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <details className="border-t border-line-subtle pt-3 text-sm text-fg-secondary">
            <summary className="cursor-pointer">Sources and enforcement</summary>
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
              Search trust records
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
              Recorded state
              <select
                className={fieldClass}
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as TrustPolicyStatusFilter);
                  setLimit(PAGE_SIZE);
                }}
              >
                <option value="all">All states</option>
                <option value="needs_review">Needs review</option>
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {labelForTrustPolicyStatus(status)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-fg-secondary">
              Type
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
            <ul aria-label="Trust records" className="divide-y divide-line-subtle rounded-md border border-line-subtle">
              {filtered.slice(0, limit).map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="w-full rounded-md p-3 text-left hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent"
                    onClick={() => setSelectedId(row.id)}
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
                ? "No trust records match these filters."
                : "No rows were returned by the available sources."}
            </p>
          )}
          {filtered.length > limit ? (
            <Button size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              Show more trust records
            </Button>
          ) : null}
        </>
      ) : null}
      <Dialog
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        title={selected ? `Trust record: ${selected.label}` : "Trust record unavailable"}
        description="Recorded in the latest trust records. To change it, open the page that manages it."
      >
        {selected && data ? (
          <>
            <TrustEvidenceDetail row={selected} />
            {ownerHref ? (
              <a
                href={ownerHref}
                className="mt-4 inline-block text-sm font-medium text-accent hover:underline"
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
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
            This row is not in the latest records. Refresh trust records and try again.
          </p>
        )}
      </Dialog>
    </section>
  );
}

function TrustEvidenceDetail({ row }: { row: TrustPolicyMatrixRow }) {
  const governance = normalizeDeclaredGovernance(row.declaredMetadata);
  const facts = [
    ["Record ID", row.id],
    ["Recorded state", labelForTrustPolicyStatus(row.status)],
    ["Recorded callability", labelForCallableState(row)],
    ["Source", row.source ?? "Unavailable"],
    ["Trust state", row.trustState ?? "Unknown"],
    ["Recorded grants and declarations", formatList(row.grants, "None recorded")],
    ["Blockers", formatList(row.blockers, "None reported")],
    ["Action needed", row.actionNeeded ?? "None reported"],
    ["Last used", formatLastUse(row)],
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
