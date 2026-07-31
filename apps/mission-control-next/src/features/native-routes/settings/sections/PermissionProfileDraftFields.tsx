import type { Dispatch, SetStateAction } from "react";
import type { FilesystemReadAccessMode, PermissionSurface } from "@goatcitadel/contracts";
import { SettingsField, SettingsFieldGrid } from "../SettingsShared";
import {
  describeToolApprovalMode,
  normalizeToolApprovalMode,
  type PermissionProfileEditorDraft,
  togglePermissionProfileSurface,
  TOOL_APPROVAL_MODE_OPTIONS,
} from "../../SettingsNativePage";

export const PERMISSION_CONTEXT_PRESENTATION = {
  chat: {
    label: "Chat",
    description: "Conversation, agentic work, and Code Mode launched from the one Chat workspace.",
  },
  tools: {
    label: "Direct tools",
    description: "Gateway-governed tool calls made outside a Chat turn.",
  },
  mcp: {
    label: "MCP",
    description: "Gateway-governed MCP calls and server actions.",
  },
  cowork: {
    label: "Legacy Cowork compatibility",
    description:
      "Retained policy key for stored activations and older API clients; not a current Mission Control surface.",
  },
  code: {
    label: "Legacy Code compatibility",
    description:
      "Retained policy key for stored activations and older API clients; not a current Mission Control surface.",
  },
  all: {
    label: "All policy contexts",
    description: "Chat, direct tools, MCP, and both legacy compatibility keys.",
  },
} as const satisfies Record<PermissionSurface, { label: string; description: string }>;

export const PRIMARY_PERMISSION_CONTEXTS = ["chat", "tools", "mcp"] as const satisfies readonly PermissionSurface[];
export const LEGACY_PERMISSION_CONTEXTS = ["cowork", "code"] as const satisfies readonly PermissionSurface[];
export const EFFECTIVE_PERMISSION_CONTEXTS = [
  ...PRIMARY_PERMISSION_CONTEXTS,
  ...LEGACY_PERMISSION_CONTEXTS,
] as const satisfies readonly PermissionSurface[];

const PRIMARY_PERMISSION_PROFILE_DEFAULT_CONTEXTS = [
  ...PRIMARY_PERMISSION_CONTEXTS,
  "all",
] as const satisfies readonly PermissionSurface[];
const READ_ACCESS_MODE_OPTIONS = ["", "roots_only", "approval_required", "full_disk"] as const satisfies readonly (
  | FilesystemReadAccessMode
  | ""
)[];

