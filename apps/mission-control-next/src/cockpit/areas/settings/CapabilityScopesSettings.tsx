import { useState } from "react";
import type { CapabilityResourceType, CapabilityScopeKind } from "@goatcitadel/contracts";
import { useCapabilityScope } from "../../../features/native-routes/settings/use-capability-scope";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

const labels: Record<CapabilityResourceType, string> = {
  skill: "Skills",
  integration: "Plugins",
  mcp_server: "MCP servers",
};
export function CapabilityScopesSettings({ scopeKind, scopeId }: { scopeKind: CapabilityScopeKind; scopeId: string }) {
  const scopeLabel = scopeKind === "citadel" ? "Citadel" : "Workspace";
  return (
    <section id={`${scopeKind}-capabilities`} aria-label={`${scopeLabel} capability selections`} className="space-y-4">
      <header>
        <h3 className="font-display text-base font-semibold text-fg">{scopeLabel} capability selections</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Choose saved references for the selected {scopeKind}. Inheritance follows future parent choices; a curated
          selection records explicit inclusions and exclusions.
        </p>
        <p className="mt-2 text-xs text-fg-muted">
          Workspace selections can only narrow their Citadel. These controls do not install, enable, connect or invoke
          capabilities. Policy, approval, grants, provenance and runtime availability remain authoritative.
        </p>
      </header>
      {(["skill", "integration", "mcp_server"] as const).map((type) => (
        <ScopeSelection
          key={`${scopeKind}:${scopeId}:${type}`}
          scopeKind={scopeKind}
          scopeId={scopeId}
          resourceType={type}
        />
      ))}
    </section>
  );
}
function ScopeSelection({
  scopeKind,
  scopeId,
  resourceType,
}: {
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  resourceType: CapabilityResourceType;
}) {
  const scope = useCapabilityScope({ scopeKind, scopeId, resourceType });
  const [search, setSearch] = useState(""),
    [limit, setLimit] = useState(30),
    [reviewLimit, setReviewLimit] = useState(30);
  const { view, review } = scope,
    title = labels[resourceType];
  const pending = scope.attempt.phase === "checking" || scope.attempt.phase === "saving";
  const items = (view?.items ?? []).filter((item) =>
    `${item.label} ${item.resourceRef}`.toLowerCase().includes(search.toLowerCase()),
  );
  const itemLabels = new Map(view?.items.map((item) => [item.resourceRef, item.label]));
  const selected = Object.values(scope.draft.value).filter(Boolean).length;
  return (
    <section aria-label={`${title} selection`} className="space-y-3 rounded-lg border border-line bg-sunken p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-display text-md font-semibold text-fg">{title}</h4>
          <p className="mt-1 text-sm text-fg-secondary">
            {view
              ? view.mode === "inherit"
                ? "Inherited from parent"
                : "Curated saved selection"
              : "Selection unavailable"}
          </p>
        </div>
        <Button size="sm" disabled={pending || scope.loading} onClick={() => void scope.reload()}>
          Refresh {title.toLowerCase()} scope
        </Button>
      </div>
      {scope.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Reading the current selection…
        </p>
      ) : null}
      {scope.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {scope.error}
        </p>
      ) : null}
      {scope.notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {scope.notice}
        </p>
      ) : null}
      {scope.attempt.message ? (
        <p role="status" className="text-sm text-status-waiting">
          {scope.attempt.message}
        </p>
      ) : null}
      {view && !scope.supported ? (
        <p role="status" className="text-sm text-status-waiting">
          Reviewed editing is unavailable for this Gateway or selection. An exact scope review and at most 1,000
          references are required.
        </p>
      ) : null}
      {scope.supported && !scope.active ? (
        <p className="text-sm text-status-waiting">Restore this scope and its Citadel before changing the selection.</p>
      ) : null}
      {scope.draft.hasRemoteChanges ? (
        <p role="status" className="text-sm text-status-waiting">
          Saved scope changed. Discard this draft to review current choices.
        </p>
      ) : null}
      <label className="block text-sm text-fg-secondary">
        Search {title.toLowerCase()}
        <input
          type="search"
          aria-label={`Search ${title.toLowerCase()} scope`}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(30);
          }}
          className="mt-1 w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent"
        />
      </label>
      {items.length ? (
        <ul className="space-y-2">
          {items.slice(0, limit).map((item) => (
            <li key={item.resourceRef} className="rounded-md border border-line-subtle px-3 py-2">
              <label className="flex items-start gap-3 text-sm text-fg">
                <input
                  type="checkbox"
                  aria-label={`Select ${item.label}`}
                  className="mt-1 accent-accent"
                  disabled={!scope.supported || !scope.active || scope.loading}
                  checked={scope.draft.value[item.resourceRef] ?? item.enabled}
                  onChange={() => scope.toggle(item.resourceRef)}
                />
                <span className="min-w-0">
                  <span className="break-words font-medium">{item.label}</span>
                  <span className="mt-1 block text-xs text-fg-muted">
                    {item.available
                      ? "Listed by the current parent or registry"
                      : "Currently unavailable; saved selection is retained"}
                  </span>
                  <code className="mt-1 block break-all font-mono text-xs text-fg-muted">{item.resourceRef}</code>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : view && !scope.loading ? (
        <p className="text-sm text-fg-muted">No matching references returned.</p>
      ) : null}
      {items.length > limit ? (
        <Button size="sm" onClick={() => setLimit((value) => value + 30)}>
          Show more references
        </Button>
      ) : null}
      <p className="text-xs text-fg-muted">
        {selected} of {Object.keys(scope.draft.value).length} references selected. Current availability is
        observational; saving does not freeze it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!scope.ready || !scope.draft.isDirty}
          onClick={() => {
            setReviewLimit(30);
            scope.requestReview();
          }}
        >
          Review selection
        </Button>
        <Button disabled={!scope.ready || view?.mode === "inherit"} onClick={() => scope.requestReview(true)}>
          Review inheritance
        </Button>
        {scope.draft.isDirty ? (
          <Button disabled={pending} onClick={scope.discard}>
            Discard selection draft
          </Button>
        ) : null}
      </div>
      <Dialog
        open={Boolean(review)}
        title={review?.reset ? "Review inherited selection" : "Review capability selection"}
        description={`Apply the reviewed ${title.toLowerCase()} selection to the selected ${scopeKind}. No capability is installed, connected or invoked.`}
        onOpenChange={(open) => {
          if (!open && !pending) scope.cancelReview();
        }}
      >
        {review ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-secondary">
              {review.reset
                ? "Remove the saved selection and inherit the parent’s current and future choices."
                : `${review.assignments.filter((item) => item.enabled).length} included and ${review.assignments.filter((item) => !item.enabled).length} excluded in the complete saved selection.`}
            </p>
            {!review.reset ? (
              <div className="max-h-64 overflow-y-auto">
                <ul className="space-y-2 text-sm">
                  {review.assignments.slice(0, reviewLimit).map((item) => (
                    <li key={item.resourceRef} className="break-words">
                      {item.enabled ? "Include" : "Exclude"}: {itemLabels.get(item.resourceRef) ?? item.resourceRef}
                    </li>
                  ))}
                </ul>
                {review.assignments.length > reviewLimit ? (
                  <Button size="sm" onClick={() => setReviewLimit((value) => value + 30)}>
                    Show more reviewed references
                  </Button>
                ) : null}
              </div>
            ) : null}
            <details className="text-xs text-fg-muted">
              <summary className="cursor-pointer">Scope binding</summary>
              <p className="mt-2">
                {scopeKind}: <code className="break-all font-mono">{scopeId}</code>
              </p>
              <p>
                Citadel: <code className="break-all font-mono">{review.before.selectionReview.citadelId}</code>
              </p>
              <p>
                Revision: <code className="break-all font-mono">{review.before.selectionReview.revision}</code>
              </p>
            </details>
            {scope.error ? (
              <p role="alert" className="text-sm text-status-failed">
                {scope.error}
              </p>
            ) : null}
            {scope.attempt.message ? (
              <p role="status" className="text-sm text-status-waiting">
                {scope.attempt.message}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button disabled={!scope.ready} onClick={() => void scope.confirm()}>
                Apply reviewed selection
              </Button>
              <Button disabled={pending} onClick={scope.cancelReview}>
                Cancel scope review
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
