import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { McpServerCategory, McpServerTemplateRecord } from "@goatcitadel/contracts";
import { fetchSettings, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { presentChangeStatusLabel } from "./settings-vocabulary";
import { isBaseUrlAllowlisted } from "./web-search-state";

const PAGE_SIZE = 12;
const CATEGORY_LABELS: Record<McpServerCategory, string> = {
  development: "Development",
  browser: "Browser",
  automation: "Work and business apps",
  research: "Research and reference",
  data: "Data and analytics",
  creative: "Design and content",
  orchestration: "GoatCitadel internal",
  other: "Other",
};

type TemplateItem = McpServerTemplateRecord & { installed?: boolean };

/** How the operator signs in, in plain words. Server policy decides what actually happens. */
export function describeMcpTemplateSignIn(template: McpServerTemplateRecord): string {
  if (template.authType === "none") return template.transport === "stdio" ? "Runs locally" : "No sign-in";
  if (template.authType === "token") return "Token from an allowed environment variable";
  return template.oauth?.metadataDiscovery ? "Sign in with the provider (automatic setup)" : "Sign in with OAuth";
}

export function filterMcpTemplates(items: readonly TemplateItem[], search: string, category: string): TemplateItem[] {
  const needle = search.trim().toLowerCase();
  return items.filter(
    (item) =>
      (category === "all" || item.category === category) &&
      (!needle || `${item.label} ${item.description} ${item.templateId}`.toLowerCase().includes(needle)),
  );
}

export function McpTemplateCatalog({
  items,
  disabled,
  onUse,
}: {
  items: readonly TemplateItem[];
  disabled: boolean;
  onUse: (template: McpServerTemplateRecord) => void;
}) {
  const [search, setSearch] = useState(""),
    [category, setCategory] = useState("all"),
    [limit, setLimit] = useState(PAGE_SIZE);
  const settings = useQuery({ queryKey: ["settings", "mcp-template-allowlist"], queryFn: fetchSettings, retry: false });
  const [allowBusy, setAllowBusy] = useState<string>();
  const [allowMessage, setAllowMessage] = useState<{ tone: "info" | "error"; text: string }>();
  const categories = useMemo(
    () =>
      [...new Set(items.map((item) => item.category))].sort((a, b) =>
        CATEGORY_LABELS[a].localeCompare(CATEGORY_LABELS[b]),
      ),
    [items],
  );
  const filtered = filterMcpTemplates(items, search, category);
  const allowlist = settings.data?.networkAllowlist;

  async function allowHosts(template: McpServerTemplateRecord, hosts: string[]) {
    setAllowBusy(template.templateId);
    setAllowMessage(undefined);
    try {
      const latest = await fetchSettings();
      const missing = hosts.filter((host) => !isBaseUrlAllowlisted(`https://${host}`, latest.networkAllowlist));
      const response = await patchSettings({
        expectedRevision: latest.revision,
        networkAllowlist: [...latest.networkAllowlist, ...missing],
      });
      const status = response.changePlanReceipt?.status;
      const list = hosts.join(", ");
      setAllowMessage(
        !status || status === "completed"
          ? { tone: "info", text: `${list} can now be reached for ${template.label}.` }
          : {
              tone: "info",
              text:
                status === "awaiting_approval"
                  ? `Allowing ${list} needs approval. Approve the allowlist change in Inbox, then connect ${template.label}.`
                  : `The allowlist change is ${presentChangeStatusLabel(status).toLowerCase()}. Finish it before connecting ${template.label}.`,
            },
      );
      await settings.refetch();
    } catch (error) {
      setAllowMessage({ tone: "error", text: `Could not change the allowlist. ${describeApiError(error).summary}` });
    } finally {
      setAllowBusy(undefined);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Search servers">
          {(field) => (
            <input
              {...field}
              type="search"
              className={cockpitInputClass}
              value={search}
              placeholder="Notion, Linear, Sentry…"
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(PAGE_SIZE);
              }}
            />
          )}
        </Field>
        <Field label="Category">
          {(field) => (
            <select
              {...field}
              className={cockpitInputClass}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setLimit(PAGE_SIZE);
              }}
            >
              <option value="all">All categories</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <p className="text-xs text-fg-muted">
        Showing {Math.min(limit, filtered.length)} of {filtered.length} servers
      </p>
      {allowMessage ? (
        <Callout tone={allowMessage.tone === "error" ? "error" : "info"}>{allowMessage.text}</Callout>
      ) : null}
      {settings.isError ? (
        <p className="text-status-failed">Network allowlist unavailable: {describeApiError(settings.error).summary}</p>
      ) : null}
      {filtered.length === 0 ? <p>No servers match this search.</p> : null}
      <ul className="divide-y divide-line-subtle">
        {filtered.slice(0, limit).map((template) => {
          const hosts = template.networkHosts ?? [];
          const blocked = allowlist ? hosts.filter((host) => !isBaseUrlAllowlisted(`https://${host}`, allowlist)) : [];
          return (
            <li key={template.templateId} className="space-y-2 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold text-fg">{template.label}</p>
                <p className="text-xs text-fg-muted">
                  {CATEGORY_LABELS[template.category]}
                  {template.installed ? " · Already registered" : ""}
                </p>
              </div>
              <p className="break-words">{template.description.slice(0, 1200)}</p>
              <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
                <dt className="font-medium text-fg-secondary">Sign-in</dt>
                <dd className="sm:col-span-3">{describeMcpTemplateSignIn(template)}</dd>
                {hosts.length ? (
                  <>
                    <dt className="font-medium text-fg-secondary">Network access</dt>
                    <dd className="break-all sm:col-span-3">
                      {hosts.join(", ")}
                      {allowlist ? (blocked.length ? " (not allowed yet)" : " (allowed)") : ""}
                    </dd>
                  </>
                ) : null}
                {template.provenance ? (
                  <>
                    <dt className="font-medium text-fg-secondary">Source</dt>
                    <dd className="sm:col-span-3">
                      Reviewed in the {template.provenance.catalog} catalog ({template.provenance.catalogLicense})
                      {template.provenance.documentationUrl ? (
                        <>
                          {" · "}
                          <a
                            href={template.provenance.documentationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent underline"
                          >
                            Vendor documentation
                          </a>
                        </>
                      ) : null}
                    </dd>
                  </>
                ) : null}
              </dl>
              {template.riskNotes?.length ? (
                <Callout tone="warning" announce={false}>
                  {template.riskNotes.join(" ")}
                </Callout>
              ) : null}
              {blocked.length ? (
                <p className="text-xs">
                  GoatCitadel cannot reach {blocked.join(", ")} until you allow it. The sign-in provider may use another
                  host; connecting names it if it is blocked.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={disabled} onClick={() => onUse(template)}>
                  Use {template.label} template
                </Button>
                {blocked.length ? (
                  <Button
                    size="sm"
                    disabled={disabled || Boolean(allowBusy)}
                    onClick={() => void allowHosts(template, blocked)}
                  >
                    {allowBusy === template.templateId ? "Allowing…" : `Allow ${blocked.join(", ")}`}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {filtered.length > limit ? (
        <Button size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
          Show more servers
        </Button>
      ) : null}
    </div>
  );
}
