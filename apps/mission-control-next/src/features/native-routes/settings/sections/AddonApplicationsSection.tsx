import { useState } from "react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { DetailInspector } from "../../../../components/DetailInspector";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import { SettingsActionList, SettingsButtonRow, SettingsField, SettingsNotice, SettingsStack } from "../SettingsShared";
import { useAddonSettings } from "./use-addon-settings";
import {
  ADDON_ACTIONS,
  ADDON_OWNER_BOUNDARY,
  addonActionAvailable,
  addonReviewDescription,
} from "./addon-owner-binding";

export function AddonApplicationsSection() {
  const owner = useAddonSettings(),
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(30);
  const catalog = (owner.data?.catalog ?? []).filter((item) =>
    `${item.label} ${item.description} ${item.owner}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selected = owner.selectedStatus;
  const missing = (owner.data?.installed ?? []).filter(
    (item) => !owner.data?.catalog.some((entry) => entry.addonId === item.addonId),
  );
  return (
    <SettingsStack>
      <p>Experimental local extensions · operator-reviewed installation</p>
      <p>{ADDON_OWNER_BOUNDARY}</p>
      <SettingsButtonRow>
        <NativeButton disabled={owner.loading || owner.mutation.pending} onClick={() => void owner.reload()}>
          {owner.error ? "Retry" : "Refresh add-on evidence"}
        </NativeButton>
      </SettingsButtonRow>
      {owner.loading ? <p role="status">Reading add-on owner evidence…</p> : null}
      {owner.error ? <p role="alert">Add-on evidence unavailable: {owner.error}</p> : null}
      {owner.notice ? <SettingsNotice notice={owner.notice} /> : null}
      {owner.mutation.message ? <p role="alert">{owner.mutation.message}</p> : null}
      <SettingsField label="Find add-ons">
        <input
          aria-label="Find add-ons"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(30);
          }}
        />
      </SettingsField>
      <NativeCard
        title="Add-on catalog"
        subtitle="Installation-wide applications; opening a record does not install or launch it."
      >
        <SettingsActionList
          ariaLabel="Add-on catalog entries"
          items={catalog.slice(0, limit).map((addon) => ({
            id: addon.addonId,
            label: addon.label,
            description: addon.description,
            meta: `${addon.owner} · ${addon.trustTier}`,
            actionLabel: "Inspect",
            onClick: () => owner.selectAddon(addon.addonId),
          }))}
          emptyLabel="No matching add-ons returned."
        />
        {catalog.length > limit ? (
          <NativeButton onClick={() => setLimit((value) => value + 30)}>Show more add-ons</NativeButton>
        ) : null}
      </NativeCard>
      {missing.length ? (
        <NativeDisclosureCard id="addon-unavailable-catalog" title="Installed records absent from the catalog">
          <SettingsActionList
            ariaLabel="Unmatched installed add-ons"
            items={missing
              .slice(0, 30)
              .map((item) => ({
                id: item.addonId,
                label: item.addonId,
                description: item.installedPath,
                meta: item.runtimeStatus,
              }))}
          />
          <p>These records are inspectable. Lifecycle actions require an available current catalog owner.</p>
        </NativeDisclosureCard>
      ) : null}
      <DetailInspector
        open={Boolean(owner.selectedAddonId)}
        title={selected?.addon.label ?? "Add-on evidence"}
        onClose={() => owner.selectAddon("")}
      >
        {owner.statusLoading ? <p role="status">Loading add-on status…</p> : null}
        {owner.statusError ? <p role="alert">Add-on status unavailable: {owner.statusError}</p> : null}
        {selected ? (
          <>
            <p>{selected.addon.description}</p>
            <NativeMetricGrid
              items={[
                { label: "Runtime", value: selected.status, meta: selected.addon.runtimeType },
                { label: "Trust", value: selected.addon.trustTier, meta: selected.addon.owner },
                {
                  label: "Installation",
                  value: selected.installed ? "Record returned" : "Not installed",
                  meta: selected.installed?.updatedAt ?? "No saved installation",
                },
              ]}
            />
            <SettingsButtonRow>
              {ADDON_ACTIONS.map((action) => (
                <NativeButton
                  key={action}
                  variant={action === "uninstall" ? "destructive" : "secondary"}
                  disabled={owner.mutation.locked || !addonActionAvailable(action, selected)}
                  onClick={() => owner.reviewAction(action)}
                >
                  {action[0]!.toUpperCase() + action.slice(1)}
                </NativeButton>
              ))}
            </SettingsButtonRow>
            <NativeDisclosureCard id="addon-install-evidence" title="Repository, commands and installation evidence">
              <dl>
                <dt>Repository</dt>
                <dd>{selected.addon.repoUrl}</dd>
                <dt>Installed path</dt>
                <dd>{selected.installed?.installedPath ?? "Unavailable"}</dd>
                <dt>Install reference</dt>
                <dd>{selected.installed?.installRef ?? "Unavailable"}</dd>
                <dt>Web entry</dt>
                <dd>{selected.installed?.launchUrl ?? selected.addon.launchUrl ?? "No entry declared"}</dd>
                <dt>Consent</dt>
                <dd>
                  {selected.installed
                    ? `${selected.installed.consentedBy} · ${selected.installed.consentedAt}`
                    : "No saved consent"}
                </dd>
                <dt>Recorded process</dt>
                <dd>{selected.installed?.pid ?? "No process ID returned"}</dd>
              </dl>
              {selected.installed?.lastError ? (
                <p role="status">Recorded error: {selected.installed.lastError}</p>
              ) : null}
              <SettingsActionList
                ariaLabel="Add-on install commands"
                items={selected.addon.installCommands.map((command, index) => ({
                  id: `command-${index}`,
                  label: command.command,
                  description: command.note ?? "Owner-declared install command",
                  meta: command.args?.join(" ") ?? "No arguments",
                }))}
              />
              <SettingsActionList
                ariaLabel="Add-on health checks"
                items={selected.healthChecks.map((check) => ({
                  id: check.key,
                  label: check.key,
                  description: check.message,
                  meta: check.status,
                }))}
                emptyLabel="No health evidence returned."
              />
            </NativeDisclosureCard>
          </>
        ) : null}
      </DetailInspector>
      <ConfirmModal
        open={Boolean(owner.review)}
        title={`Review add-on ${owner.review?.action ?? "action"}`}
        danger
        pending={owner.mutation.pending}
        confirmLabel="Apply reviewed action"
        onCancel={owner.cancelReview}
        onConfirm={() => void owner.confirmReview()}
        message={
          owner.review
            ? `${addonReviewDescription(owner.review.action, owner.review.status)}\nOwner-declared commands:\n${owner.review.status.addon.installCommands.map((command) => [command.command, ...(command.args ?? [])].join(" ")).join("\n")}`
            : ""
        }
      />
    </SettingsStack>
  );
}
