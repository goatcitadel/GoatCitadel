import type {
  CapabilityPluginDetail,
  CapabilityPluginDetailPiece,
  CapabilityPluginPieceState,
} from "@goatcitadel/contracts";
import { joinLabels } from "../skills/discover-view";
import { stepApprovalWords } from "./plugin-install-view";
import type { PluginUninstallEntry } from "./plugin-uninstall-store";

// Wording for a plugin's uninstall. What it removes, keeps and asks for is the Gateway's; nothing here decides it.

/** Said in the confirmation when the plugin added a prompt pack: its runs go with it. No run count is known here. */
export const PROMPT_PACK_RUNS_LINE = "Deletes the runs of its prompt packs.";

/**
 * The states that show the plugin added something for the piece: only those are listed as removed. A piece whose add
 * failed, can't be read, or never started has nothing of the plugin's to remove.
 */
const ADDED_STATES: ReadonlySet<CapabilityPluginPieceState> = new Set([
  "added",
  "installed_off",
  "installing",
  "waiting_for_approval",
  "removing",
]);

/** The confirmation's opening when the plugin added a skill: skills can't be removed yet, so it can't be installed again. */
export const UNINSTALL_SKILL_STAYS =
  "This can't be undone here. It added a skill, and skills can't be removed yet, so you won't be able to install this plugin again.";

/** The confirmation's opening when nothing the plugin added is a skill. */
export const UNINSTALL_REINSTALLABLE = "This can't be undone here. Installing it again adds its pieces back.";

/** Said above "Finish uninstalling" while a skill the plugin added still has to be switched off. */
export const FINISH_UNINSTALL_LINE =
  "Almost done. A skill this plugin added still has to be switched off, and that takes its own approval. Finish uninstalling asks for it, then removes what is left, picking up where it stopped.";

/** The confirmation's description: it says up front whether the plugin can be installed again. */
export function uninstallConfirmDescription(pieces: readonly CapabilityPluginDetailPiece[]): string {
  const addedSkill = pieces.some(
    (piece) => piece.kind === "skill" && piece.check.status !== "already_there" && ADDED_STATES.has(piece.state),
  );
  return addedSkill ? UNINSTALL_SKILL_STAYS : UNINSTALL_REINSTALLABLE;
}

/**
 * The confirmation's lines, from the detail: what the plugin added goes, what was already there stays, and so do the
 * hosts it allowed, each named once. The plan's own approval and outcome then say exactly what the Gateway did.
 */
export function uninstallConfirmLines(pieces: readonly CapabilityPluginDetailPiece[]): string[] {
  const owned = pieces.filter((piece) => piece.check.status !== "already_there" && ADDED_STATES.has(piece.state));
  const kept = pieces.filter((piece) => piece.check.status === "already_there");
  const hosts = [...new Set(pieces.flatMap((piece) => piece.hosts ?? []))];
  const hostsPart = hosts.length > 0 ? `the hosts it allowed (${joinLabels(hosts)})` : undefined;
  const keptPart = kept.length > 0 ? joinLabels(kept.map((piece) => piece.label)) : undefined;
  const staysLine =
    keptPart && hostsPart ? `Stays: ${keptPart}, and ${hostsPart}` : `Stays: ${keptPart ?? hostsPart ?? ""}`;
  return [
    ...(owned.length > 0 ? [`Removes: ${joinLabels(owned.map((piece) => piece.label))}`] : []),
    ...(keptPart || hostsPart ? [staysLine] : []),
    ...(owned.some((piece) => piece.kind === "prompt_pack") ? [PROMPT_PACK_RUNS_LINE] : []),
  ];
}

/** The fallback title of the uninstall plan's own approval; GoatCitadel's own title ("Uninstall <name>") shows first. */
export const approveUninstallTitle = (name: string) => `Approve uninstalling ${name}?`;

/** The title of a skill's removal approval, which carries no title of its own. */
export const approveRemovingTitle = (skill: string) => `Approve removing ${skill}?`;

/**
 * The title of a skill step's approval, by the step the Gateway names: only a revoke reads as a removal. An install or
 * switch-on step left waiting from the plugin's install keeps its own words, and a step not named reads neutrally.
 */
export function pieceStepTitle(piece: CapabilityPluginDetailPiece): string {
  if (piece.pendingStep === "revoke") return approveRemovingTitle(piece.label);
  const step =
    piece.pendingStep === "install_inactive" || piece.pendingStep === "activate" ? piece.pendingStep : undefined;
  return stepApprovalWords(step, piece.label).title;
}

/** The approval the uninstall waits on now, with its title: a skill's step first, then the plan's own. */
export function uninstallApproval(
  entry: PluginUninstallEntry | undefined,
  detail: CapabilityPluginDetail | undefined,
  decided: ReadonlySet<string>,
): { approvalId: string; title: string } | undefined {
  const name = detail?.name ?? "this plugin";
  const piece = detail?.pieces.find((item) => item.pendingApprovalId && !decided.has(item.pendingApprovalId));
  if (detail?.state === "uninstalling" && piece?.pendingApprovalId) {
    return { approvalId: piece.pendingApprovalId, title: pieceStepTitle(piece) };
  }
  if (entry?.phase === "following" && entry.approvalId && !decided.has(entry.approvalId)) {
    const step = detail?.pieces.find((item) => item.pendingApprovalId === entry.approvalId);
    return {
      approvalId: entry.approvalId,
      title: step ? pieceStepTitle(step) : approveUninstallTitle(name),
    };
  }
  return undefined;
}

/** The one line read out as the uninstall moves, or empty when none is under way. */
export function uninstallProgressLine(
  entry: PluginUninstallEntry | undefined,
  detail: CapabilityPluginDetail | undefined,
  waitingFor: { title: string } | undefined,
): string {
  const name = detail?.name ?? "This plugin";
  if (!entry) return "";
  if (entry.phase === "asking") return "Asking…";
  if (entry.phase === "stopped") return "";
  if (waitingFor) return "Waiting for your approval.";
  if (detail?.state !== "uninstalling") return `Uninstalling ${name}…`;
  const removing = detail.pieces.find((piece) => piece.state === "removing");
  if (removing) return `Removing ${removing.label}…`;
  return `${name} isn't fully uninstalled yet.`;
}
