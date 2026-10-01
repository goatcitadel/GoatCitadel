import { useState } from "react";
import { useAddonSettings } from "../../../features/native-routes/settings/sections/use-addon-settings";
import {
  ADDON_ACTIONS,
  ADDON_OWNER_BOUNDARY,
  addonActionAvailable,
  addonReviewDescription,
} from "../../../features/native-routes/settings/sections/addon-owner-binding";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { integrationInputClass } from "./IntegrationFormFields";
import { AddonCommands, AddonEvidence } from "./AddonEvidence";

export function AddonsSettings() {
  const owner = useAddonSettings();
  const [query, setQuery] = useState(""),
    [limit, setLimit] = useState(10);
  const catalog = owner.data?.catalog ?? [],
    installed = owner.data?.installed ?? [];
  const filtered = catalog.filter((item) =>
    `${item.label} ${item.description} ${item.owner} ${item.addonId}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selected = owner.selectedStatus;
  const missingCatalog = installed.filter((item) => !catalog.some((entry) => entry.addonId === item.addonId));
  return (
    <section id="addons" aria-label="Add-on applications" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="font-display text-lg font-semibold">Add-on applications</h3>
        <Button disabled={owner.loading || owner.mutation.pending} onClick={() => void owner.reload()}>
          Refresh add-on evidence
        </Button>
      </div>
      <p className="text-sm text-fg-secondary">{ADDON_OWNER_BOUNDARY}</p>
      <p className="text-xs text-fg-muted">
        Installation-wide controls. Installing an add-on does not grant tool authority or activate a capability pack.
      </p>
      {owner.loading ? (
        <p role="status" className="text-sm">
          Loading add-on evidence…
        </p>
      ) : null}
      {owner.error ? (
        <p role="alert" className="text-sm text-status-failed">
          The add-on catalog and installation evidence could not load. Refresh before reviewing an action.
        </p>
      ) : null}
      {owner.notice ? (
        <p role="status" className="break-words text-sm">
          {owner.notice.message}
        </p>
      ) : null}
      {owner.mutation.message ? (
        <p role="alert" className="break-words text-sm text-status-waiting">
          {owner.mutation.message}
        </p>
      ) : null}
      <label className="block text-sm">
        Find add-ons
        <input
          aria-label="Find add-ons"
          type="search"
          className={integrationInputClass}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(10);
          }}
        />
      </label>
      {owner.data ? (
        <>
          <p className="text-xs text-fg-muted">
            {filtered.length} matching catalog entries · {installed.length} installed records returned.
          </p>
          {!filtered.length ? (
            <p className="text-sm text-fg-muted">No matching add-ons returned.</p>
          ) : (
            <ul className="space-y-2">
              {filtered.slice(0, limit).map((addon) => (
                <li key={addon.addonId}>
                  <Button
                    className="h-auto w-full justify-start whitespace-normal text-left"
                    aria-pressed={owner.selectedAddonId === addon.addonId}
                    onClick={() => owner.selectAddon(addon.addonId)}
                  >
                    {addon.label}
                  </Button>
                  <p className="mt-1 break-words text-xs text-fg-secondary">{addon.description}</p>
                  <p className="text-xs text-fg-muted">
                    {installed.some((item) => item.addonId === addon.addonId)
                      ? "Installed record returned; open for current status."
                      : "No installed record returned."}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {filtered.length > limit ? (
            <Button onClick={() => setLimit((value) => value + 10)}>Show more add-ons</Button>
          ) : null}
          {missingCatalog.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer">
                Installed records missing from this catalog ({missingCatalog.length})
              </summary>
              <ul className="mt-2 space-y-2">
                {missingCatalog.slice(0, limit).map((record) => (
                  <li key={record.addonId} className="break-all">
                    {record.addonId} · {record.runtimeStatus} · {record.installedPath}. Current catalog authority is
                    unavailable; no lifecycle action is offered.
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
      {owner.selectedAddonId ? (
        <section aria-label="Selected add-on" className="space-y-4 rounded-md border border-line-subtle p-3">
          {owner.statusLoading ? (
            <p role="status" className="text-sm">
              Loading selected add-on status…
            </p>
          ) : null}
          {owner.statusError ? (
            <p role="alert" className="text-sm text-status-failed">
              Selected add-on status unavailable: {owner.statusError}
            </p>
          ) : null}
          {selected ? (
            <>
              <h4 className="break-words font-display text-md font-semibold">{selected.addon.label}</h4>
              <p className="break-words text-sm text-fg-secondary">{selected.addon.description}</p>
              <AddonEvidence status={selected} />
              <div aria-label="Add-on lifecycle actions" className="flex flex-wrap gap-2">
                {ADDON_ACTIONS.map((action) => (
                  <Button
                    key={action}
                    variant={action === "uninstall" ? "danger" : "secondary"}
                    disabled={
                      owner.mutation.locked ||
                      owner.loading ||
                      Boolean(owner.error) ||
                      owner.statusLoading ||
                      !addonActionAvailable(action, selected)
                    }
                    onClick={() => owner.reviewAction(action)}
                  >
                    Review {action}
                  </Button>
                ))}
              </div>
              <details>
                <summary className="cursor-pointer text-sm">Inspect repository, commands and declared UI slots</summary>
                <div className="mt-3 space-y-3">
                  <AddonCommands addon={selected.addon} />
                  <ul className="space-y-1 text-xs">
                    {selected.addon.dashboardSlots?.map((slot, index) => (
                      <li key={index} className="break-words">
                        {slot.slot} · route {slot.route ?? "all declared routes"} · priority{" "}
                        {slot.priority ?? "default"}
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            </>
          ) : !owner.statusLoading && !owner.statusError ? (
            <p className="text-sm text-fg-muted">No current status record is available.</p>
          ) : null}
        </section>
      ) : null}
      <Dialog
        open={Boolean(owner.review)}
        title={
          owner.review ? `Review ${owner.review.action}: ${owner.review.status.addon.label}` : "Review add-on action"
        }
        description={owner.review ? addonReviewDescription(owner.review.action, owner.review.status) : undefined}
        onOpenChange={(open) => {
          if (!open && !owner.mutation.pending) owner.cancelReview();
        }}
      >
        {owner.review ? <AddonCommands addon={owner.review.status.addon} /> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="danger" disabled={owner.mutation.locked} onClick={() => void owner.confirmReview()}>
            Apply reviewed add-on action
          </Button>
          <Button disabled={owner.mutation.pending} onClick={owner.cancelReview}>
            Cancel add-on action
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
