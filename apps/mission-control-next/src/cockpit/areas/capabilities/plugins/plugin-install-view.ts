import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  CapabilityPluginDetail,
  CapabilityPluginDetailPiece,
  CapabilityPluginInspection,
  CapabilityPluginPieceCheck,
  CapabilityPluginPieceState,
  CapabilityPluginPieceView,
  PluginPieceKind,
} from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { approvalWords } from "../skills/skill-install-view";
import type { PluginInstallEntry, PluginInstallState, PluginSkillStepKind } from "./plugin-install-store";

// Wording for the install panel. Every check, piece state and step comes from the Gateway; nothing here decides whether
// a plugin can be installed or what comes next, it only says what the Gateway's answer means.

/** Each kind of piece as its row names it. */
export const PLUGIN_PIECE_KIND_LABELS: Readonly<Record<PluginPieceKind, string>> = {
  skill: "Skill",
  connector: "Connector",
  tool_group_off: "Tool rule",
  hook: "Hook",
  prompt_pack: "Prompt pack",
};

export const UNVERIFIED_WARNING =
  "GoatCitadel hasn't reviewed this plugin. Its pieces still go through GoatCitadel's checks.";
export const SKIP_ON_NEXT =
  "Installs everything at once, because your setting to skip approvals for your own changes is on.";
export const SIGN_IN_NEXT = "Connectors that need a sign-in ask you to sign in afterwards.";
export const SIGNING_SECRET_HINT = "The secret your receiver checks. GoatCitadel keeps it and never shows it again.";
export const SIGNING_SECRET_RULE = "Use 1 to 512 characters, with no space at either end.";
/** Said once the plugin is installed, when it added something a chat picks up when it starts. */
export const NEW_CHATS_NOTE = "Takes effect in new chats.";

/** The most characters a signing secret may have, as GoatCitadel holds it. */
const SECRET_MAX = 512;

/** Why a signing secret won't be accepted, or undefined when it will: 1 to 512 characters, no space at either end. */
export function signingSecretProblem(value: string): string | undefined {
  if (value.length === 0 || value.length > SECRET_MAX || value.trim() !== value) return SIGNING_SECRET_RULE;
  return undefined;
}

/** "Asks you 3 times: …" with the skip off: once for the plugin and twice for each skill. */
export function skipOffNext(skills: number): string {
  if (skills === 0) return "Asks you once, for the plugin.";
  const asks = plural(1 + 2 * skills, "time");
  return `Asks you ${asks}: once for the plugin and twice for ${skills === 1 ? "its skill" : "each skill"}.`;
}

/** A piece's check, in plain words. A blocked check's message is the Gateway's own plain sentence. */
export function checkLine(check: CapabilityPluginPieceCheck, kind: PluginPieceKind): string {
  if (check.status === "ready") return "Passed GoatCitadel's checks";
  if (check.status === "blocked") return check.message;
  // A group already off is the operator's own switch, never "installed"; its line above already says it is off.
  return kind === "tool_group_off" ? "Stays off when you uninstall." : "Already installed. Stays when you uninstall.";
}

/** Where a plugin comes from: shipped, a Git repository at a pinned commit, or a folder on this computer. */
export function sourceLine(view: Pick<CapabilityPluginInspection, "sourceKind" | "sourceDisplay" | "pin">): string {
  switch (view.sourceKind) {
    case "built_in":
      return "Ships with GoatCitadel";
    case "folder":
      return "Folder on this computer";
    case "git":
      return view.pin.kind === "commit"
        ? `Git repository ${view.sourceDisplay}, pinned to commit ${view.pin.commit.slice(0, 7)}`
        : `Git repository ${view.sourceDisplay}`;
  }
}

const PIECE_STATES: Readonly<Record<CapabilityPluginPieceState, StatusPresentation>> = {
  added: { label: "Added", tone: "done" },
  kept: { label: "Already there", tone: "neutral" },
  check_passed: { label: "Not installed yet", tone: "neutral" },
  installing: { label: "Installing…", tone: "running" },
  installed_off: { label: "Not switched on yet", tone: "neutral" },
  waiting_for_approval: { label: "Waiting for your approval", tone: "waiting" },
  removed: { label: "Removed", tone: "neutral" },
  removing: { label: "Removing…", tone: "running" },
  failed: { label: "Didn't finish", tone: "failed" },
  // A state that can't be read is never shown as added.
  unknown: { label: "State unknown", tone: "neutral" },
};

export function presentPieceState(state: CapabilityPluginPieceState): StatusPresentation {
  return PIECE_STATES[state];
}

/** The piece that isn't done yet and comes first, in the manifest's order, or undefined when every one is. */
export function firstUnfinishedPiece<T extends CapabilityPluginPieceView & { state: CapabilityPluginPieceState }>(
  pieces: readonly T[],
): T | undefined {
  return pieces.find((piece) => piece.state !== "added" && piece.state !== "kept");
}

/** Whether an install changed what a new chat picks up: a skill, a connector or a tool rule it added. */
export function changesNewChats(pieces: readonly { kind: PluginPieceKind; state?: CapabilityPluginPieceState }[]) {
  return pieces.some(
    (piece) =>
      piece.state === "added" &&
      (piece.kind === "skill" || piece.kind === "connector" || piece.kind === "tool_group_off"),
  );
}