export function PermissionProfileDraftFields({
  draft,
  bypassUnavailableReason,
  accessibleNamePrefix,
  setDraft,
}: {
  draft: PermissionProfileEditorDraft;
  bypassUnavailableReason?: string;
  accessibleNamePrefix?: string;
  setDraft: Dispatch<SetStateAction<PermissionProfileEditorDraft>>;
}) {
  const bypassUnavailable = Boolean(bypassUnavailableReason);
  const accessibleName = (label: string) =>
    accessibleNamePrefix ? `${accessibleNamePrefix} ${label.toLocaleLowerCase()}` : undefined;
  return (
    <SettingsFieldGrid>
      <SettingsField label="Name">
        <input
          aria-label={accessibleName("Name")}
          className="mc-next-settings-input"
          value={draft.label}
          onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          placeholder="Review mode, research mode, release captain"
        />
      </SettingsField>
      <SettingsField label="Approval behavior">
        <select
          aria-label={accessibleName("Approval behavior")}
          className="mc-next-settings-input"
          value={draft.approvalMode}
          onChange={(event) => {
            const nextMode = normalizeToolApprovalMode(event.target.value);
            if (bypassUnavailable && nextMode === "bypass") {
              return;
            }
            setDraft((current) => ({
              ...current,
              approvalMode: nextMode,
            }));
          }}
        >
          {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
            <option key={mode} value={mode} disabled={bypassUnavailable && mode === "bypass"}>
              {bypassUnavailable && mode === "bypass"
                ? `${describeToolApprovalMode(mode)} (unavailable)`
                : describeToolApprovalMode(mode)}
            </option>
          ))}
        </select>
        {bypassUnavailableReason ? <p className="mc-next-settings-field-note">{bypassUnavailableReason}</p> : null}
      </SettingsField>
      <SettingsField label="Description" span={2}>
        <textarea
          aria-label={accessibleName("Description")}
          className="mc-next-settings-input"
          value={draft.description}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
          rows={3}
          placeholder="Why this profile exists and when to use it"
        />
      </SettingsField>
      <SettingsField label="Read access">
        <select
          aria-label={accessibleName("Read access")}
          className="mc-next-settings-input"
          value={draft.readAccessMode}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              readAccessMode: event.target.value as FilesystemReadAccessMode | "",
            }))
          }
        >
          {READ_ACCESS_MODE_OPTIONS.map((mode) => (
            <option key={mode || "default"} value={mode}>
              {describeReadAccessMode(mode)}
            </option>
          ))}
        </select>
      </SettingsField>
      <SettingsField label="Default policy contexts" group>
        <p className="mc-next-settings-field-note">
          Chat includes conversation, agentic work, and Code Mode launched from the one Chat workspace.
        </p>
        {PRIMARY_PERMISSION_PROFILE_DEFAULT_CONTEXTS.map((surface) => (
          <PermissionContextToggle key={surface} draft={draft} setDraft={setDraft} surface={surface} />
        ))}
        <details className="mc-next-disclosure">
          <summary>Legacy compatibility contexts</summary>
          <p className="mc-next-settings-field-note">
            Retained policy keys for stored activations and older API clients. They are not separate Mission Control
            surfaces and do not govern current Chat.
          </p>
          {LEGACY_PERMISSION_CONTEXTS.map((surface) => (
            <PermissionContextToggle key={surface} draft={draft} setDraft={setDraft} surface={surface} />
          ))}
        </details>
        {hasLegacyOnlyPermissionContexts(draft.defaultForSurfaces) ? (
          <p className="mc-next-settings-field-note" role="status">
            Compatibility warning: this legacy-only selection does not govern current Chat. Add Chat or All policy
            contexts if intended; GoatCitadel will not broaden it automatically.
          </p>
        ) : null}
      </SettingsField>
      <SettingsField label="Tool patterns" span={2}>
        <textarea
          aria-label={accessibleName("Tool patterns")}
          className="mc-next-settings-input"
          value={draft.toolPatterns}
          onChange={(event) => setDraft((current) => ({ ...current, toolPatterns: event.target.value }))}
          rows={5}
          placeholder={"session.status\nmemory.read"}
        />
      </SettingsField>
      <SettingsField label="Allow patterns">
        <textarea
          aria-label={accessibleName("Allow patterns")}
          className="mc-next-settings-input"
          value={draft.allow}
          onChange={(event) => setDraft((current) => ({ ...current, allow: event.target.value }))}
          rows={4}
          placeholder="Optional allow patterns"
        />
      </SettingsField>
      <SettingsField label="Deny patterns">
        <textarea
          aria-label={accessibleName("Deny patterns")}
          className="mc-next-settings-input"
          value={draft.deny}
          onChange={(event) => setDraft((current) => ({ ...current, deny: event.target.value }))}
          rows={4}
          placeholder="Optional deny patterns"
        />
      </SettingsField>
    </SettingsFieldGrid>
  );
}

function PermissionContextToggle({
  draft,
  setDraft,
  surface,
}: {
  draft: PermissionProfileEditorDraft;
  setDraft: Dispatch<SetStateAction<PermissionProfileEditorDraft>>;
  surface: PermissionSurface;
}) {
  return (
    <label className="mc-next-settings-toggle">
      <input
        type="checkbox"
        checked={draft.defaultForSurfaces.includes(surface)}
        onChange={(event) =>
          setDraft((current) => ({
            ...current,
            defaultForSurfaces: togglePermissionProfileSurface(
              current.defaultForSurfaces,
              surface,
              event.target.checked,
            ),
          }))
        }
      />
      <span>{formatPermissionContextLabel(surface)}</span>
    </label>
  );
}

export function formatPermissionContextLabel(surface: PermissionSurface): string {
  return PERMISSION_CONTEXT_PRESENTATION[surface].label;
}

export function formatPermissionContextList(surfaces: readonly PermissionSurface[]): string {
  return surfaces.map(formatPermissionContextLabel).join(", ");
}

export function isPrimaryPermissionContext(
  surface: PermissionSurface,
): surface is (typeof PRIMARY_PERMISSION_CONTEXTS)[number] {
  return PRIMARY_PERMISSION_CONTEXTS.some((item) => item === surface);
}

export function isLegacyPermissionContext(
  surface: PermissionSurface,
): surface is (typeof LEGACY_PERMISSION_CONTEXTS)[number] {
  return LEGACY_PERMISSION_CONTEXTS.some((item) => item === surface);
}

export function hasLegacyOnlyPermissionContexts(surfaces: readonly PermissionSurface[] | undefined): boolean {
  if (!surfaces?.length || surfaces.includes("all")) {
    return false;
  }
  return surfaces.some(isLegacyPermissionContext) && !surfaces.some(isPrimaryPermissionContext);
}

export function describeReadAccessMode(mode: FilesystemReadAccessMode | "") {
  switch (mode) {
    case "roots_only":
      return "Workspace roots only";
    case "approval_required":
      return "Ask before broader reads";
    case "full_disk":
      return "Full local disk reads";
    default:
      return "Global default";
  }
}
