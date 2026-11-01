import {
  HOOK_TRIGGER_LABELS,
  TOOL_GROUPS,
  type CapabilityPluginDetailPiece,
  type CapabilityPluginPieceCheck,
  type CapabilityPluginPieceState,
  type CapabilityPluginState,
  type CapabilitySkillInstallStep,
  type ChangePlanStatus,
  type PluginManifest,
  type PluginPiece,
} from "@goatcitadel/contracts";
import type { StoredPlugin, StoredPluginPiece } from "./capability-plugin-store.js";
import { ASKS_FIRST } from "./capability-plugin-inspection-service.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import {
  distinctPluginPromptPackNames,
  pluginPromptPackId,
  pluginPromptPackSourceLabel,
} from "./plugin-prompt-packs.js";
import type { PluginSkillCheck } from "./plugin-skill-checks.js";
import { preparePromptPackImport } from "./prompt-pack/prepare-import.js";

// One installed plugin's pieces: where each one is, the link to its own item, and its label. The Plugins list and the
// plugin's detail read a plugin's state through the same rule here, so the two never disagree.

/** The install plan's statuses once it is done with the record: it finished, stopped, or was stopped. */
const INSTALL_PLAN_ENDED: ReadonlySet<ChangePlanStatus> = new Set([
  "completed",
  "applied",
  "manual_required",
  "failed",
  "cancelled",
  "rolled_back",
  "rollback_failed",
]);
/** A skill piece's state at each step of its install, read as the Skills tab reads its check. */
const SKILL_STEP_STATES: Readonly<Record<CapabilitySkillInstallStep, CapabilityPluginPieceState>> = {
  check_passed: "check_passed",
  // Refused by GoatCitadel's checks: its install can't go on.
  blocked: "failed",
  waiting_install: "waiting_for_approval",
  installing: "installing",
  installed_off: "installed_off",
  waiting_switch_on: "waiting_for_approval",
  switching_on: "installing",
  done: "added",
  failed: "failed",
};
const UNREAD_DETAILS = "Its details can't be read right now.";
const READY: CapabilityPluginPieceCheck = { status: "ready" };
const ALREADY_THERE: CapabilityPluginPieceCheck = { status: "already_there" };

/** What a plugin's pieces are read from, besides its record. */
export interface PluginPieceReadings {
  /** Its skill pieces' checks, by id. Undefined when they couldn't be read. */
  skillChecks?: ReadonlyMap<string, PluginSkillCheck>;
  /** Whether its install plan is done with it. Undefined when it wasn't read, or couldn't be. */
  installEnded?: boolean;
}

/** Where one piece is. */
export interface PluginPieceReading {
  state: CapabilityPluginPieceState;
  pendingApprovalId?: string;
}

/** A piece's label and what it does, as the inspection showed them. */
export interface PluginPieceLabel {
  label: string;
  asksFirst: string;
  hosts?: string[];
}

/**
 * Where one piece is. A piece already there is kept. While the plugin is uninstalled every piece reads removed, but a
 * skill whose removal still waits for its approval. A skill reads its check's own step; one whose check can't be read
 * is unknown. Any other piece is added once it names what it became; until then it is still installing, failed once
 * the install plan is done with it, and unknown while that can't be told.
 */
export function readPluginPiece(
  plugin: StoredPlugin,
  piece: StoredPluginPiece,
  readings: PluginPieceReadings,
): PluginPieceReading {
  if (!piece.owned) return { state: "kept" };
  if (piece.kind === "skill") return readSkillPiece(plugin, piece, readings.skillChecks);
  if (plugin.state === "uninstalling") return { state: "removed" };
  if (piece.ref !== undefined) return { state: "added" };
  if (readings.installEnded === undefined) return { state: "unknown" };
  return { state: readings.installEnded ? "failed" : "installing" };
}

/**
 * The plugin's state, for the list and the detail alike: `uninstalling` while it is removed, `installed` only when its
 * install finished and every piece is added or kept, and otherwise `install_not_finished`.
 */
export function pluginPublicState(plugin: StoredPlugin, readings: PluginPieceReadings): CapabilityPluginState {
  if (plugin.state === "uninstalling") return "uninstalling";
  if (plugin.state === "installing") return "install_not_finished";
  const finished = plugin.pieces.every((piece) => {
    const { state } = readPluginPiece(plugin, piece, readings);
    return state === "added" || state === "kept";
  });
  return finished ? "installed" : "install_not_finished";
}