/**
 * The approval dialog's words for a skill's step, as the Skills tab titles them. A step not known yet (read after a
 * reload, before the skill's own install answers) is named by the skill alone.
 */
export function stepApprovalWords(kind: "install_inactive" | "activate" | undefined, skill: string) {
  if (kind === undefined) return { title: `Approve this step for ${skill}?`, summary: undefined };
  return approvalWords(kind === "install_inactive" ? "waiting_install" : "waiting_switch_on", skill);
}

/** The skill step a piece's waiting approval asks for, as the detail names it; undefined when it doesn't. */
export function pendingSkillStep(piece: CapabilityPluginDetailPiece | undefined): PluginSkillStepKind | undefined {
  const step = piece?.pendingStep;
  return step === "install_inactive" || step === "activate" ? step : undefined;
}

/** What the panel knows about its flow, for its one progress line. */
export interface PluginProgressView {
  state: PluginInstallState;
  asking: boolean;
  chain: boolean;
  waitingStep?: PluginSkillStepKind;
  asked?: { pieceId: string; kind: PluginSkillStepKind };
}

/** Where a skill stands on its way in, in one line. */
function skillLine(flow: PluginProgressView, piece: CapabilityPluginPieceView & { state: CapabilityPluginPieceState }) {
  const skill = piece.label;
  switch (piece.state) {
    case "waiting_for_approval":
      if (flow.waitingStep === "install_inactive") return `Waiting for your approval to install ${skill}.`;
      if (flow.waitingStep === "activate") return `Waiting for your approval to switch on ${skill}.`;
      return `Waiting for your approval for ${skill}.`;
    case "installing":
      return flow.asked?.pieceId === piece.pieceId && flow.asked.kind === "activate"
        ? `Switching on ${skill}…`
        : `Installing ${skill}…`;
    case "check_passed":
      return flow.chain ? "Asking…" : `${skill} isn't installed yet.`;
    case "installed_off":
      return flow.chain ? "Asking…" : `${skill} is installed, not switched on.`;
    default:
      return "";
  }
}

/** The one line the panel reads out as the install moves, or empty when nothing is under way. */
export function progressLine(flow: PluginProgressView, name: string): string {
  const { state } = flow;
  if (state.phase === "checking") return "Checking it…";
  if (state.phase === "done") return `${name} is installed.`;
  if (flow.asking) return "Asking…";
  if (state.phase === "planned") {
    return state.approvalId ? `Waiting for your approval to install ${name}.` : `Installing ${name}…`;
  }
  if (state.phase !== "following") return "";
  const piece = firstUnfinishedPiece(state.detail.pieces);
  if (!piece || piece.kind !== "skill") return piece?.state === "installing" || !piece ? `Installing ${name}…` : "";
  return skillLine(flow, piece);
}

/**
 * What a step changes, which no event refreshes (skill steps send none): the plugins, their detail, and the Skills
 * tab's lists. A finished install changes the connectors and tool groups too; its plan's events refresh those, and so
 * does this.
 */
const STEP_KEYS: readonly QueryKey[] = [
  ["plugins", "capability-plugins"],
  ["plugins", "capability-plugin-detail"],
  ["skills", "capability-skills"],
  ["skills", "capability-skill-detail"],
  ["skills", "capability-skill-discover"],
  ["skills", "capability-skill-installs"],
];
const DONE_KEYS: readonly QueryKey[] = [
  ["mcp", "capability-connectors"],
  ["tools", "capability-tools"],
];

/** Where a key's install is read (the workspace it was checked or installed in) and what it refreshes. */
export interface PluginInstallContext {
  readonly client: QueryClient;
  readonly workspaceId: string;
}

/** The parts of an entry that outlast a step: the source and the attempt keys. */
export function keep(entry: PluginInstallEntry): PluginInstallEntry {
  return { state: entry.state, source: entry.source, checkKey: entry.checkKey, installKey: entry.installKey };
}

export const isFollowing = (entry: PluginInstallEntry | undefined) =>
  entry?.state.phase === "following" || entry?.asking === true;

/** The pieces' states in one line, to tell whether a read moved anything. */
export const stateLine = (detail: CapabilityPluginDetail | undefined) =>
  detail ? `${detail.state}:${detail.pieces.map((piece) => piece.state).join(",")}` : "";

export function pluginSkillOperation(workspaceId: string, snapshotId: string, operationKind: PluginSkillStepKind) {
  return { workspaceId, snapshotId, operationKind };
}

export function pluginWaitingStep(step: string | undefined): PluginSkillStepKind | undefined {
  return step === "waiting_install" ? "install_inactive" : step === "waiting_switch_on" ? "activate" : undefined;
}

export function refreshPluginInstallQueries(client: QueryClient | undefined, done: boolean) {
  for (const queryKey of done ? [...STEP_KEYS, ...DONE_KEYS] : STEP_KEYS) void client?.invalidateQueries({ queryKey });
}
