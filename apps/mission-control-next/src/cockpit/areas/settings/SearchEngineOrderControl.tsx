import { CONNECTOR_SETUP_PATH } from "../../app/routes";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";
import {
  GovernedSettingChangeStatus,
  GovernedSettingDraftState,
  GovernedSettingLoadState,
} from "./GovernedSettingParts";
import {
  decodeEngineOrder,
  describeEngineOrder,
  encodeEngineOrder,
  ENGINE_LABELS,
  engineRows,
  matchesEngineOrderPlan,
  moveEngine,
  readEngineOrder,
  toggleEngine,
  WEB_SEARCH_ANCHOR,
} from "./web-search-state";

/** Default native engine and backup order for `browser.search` and the Chat search fallback. */
export function SearchEngineOrderControl({ settings }: { settings: UseQueryResult<RuntimeSettingsResponse> }) {
  const governed = useGovernedRuntimeSetting<string>({
    settings,
    draftKey: "web:system:search-engine-order",
    draftLabel: "Search engine order",
    recovery: { path: CONNECTOR_SETUP_PATH, anchor: WEB_SEARCH_ANCHOR },
    read: readEngineOrder,
    fallback: "duckduckgo,bing,google",
    patch: (value) => ({ web: { search: { engineOrder: decodeEngineOrder(value) } } }),
    operation: "web_search_configuration",
    matchesPlan: matchesEngineOrderPlan,
    copy: {
      staleDraft:
        "Settings changed. Your draft started from an older version. Review the current order, then apply your draft again.",
      changedElsewhere: "Settings changed elsewhere. Your draft is preserved for review.",
      saved: "Search engine order saved.",
    },
  });
  const { ready, draft } = governed;
  const order = decodeEngineOrder(draft.value);
  const setOrder = (next: ReturnType<typeof decodeEngineOrder>) => {
    governed.clearNotice();
    draft.setValue(encodeEngineOrder(next));
  };

  return (
    <div className="mt-4 border-t border-line-subtle pt-4">
      <h4 id="search-engine-order-title" className="text-sm font-semibold text-fg">
        Search engines
      </h4>
      <p className="mt-1 text-sm text-fg-secondary">
        Built-in browser search, used when Firecrawl is off, unreachable, or set to native. The first engine is the
        default; the rest are tried in order when it fails. Engines you turn off are never used.
      </p>
      <GovernedSettingLoadState
        governed={governed}
        loading="Loading search engines…"
        incomplete="GoatCitadel did not report a search engine order. Update GoatCitadel before changing it."
      />
      {ready ? (
        <>
          <ol aria-labelledby="search-engine-order-title" className="mt-3 max-w-md divide-y divide-line-subtle">
            {engineRows(order).map((row) => (
              <li key={row.engine} className="flex min-h-11 items-center gap-2 py-1">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    disabled={governed.locked || (row.enabled && order.length === 1)}
                    onChange={() => setOrder(toggleEngine(order, row.engine))}
                  />
                  <span className="truncate">{ENGINE_LABELS[row.engine]}</span>
                </label>
                {row.position === 0 ? <span className="text-xs font-medium text-accent">Default</span> : null}
                {row.position > 0 ? <span className="text-xs text-fg-muted">Backup {row.position}</span> : null}
                {row.enabled ? (
                  <span className="flex gap-1">
                    <IconButton
                      label={`Move ${ENGINE_LABELS[row.engine]} up`}
                      icon={<ArrowUp aria-hidden="true" className="size-4" />}
                      disabled={governed.locked || row.position === 0}
                      onClick={() => setOrder(moveEngine(order, row.engine, -1))}
                    />
                    <IconButton
                      label={`Move ${ENGINE_LABELS[row.engine]} down`}
                      icon={<ArrowDown aria-hidden="true" className="size-4" />}
                      disabled={governed.locked || row.position === order.length - 1}
                      onClick={() => setOrder(moveEngine(order, row.engine, 1))}
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          <GovernedSettingDraftState
            governed={governed}
            unsaved={`Unsaved draft: ${describeEngineOrder(order)}`}
            currentLabel={describeEngineOrder(decodeEngineOrder(governed.current))}
          />
          <Button variant="primary" className="mt-3" disabled={!governed.canSave} onClick={() => void governed.save()}>
            {governed.busy ? "Saving…" : "Save search engines"}
          </Button>
        </>
      ) : null}
      <GovernedSettingChangeStatus
        governed={governed}
        owner="search-engine-order"
        recoveryLabel="Inspect search engine setting activity"
      />
    </div>
  );
}
