import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { loadToolGrantsSnapshot } from "../../../features/native-routes/settings/tool-grants-snapshot";
import { useToolGrantActions } from "../../../features/native-routes/settings/use-tool-grant-actions";
import {
  defaultToolGrantExpiry,
  describeToolGrantAvailability,
  matchesToolGrant,
} from "../../../features/native-routes/settings/helpers/permission-helpers";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { ToolGrantDetails } from "./ToolGrantDetails";
import { ToolGrantFields } from "./ToolGrantFields";
import { RulesPrecedenceLink } from "./RulesPrecedence";
import { describeToolGrant, TOOL_GRANT_DECISION_LABELS, TOOL_GRANT_TYPE_LABELS } from "./tool-grant-labels";
import { useToolGrantScopeLabel } from "./use-tool-grant-scope";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";

const PAGE_SIZE = 30;
export function ToolGrantSettings({ workspaceId }: { workspaceId: string }) {
  const scopeLabel = useToolGrantScopeLabel();
  const [search, setSearch] = useState(""),
    [selectedTool, setSelectedTool] = useState("");
  const [grantSearch, setGrantSearch] = useState(""),
    [limit, setLimit] = useState(PAGE_SIZE);
  const [detail, setDetail] = useState<ToolGrantRecord | null>(null),
    [discardOpen, setDiscardOpen] = useState(false);
  const [expiry] = useState(defaultToolGrantExpiry);
  const owner = useQuery({ queryKey: ["settings", "tool-grants"], queryFn: loadToolGrantsSnapshot });
  const empty = {
    toolPattern: selectedTool,
    decision: "allow",
    scope: "workspace",
    scopeRef: workspaceId,
    grantType: "ttl",
    expiresAt: expiry,
  };
  const editor = useSessionDraft(
    `tool-grant:${getGatewayApiBaseUrl()}:${workspaceId}:${selectedTool || "new"}`,
    empty,
    undefined,
    {
      label: "Tool grant",
      onSave: () => reviewGrant(),
    },
  );
  const actions = useToolGrantActions(editor.key, () => owner.refetch());
  const createAttempt = actions.attemptFor("create");
  const toolsReady = Boolean(
    owner.data && !owner.isError && !owner.data.issues.some((item) => item.label === "Tool catalog"),
  );
  const grantsReady = Boolean(
    owner.data && !owner.isError && !owner.data.issues.some((item) => item.label === "Tool grants"),
  );
  const tools = toolsReady
    ? owner.data!.tools.filter((item) =>
        `${item.toolName} ${item.description ?? ""} ${item.category ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : [];
  const grants = grantsReady
    ? owner.data!.grants.filter(
        (item) =>
          (!selectedTool || matchesToolGrant(item, selectedTool)) &&
          `${item.toolPattern} ${item.scope} ${item.scopeRef} ${item.decision} ${item.grantId}`
            .toLowerCase()
            .includes(grantSearch.toLowerCase()),
      )
    : [];
  async function reviewGrant(): Promise<boolean> {
    const submitted = { ...editor.value };
    const saved = await actions.requestCreate(submitted);
    return saved ? editor.acceptSaved(empty, undefined, submitted) : false;
  }
  const review = actions.review;
  const record = review?.kind === "revoke" ? review.grant : null;
  return (
    <section
      id="tool-grants"
      aria-label="Tool catalog and grants"
      className="mt-4 space-y-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-fg">Tool catalog and grants</h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Installation-wide recorded grants, across scopes. Matching records do not establish effective permission for
            an action.
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            Hard denies, approval gates, profiles, auth, host and path boundaries remain authoritative.
          </p>
          <RulesPrecedenceLink />
        </div>
        <Button size="sm" disabled={owner.isFetching || actions.pending} onClick={() => void owner.refetch()}>
          Refresh tool records
        </Button>
      </header>
      {owner.isFetching ? (
        <p role="status" className="text-sm text-fg-muted">
          Reading tool records…
        </p>
      ) : null}
      {owner.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {describeApiError(owner.error).summary}
        </p>
      ) : null}
      {owner.data && !owner.isError
        ? owner.data.issues.map((issue) => (
            <p key={issue.label} role="status" className="text-sm text-status-waiting">
              {issue.label}: {issue.message}
            </p>
          ))
        : null}
      {actions.notice ? (
        <p role={actions.notice.tone === "error" ? "alert" : "status"} className="text-sm text-fg-secondary">
          {actions.notice.message}
        </p>
      ) : null}
      {createAttempt?.phase === "uncertain" && actions.notice?.message !== createAttempt.message ? (
        <p role="status" className="text-sm text-status-waiting">
          {createAttempt.message}
        </p>
      ) : null}
      <div className="space-y-3">
        <Field label="Find tool">
          {(fieldProps) => (
            <input
              {...fieldProps}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={cockpitInputClass}
            />
          )}
        </Field>
        <Field label="Match a catalog tool">
          {(fieldProps) => (
            <select
              {...fieldProps}
              value={selectedTool}
              disabled={!toolsReady || actions.pending}
              onChange={(event) => {
                setSelectedTool(event.target.value);
                setLimit(PAGE_SIZE);
              }}
              className={cockpitInputClass}
            >
              <option value="">All recorded grants / custom pattern</option>
              {tools.map((item) => (
                <option key={item.toolName} value={item.toolName}>
                  {item.toolName}
                </option>
              ))}
            </select>
          )}
        </Field>
        {selectedTool && toolsReady ? (
          <p className="text-sm text-fg-secondary">
            {owner.data!.tools.find((item) => item.toolName === selectedTool)?.description ??
              "Description not recorded."}
          </p>
        ) : null}
      </div>
      <div className="space-y-3 border-t border-line-subtle pt-3">
        <h4 className="text-sm font-semibold text-fg">New grant{editor.isDirty ? " · Unsaved" : ""}</h4>
        <ToolGrantFields
          draft={editor.value}
          workspaceId={workspaceId}
          disabled={Boolean(createAttempt)}
          onChange={editor.setValue}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!grantsReady || owner.isFetching || Boolean(createAttempt) || Boolean(review)}
            onClick={() => void reviewGrant()}
          >
            Review new grant
          </Button>
          <Button disabled={!editor.isDirty || actions.pending} onClick={() => setDiscardOpen(true)}>
            Discard grant draft
          </Button>
        </div>
      </div>
      <div className="space-y-3 border-t border-line-subtle pt-3">
        <h4 className="text-sm font-semibold text-fg">Recorded grants</h4>
        <Field label="Find recorded grant">
          {(fieldProps) => (
            <input
              {...fieldProps}
              type="search"
              value={grantSearch}
              onChange={(event) => {
                setGrantSearch(event.target.value);
                setLimit(PAGE_SIZE);
              }}
              className={cockpitInputClass}
            />
          )}
        </Field>
        {grantsReady && !grants.length ? (
          <p className="text-sm text-fg-muted">No recorded grants match this view.</p>
        ) : null}
        {grantsReady ? (
          <p className="text-xs text-fg-muted">
            Showing {Math.min(limit, grants.length)} of {grants.length} matching records from the latest 400 grants.
          </p>
        ) : null}
        <ul className="divide-y divide-line-subtle">
          {grants.slice(0, limit).map((grant) => {
            const attempt = actions.attemptFor(`revoke:${grant.grantId}`);
            const name = describeToolGrant(grant);
            return (
              <li key={grant.grantId} className="min-w-0 space-y-2 py-3">
                <p className="break-words text-sm font-semibold text-fg">{name}</p>
                <p className="break-words text-xs text-fg-secondary">
                  {scopeLabel(grant)} · {describeToolGrantAvailability(grant)}
                </p>
                {attempt?.phase === "uncertain" ? (
                  <p role="status" className="text-xs text-status-waiting">
                    {attempt.message}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" aria-label={`Inspect grant: ${name}`} onClick={() => setDetail(grant)}>
                    Inspect grant
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Revoke grant: ${name}`}
                    disabled={Boolean(grant.revokedAt || attempt || owner.isFetching || review)}
                    onClick={() => actions.requestRevoke(grant)}
                  >
                    Revoke grant
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {grants.length > limit ? (
          <Button size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
            Show more grants
          </Button>
        ) : null}
      </div>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) actions.cancel();
        }}
        title={record ? "Revoke tool grant" : "Review new tool grant"}
        description="Review the exact scope and consequence before you save the change."
      >
        {review?.kind === "create" ? (
          <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2 break-words text-sm text-fg">
            <dt>Pattern</dt>
            <dd>{review.input.toolPattern}</dd>
            <dt>Decision</dt>
            <dd>{TOOL_GRANT_DECISION_LABELS[review.input.decision] ?? "Unknown decision"}</dd>
            <dt>Scope</dt>
            <dd>{review.input.scope === "global" ? "Global · all contexts" : scopeLabel(review.input)}</dd>
            {review.input.scope !== "global" && review.input.scopeRef ? (
              <>
                {/* The confirmation saves exactly what was typed, so it shows it to catch a mistyped target. */}
                <dt>Applies to</dt>
                <dd>
                  <code className="font-mono">{review.input.scopeRef}</code>
                </dd>
              </>
            ) : null}
            <dt>Lifetime</dt>
            <dd>
              {review.input.grantType === "ttl" && review.input.expiresAt ? (
                // "Expires at a time · Expires …" said it twice; the dated expiry is the whole lifetime.
                <TimeText prefix="Expires" absolute value={review.input.expiresAt} />
              ) : (
                <>
                  {review.input.grantType
                    ? (TOOL_GRANT_TYPE_LABELS[review.input.grantType] ?? "Unknown type")
                    : "Not set"}
                  {review.input.expiresAt ? (
                    <>
                      {" · "}
                      <TimeText prefix="Expires" absolute value={review.input.expiresAt} />
                    </>
                  ) : null}
                </>
              )}
            </dd>
          </dl>
        ) : null}
        {review?.kind === "create" &&
        review.input.decision === "allow" &&
        (review.input.scope === "global" ||
          review.input.toolPattern.includes("*") ||
          review.input.grantType === "persistent") ? (
          <p role="alert" className="my-3 text-status-waiting">
            This grant widens access: {review.input.toolPattern} in{" "}
            {review.input.scope === "global" ? "every context" : scopeLabel(review.input)}.{" "}
            {review.input.grantType === "persistent"
              ? "It remains available until explicitly revoked."
              : "Matching actions can use it until its recorded expiry."}{" "}
            Review every matching target before proceeding.
          </p>
        ) : null}
        {record ? (
          <div className="space-y-2 break-words text-sm text-fg">
            <p>
              {record.toolPattern} · {TOOL_GRANT_DECISION_LABELS[record.decision] ?? "Unknown decision"}
            </p>
            <p>{scopeLabel(record)}</p>
            <p>Revocation cannot be undone.</p>
            <TechnicalDetails label="Grant identity">
              <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
                <dt>Grant ID</dt>
                <dd className="break-all font-mono text-xs">{record.grantId}</dd>
                <dt>Scope reference</dt>
                <dd className="break-all font-mono text-xs">{record.scopeRef}</dd>
              </dl>
            </TechnicalDetails>
          </div>
        ) : null}
        <p className="my-3 text-sm text-fg-secondary">
          Deny rules, approval gates and other runtime boundaries still apply.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={
              record ||
              (review?.kind === "create" &&
                review.input.decision === "allow" &&
                (review.input.scope === "global" ||
                  review.input.toolPattern.includes("*") ||
                  review.input.grantType === "persistent"))
                ? "danger"
                : "primary"
            }
            disabled={actions.pending}
            onClick={() => void actions.confirm()}
          >
            {record ? "Confirm revocation" : "Create reviewed grant"}
          </Button>
          <Button disabled={actions.pending} onClick={actions.cancel}>
            Cancel
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard grant draft"
        description="Discard this app-session draft without changing any saved grant."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            onClick={() => {
              editor.discard();
              setDiscardOpen(false);
            }}
          >
            Discard draft
          </Button>
          <Button onClick={() => setDiscardOpen(false)}>Keep draft</Button>
        </div>
      </Dialog>
      <ToolGrantDetails grant={detail} onClose={() => setDetail(null)} />
    </section>
  );
}
