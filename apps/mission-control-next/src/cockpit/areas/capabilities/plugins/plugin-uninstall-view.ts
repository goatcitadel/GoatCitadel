import type { CapabilityPluginDetail, CapabilityPluginDetailPiece } from "@goatcitadel/contracts";
import { joinLabels } from "../skills/discover-view";
import type { PluginUninstallEntry } from "./plugin-uninstall-store";

// Wording for a plugin's uninstall. What it removes, keeps and asks for is the Gateway's; nothing here decides it.

/** Said in the confirmation when the plugin added a prompt pack: its runs go with it. No run count is known here. */
export const PROMPT_PACK_RUNS_LINE = "Deletes the runs of its prompt packs.";

/**
 * The confirmation's lines, from the detail: what the plugin added goes, what was already there stays, and so do the
 * hosts it allowed. The plan's own approval and outcome then say exactly what the Gateway did.
 */
export function uninstallConfirmLines(pieces: readonly CapabilityPluginDetailPiece[]): string[] {
  const owned = pieces.filter((piece) => piece.check.status !== "already_there" && piece.state !== "removed");
  const kept = pieces.filter((piece) => piece.check.status === "already_there");
  const hosts = pieces.some((piece) => (piece.hosts?.length ?? 0) > 0);
  const stays = [...kept.map((piece) => piece.label), ...(hosts ? ["the hosts it allowed"] : [])];
  const staysLine =
    kept.length > 0 && hosts
      ? `Stays: ${joinLabels(kept.map((piece) => piece.label))}, and the hosts it allowed`
      : `Stays: ${joinLabels(stays)}`;
  return [
    ...(owned.length > 0 ? [`Removes: ${joinLabels(owned.map((piece) => piece.label))}`] : []),
    ...(stays.length > 0 ? [staysLine] : []),
    ...(owned.some((piece) => piece.kind === "prompt_pack") ? [PROMPT_PACK_RUNS_LINE] : []),
  ];
}

/** The fallback title of the uninstall plan's own approval; GoatCitadel's own title ("Uninstall <name>") shows first. */
export const approveUninstallTitle = (name: string) => `Approve uninstalling ${name}?`;

/** The title of a skill's removal approval, which carries no title of its own. */
export const approveRemovingTitle = (skill: string) => `Approve removing ${skill}?`;

/** The approval the uninstall waits on now, with its title: a skill's removal first, then the plan's own. */
export function uninstallApproval(
  entry: PluginUninstallEntry | undefined,
  detail: CapabilityPluginDetail | undefined,
  decided: ReadonlySet<string>,
): { approvalId: string; title: string } | undefined {
  const name = detail?.name ?? "this plugin";
  const piece = detail?.pieces.find((item) => item.pendingApprovalId && !decided.has(item.pendingApprovalId));
  if (detail?.state === "uninstalling" && piece?.pendingApprovalId) {
    return { approvalId: piece.pendingApprovalId, title: approveRemovingTitle(piece.label) };
  }
  if (entry?.phase === "following" && entry.approvalId && !decided.has(entry.approvalId)) {
    const removal = detail?.pieces.find((item) => item.pendingApprovalId === entry.approvalId);
    return {
      approvalId: entry.approvalId,
      title: removal ? approveRemovingTitle(removal.label) : approveUninstallTitle(name),
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
  if (entry.phase === "gone") return `${name} is uninstalled.`;
  if (entry.phase === "stopped") return "";
  if (waitingFor) return "Waiting for your approval.";
  if (detail?.state !== "uninstalling") return `Uninstalling ${name}…`;
  const removing = detail.pieces.find((piece) => piece.state === "removing");
  if (removing) return `Removing ${removing.label}…`;
  return `${name} isn't fully uninstalled yet.`;
}
