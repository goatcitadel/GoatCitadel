import { checkPublicWebAddress } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import {
  GovernedSettingChangeStatus,
  GovernedSettingDraftState,
  GovernedSettingLoadState,
} from "./GovernedSettingParts";
import {
  matchesPublicWebAddressPlan,
  normalizePublicWebAddress,
  readPublicWebAddress,
  usePublicWebAddressQuery,
} from "./public-web-address-state";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";

export { usePublicWebAddress, usePublicWebAddressSettings } from "./public-web-address-state";

const HELP =
  "The https:// address where Meta and other services can reach this GoatCitadel. Use your own domain, reverse proxy or tunnel; GoatCitadel doesn't provide one.";

/**
 * The one control for GoatCitadel's public web address, shared by Settings › Channels and the channel setup pages. A save
 * is a Settings change, approved in place like Firecrawl's address, and the address is tidied by GoatCitadel (lower-case
 * host, no trailing slash), so the field shows the saved form once the change is confirmed.
 *
 * `settings` is the caller's read of `usePublicWebAddressSettings()`. While it is not there yet the field is a single
 * loading line, so a page can render it before its own settings have arrived. The field keeps its own subscription to
 * that same read for saving, which is the same cache entry and the same request, never a second copy of the settings.
 * `onSaved` runs with the saved address each time a save of an address is confirmed, and not when an address is cleared.
 */
export function PublicWebAddressField({
  settings,
  onSaved,
}: {
  settings: RuntimeSettingsResponse | undefined;
  onSaved?: (address: string) => void;
}) {
  const query = usePublicWebAddressQuery();
  const governed = useGovernedRuntimeSetting<string>({
    settings: query,
    draftKey: "channels:system:public-web-address",
    draftLabel: "Public web address",
    recovery: { path: "/chat/messaging/advanced", anchor: "public-web-address" },
    read: readPublicWebAddress,
    fallback: "",
    patch: (value) => ({ publicWebAddress: value.trim() || null }),
    normalize: normalizePublicWebAddress,
    onSaved: (address) => {
      if (address) onSaved?.(address);
    },
    operation: "public_web_address_configuration",
    matchesPlan: matchesPublicWebAddressPlan,
    copy: {
      staleDraft:
        "Settings changed. Your draft started from an older version. Review the current address, then apply your draft again.",
      changedElsewhere: "Settings changed elsewhere. Your draft is preserved for review.",
      saved: "Public web address saved.",
    },
  });
  const { ready, draft } = governed;

  if (!settings && !query.isError) return <p className="text-sm text-fg-muted">Loading the public web address…</p>;

  const typed = draft.value.trim();
  const checked = typed ? checkPublicWebAddress(typed) : undefined;
  const problem = checked && !checked.ok ? checked.problem : undefined;

  function clear() {
    governed.clearNotice();
    draft.setValue("");
    void governed.save("");
  }

  return (
    <div className="max-w-xl space-y-3">
      <GovernedSettingLoadState
        governed={governed}
        loading="Loading the public web address…"
        incomplete="GoatCitadel did not report a public web address setting. Update GoatCitadel before changing it."
      />
      {ready ? (
        <>
          <Field label="Public web address" help={HELP} error={problem}>
            {(props) => (
              <input
                {...props}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://goat.example.com"
                className={cockpitInputClass}
                value={draft.value}
                disabled={governed.locked}
                onChange={(event) => {
                  governed.clearNotice();
                  draft.setValue(event.target.value);
                }}
              />
            )}
          </Field>
          <GovernedSettingDraftState
            governed={governed}
            unsaved={`Unsaved draft: ${typed ? "this address is not in use yet" : "the address will be removed"}`}
            currentLabel={governed.current || "none"}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!governed.canSave || Boolean(problem)}
              onClick={() => void governed.save()}
            >
              {governed.busy ? "Saving…" : "Save address"}
            </Button>
            <Button disabled={governed.locked || (!governed.current && !draft.value)} onClick={clear}>
              Clear
            </Button>
          </div>
        </>
      ) : null}
      <GovernedSettingChangeStatus
        governed={governed}
        owner="public-web-address"
        recoveryLabel="Inspect public web address activity"
      />
    </div>
  );
}