/** Whether a piece's state depends on the install plan: one the plugin owns that doesn't name what it became yet. */
export function needsInstallPlan(plugin: StoredPlugin): boolean {
  return (
    plugin.state !== "uninstalling" &&
    plugin.pieces.some((piece) => piece.owned && piece.kind !== "skill" && piece.ref === undefined)
  );
}

/** Whether the install plan, in this status, is done with the record. */
export function installPlanEnded(status: ChangePlanStatus): boolean {
  return INSTALL_PLAN_ENDED.has(status);
}

/** The skill pieces' checks, by id: what a plugin's skills are read by. */
export function skillCheckIds(plugin: StoredPlugin): string[] {
  return plugin.pieces.flatMap((piece) =>
    piece.kind === "skill" && piece.skillSnapshotId !== undefined ? [piece.skillSnapshotId] : [],
  );
}

/**
 * Each piece as the detail shows it: the label and line from the manifest it was installed from (`labels`, absent
 * when that couldn't be read), the check it passed, where it is, and the link to its own item.
 */
export function buildPluginDetailPieces(
  plugin: StoredPlugin,
  manifest: PluginManifest | undefined,
  labels: ReadonlyMap<string, PluginPieceLabel> | undefined,
  readings: PluginPieceReadings,
): CapabilityPluginDetailPiece[] {
  return plugin.pieces.map((piece) => {
    const reading = readPluginPiece(plugin, piece, readings);
    const check = piece.skillSnapshotId ? readings.skillChecks?.get(piece.skillSnapshotId) : undefined;
    const manifestPiece = manifest?.pieces.find((item) => item.id === piece.pieceId && item.kind === piece.kind);
    const described = labels?.get(piece.pieceId) ?? fallbackLabel(piece);
    const href = pieceHref(piece, manifestPiece, reading.state, check);
    return {
      pieceId: piece.pieceId,
      kind: piece.kind,
      label: piece.kind === "skill" && check ? check.title : described.label,
      asksFirst: described.asksFirst,
      check: piece.owned ? READY : ALREADY_THERE,
      ...(described.hosts ? { hosts: [...described.hosts] } : {}),
      ...(piece.skillSnapshotId ? { skillSnapshotId: piece.skillSnapshotId } : {}),
      state: reading.state,
      ...(reading.pendingApprovalId ? { pendingApprovalId: reading.pendingApprovalId } : {}),
      ...(href ? { href } : {}),
    };
  });
}

/**
 * Each piece's label and line, from the manifest, as the inspection writes them: a connector by its template's label,
 * a tool group by its own, a hook by its event and host, a prompt pack by the name it was saved under (read again from
 * the snapshot), and a skill by its piece id until its check names it. A prompt pack file that can't be read keeps its
 * piece id, and the failure goes to `reportUnreadable`.
 */
export async function describePluginPieces(
  manifest: PluginManifest,
  readSnapshotText: (relativePath: string) => Promise<string>,
  reportUnreadable: (error: unknown) => void,
): Promise<Map<string, PluginPieceLabel>> {
  const labels = new Map<string, PluginPieceLabel>();
  const packs: Array<{ pieceId: string; name: string; tests: number }> = [];
  for (const piece of manifest.pieces) {
    if (piece.kind === "prompt_pack") {
      const pack = await readPromptPack(manifest, piece, readSnapshotText, reportUnreadable);
      if (pack) packs.push(pack);
      else labels.set(piece.id, { label: piece.id, asksFirst: ASKS_FIRST.unreadPromptPack });
      continue;
    }
    labels.set(piece.id, describePiece(piece));
  }
  const names = distinctPluginPromptPackNames(packs);
  for (const pack of packs) {
    labels.set(pack.pieceId, {
      label: names.get(pack.pieceId) ?? pack.name,
      asksFirst: ASKS_FIRST.promptPack(pack.tests),
    });
  }
  return labels;
}

function readSkillPiece(
  plugin: StoredPlugin,
  piece: StoredPluginPiece,
  checks: ReadonlyMap<string, PluginSkillCheck> | undefined,
): PluginPieceReading {
  const check = piece.skillSnapshotId ? checks?.get(piece.skillSnapshotId) : undefined;
  if (!check) return { state: "unknown" };
  if (plugin.state === "uninstalling") {
    const revoke = check.pendingApprovals.revoke;
    return revoke ? { state: "waiting_for_approval", pendingApprovalId: revoke } : { state: "removed" };
  }
  if (check.revoked) return { state: "removed" };
  const state = SKILL_STEP_STATES[check.step];
  if (state !== "waiting_for_approval") return { state };
  const pendingApprovalId =
    check.step === "waiting_install" ? check.pendingApprovals.install_inactive : check.pendingApprovals.activate;
  return { state, ...(pendingApprovalId ? { pendingApprovalId } : {}) };
}

