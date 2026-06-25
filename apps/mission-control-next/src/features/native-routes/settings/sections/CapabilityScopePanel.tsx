import { useCallback, useRef, useState } from "react";
import { RefreshCw, RotateCcw, Save } from "lucide-react";
import type { CapabilityResourceType, CapabilityScopeKind, CapabilityScopeUpdateInput, CapabilityScopeView } from "@goatcitadel/contracts";
import {
  getErrorMessage,
  type Notice,
  SettingsButtonRow,
  SettingsGrid,
  SettingsNotice,
  SettingsSectionShell,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { ErrorState, NativeButton, NativeSelectableList } from "../../primitives";

export interface CapabilityScopePanelProps {
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  resourceType: CapabilityResourceType;
  title: string;
  fetchScope: (scopeId: string, type: CapabilityResourceType) => Promise<CapabilityScopeView>;
  updateScope: (scopeId: string, input: CapabilityScopeUpdateInput) => Promise<CapabilityScopeView>;
  resetScope: (scopeId: string, type: CapabilityResourceType) => Promise<CapabilityScopeView>;
}

function labelForResourceType(type: CapabilityResourceType): string {
  switch (type) {
    case "skill":
      return "Skills";
    case "integration":
      return "Plugins";
    case "mcp_server":
      return "MCP servers";
    default:
      return type;
  }
}

export function CapabilityScopePanel({
  scopeKind,
  scopeId,
  resourceType,
  title,
  fetchScope,
  updateScope,
  resetScope,
}: CapabilityScopePanelProps) {
  const load = useCallback(
    () => fetchScope(scopeId, resourceType),
    [fetchScope, scopeId, resourceType],
  );
  const { loading, error, data: view, reload } = useAsyncLoad(load, [load]);

  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const savingRef = useRef(false);
  const resettingRef = useRef(false);

  // Local toggle state: resourceRef -> enabled override (null = use view value)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // Reset local overrides whenever the view reloads
  const hasOverrides = Object.keys(overrides).length > 0;

  const handleToggle = (resourceRef: string) => {
    if (!view) {
      return;
    }
    const current = overrides[resourceRef] ?? view.items.find((i) => i.resourceRef === resourceRef)?.enabled ?? false;
    setOverrides((prev) => ({ ...prev, [resourceRef]: !current }));
  };

  const buildAssignments = () => {
    if (!view) {
      return [];
    }
    return view.items.map((item) => ({
      resourceRef: item.resourceRef,
      enabled: overrides[item.resourceRef] ?? item.enabled,
    }));
  };

  const handleSave = async () => {
    if (savingRef.current || !view) {
      return;
    }
    try {
      savingRef.current = true;
      setSaving(true);
      await updateScope(scopeId, { resourceType, assignments: buildAssignments() });
      setOverrides({});
      setNotice({ tone: "success", message: `${title} scope saved.` });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (resettingRef.current) {
      return;
    }
    try {
      resettingRef.current = true;
      setResetting(true);
      await resetScope(scopeId, resourceType);
      setOverrides({});
      setNotice({ tone: "success", message: `${title} scope reset to inherited.` });
      await reload();
    } catch (resetError) {
      setNotice({ tone: "error", message: getErrorMessage(resetError) });
    } finally {
      resettingRef.current = false;
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <SettingsSectionShell loading={loading} error={null}>
        {null}
      </SettingsSectionShell>
    );
  }

  const modeLabel =
    view?.mode === "inherit"
      ? "Inherited (all from parent)"
      : "Curated";

  const resourceLabel = labelForResourceType(resourceType);

  const listItems =
    view?.items.map((item) => {
      const effectiveEnabled = overrides[item.resourceRef] ?? item.enabled;
      const unavailableNote = !item.available ? " (unavailable)" : "";
      return {
        id: item.resourceRef,
        title: `${item.label}${unavailableNote}`,
        meta: effectiveEnabled ? "enabled" : "disabled",
      };
    }) ?? [];

  return (
    <>
      {error ? <ErrorState size="inline" description={error} /> : null}
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsGrid>
        <NativeCard
          density="compact"
          className="mc-next-settings-panel"
          title={`${title} — ${resourceLabel}`}
          subtitle={`Control which ${resourceLabel.toLowerCase()} this ${scopeKind} uses. ${modeLabel}.`}
          stats={[
            { label: "Mode", value: modeLabel },
            { label: "Items", value: String(view?.items.length ?? 0) },
          ]}
        >
          {view ? (
            <>
              <div className="mc-next-settings-chip-row" aria-label="Scope mode">
                <span className="mc-next-settings-chip">
                  {view.mode === "inherit" ? "Inherited" : "Curated"}
                </span>
              </div>
              <NativeSelectableList
                ariaLabel={`${resourceLabel} for ${scopeKind}`}
                emptyLabel={`No ${resourceLabel.toLowerCase()} available.`}
              >
                {listItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="mc-next-settings-selectable"
                    onClick={() => handleToggle(item.id)}
                  >
                    <div className="mc-next-settings-selectable-head">
                      <strong>{item.title}</strong>
                      <span>{item.meta}</span>
                    </div>
                  </button>
                ))}
              </NativeSelectableList>
            </>
          ) : null}
          <SettingsButtonRow>
            <NativeButton
              variant="default"
              disabled={saving || resetting || !hasOverrides}
              onClick={() => void handleSave()}
            >
              <Save size={16} />
              {saving ? "Saving..." : "Save"}
            </NativeButton>
            <NativeButton
              variant="secondary"
              disabled={saving || resetting}
              onClick={() => void handleReset()}
            >
              <RotateCcw size={16} />
              {resetting ? "Resetting..." : "Reset to inherited"}
            </NativeButton>
            <NativeButton
              variant="secondary"
              disabled={saving || resetting}
              onClick={() => void reload()}
            >
              <RefreshCw size={16} />
              Refresh
            </NativeButton>
          </SettingsButtonRow>
        </NativeCard>
      </SettingsGrid>
    </>
  );
}