/**
 * The link to the piece's own item, written here, never by the cockpit: a skill once its check names it, a saved
 * connector by the item id the Connectors list gives it, a tool group by its id, a prompt pack by its id, and a hook
 * to the hooks settings. A piece that is removed, failed, unknown or not added yet has none.
 */
function pieceHref(
  piece: StoredPluginPiece,
  manifestPiece: PluginPiece | undefined,
  state: CapabilityPluginPieceState,
  check: PluginSkillCheck | undefined,
): string | undefined {
  if (state === "removed" || state === "failed" || state === "unknown") return undefined;
  switch (piece.kind) {
    case "skill":
      return check?.skillId ? `/capabilities/skills?item=skill:${check.skillId}` : undefined;
    case "connector":
      return piece.ref && state === "added"
        ? `/capabilities/connectors?item=${encodeURIComponent(`mcp-server:${piece.ref}`)}`
        : undefined;
    case "tool_group_off": {
      const groupId = piece.ref ?? (manifestPiece?.kind === "tool_group_off" ? manifestPiece.groupId : undefined);
      return groupId && (state === "added" || state === "kept")
        ? `/capabilities/tools?item=group:${groupId}`
        : undefined;
    }
    case "prompt_pack":
      return piece.ref && state === "added" ? `/library/prompt-packs?view=pack:${piece.ref}` : undefined;
    case "hook":
      return piece.ref && state === "added" ? "/settings/safety#hooks" : undefined;
  }
}

/** A piece whose manifest couldn't be read: what its record alone can say. */
function fallbackLabel(piece: StoredPluginPiece): PluginPieceLabel {
  switch (piece.kind) {
    case "skill":
      return { label: piece.pieceId, asksFirst: ASKS_FIRST.skill };
    case "tool_group_off": {
      const group = TOOL_GROUPS.find((item) => item.id === piece.ref);
      return group
        ? { label: group.label, asksFirst: ASKS_FIRST.toolGroupOff(group.label) }
        : { label: piece.pieceId, asksFirst: UNREAD_DETAILS };
    }
    case "prompt_pack":
      return { label: piece.pieceId, asksFirst: ASKS_FIRST.unreadPromptPack };
    case "connector":
    case "hook":
      return { label: piece.pieceId, asksFirst: UNREAD_DETAILS };
  }
}

function describePiece(piece: Exclude<PluginPiece, { kind: "prompt_pack" }>): PluginPieceLabel {
  switch (piece.kind) {
    case "skill":
      return { label: piece.id, asksFirst: ASKS_FIRST.skill };
    case "connector":
      return {
        label: MCP_SERVER_TEMPLATES.find((item) => item.templateId === piece.templateId)?.label ?? piece.templateId,
        asksFirst: piece.asksFirst === "everything" ? ASKS_FIRST.connectorEverything : ASKS_FIRST.connectorChanges,
      };
    case "tool_group_off": {
      const label = TOOL_GROUPS.find((item) => item.id === piece.groupId)?.label ?? piece.groupId;
      return { label, asksFirst: ASKS_FIRST.toolGroupOff(label) };
    }
    case "hook": {
      const triggerLabel = HOOK_TRIGGER_LABELS[piece.trigger] ?? piece.trigger;
      const host = hostOf(piece.url);
      return {
        label: triggerLabel,
        asksFirst: ASKS_FIRST.hook(host ?? "its address", triggerLabel),
        ...(host ? { hosts: [host] } : {}),
      };
    }
  }
}

/** A prompt pack's own name and test count, read from the snapshot as its install read it; none when it can't be. */
async function readPromptPack(
  manifest: PluginManifest,
  piece: Extract<PluginPiece, { kind: "prompt_pack" }>,
  readSnapshotText: (relativePath: string) => Promise<string>,
  reportUnreadable: (error: unknown) => void,
): Promise<{ pieceId: string; name: string; tests: number } | undefined> {
  try {
    const content = await readSnapshotText(piece.path);
    const { write } = preparePromptPackImport({
      content,
      packId: pluginPromptPackId(manifest.pluginId, piece.id),
      sourceLabel: pluginPromptPackSourceLabel(manifest.name),
    });
    return { pieceId: piece.id, name: write.name, tests: write.tests.length };
  } catch (error) {
    // Its label stays the piece id; the pack itself, and whether it was added, are read from the record.
    reportUnreadable(error);
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}
