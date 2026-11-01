import {
  ConflictError,
  HOOK_TRIGGER_LABELS,
  SemanticValidationError,
  isGoatError,
  type CapabilityPluginInspection,
  type CapabilityPluginPieceView,
  type PluginManifest,
  type PluginPiece,
} from "@goatcitadel/contracts";
import type { EvolutionControlPlaneAdapterOutcome } from "./evolution-control-plane-adapter.js";
import type { PluginInstallSettings } from "./plugin-install-change-plan-adapter.js";
import {
  boundedSentences,
  failureDetail,
  groupLabel,
  hookHost,
  withoutControls,
  type PluginInstallHosts,
} from "./plugin-plan-support.js";

// The words a plugin install shows: its plan, its summaries, and why a step stopped, with what to do next.

/** A settings save another writer is making keeps the install from writing its hosts: nothing of it stays (Q1). */
export const SETTINGS_BUSY_MESSAGE =
  "GoatCitadel is saving another settings change. Install the plugin again in a moment.";
/** The hosts to allow don't fit in the text the operator approves, so the plan is never made (Q2). */
const HOSTS_CUT_MESSAGE =
  "This plugin asks to allow more hosts than one approval can list, so GoatCitadel can't install it.";

/** The settings owner refused a read or a write because another settings change is being saved. */
export class SettingsBusyError extends ConflictError {
  public constructor() {
    super({ message: SETTINGS_BUSY_MESSAGE });
  }
}

/** The install's steps in order; a failure's `failureCode` names the one it stopped at. */
export type InstallStep = "record" | "hosts" | "connectors" | "tool_groups" | "hooks" | "prompt_packs" | "finish";

/** What one install binds: the kept inspection, its manifest read from the snapshot, and each piece's view. */
export interface InstallBinding {
  readonly inspection: CapabilityPluginInspection;
  readonly manifest: PluginManifest;
  readonly treeSha256: string;
  readonly views: ReadonlyMap<string, CapabilityPluginPieceView>;
}

/** What an apply has done so far, read by the summary of a finished or a stopped install. */
export interface InstallProgress {
  allowed: string[];
  hookHostsAllowed: string[];
  readonly done: string[];
  /** Hook pieces whose hook now holds its secret. */
  readonly attached: Set<string>;
  recordWritten: boolean;
  /** The piece a step was working on when it stopped. */
  current?: PluginPiece;
}

/**
 * The plan's summary and confirmation text, bounded. Every host it allows must be in it whole, as the operator approves
 * the hosts only by reading them: a plan whose host sentences would be cut is refused instead (Q2).
 */
export function plannedSummary(
  binding: InstallBinding,
  settings: Pick<PluginInstallSettings, "deploymentProfile">,
  hosts: PluginInstallHosts,
): string {
  const sentences = plannedSentences(binding, settings, hosts);
  const summary = boundedSentences(sentences);
  const hostCount = (hosts.network.length > 0 ? 1 : 0) + (hosts.hooks.length > 0 ? 1 : 0);
  if (sentences.slice(0, hostCount).some((sentence) => !summary.includes(withoutControls(sentence)))) {
    throw new SemanticValidationError(HOSTS_CUT_MESSAGE);
  }
  return summary;
}

/** The plain steps the plan will take, in order, for its summary and its confirmation. */
function plannedSentences(
  binding: InstallBinding,
  settings: Pick<PluginInstallSettings, "deploymentProfile">,
  hosts: PluginInstallHosts,
): string[] {
  const { manifest } = binding;
  const sentences = [
    ...(hosts.network.length > 0 ? [`Allow ${hosts.network.join(", ")}.`] : []),
    ...(hosts.hooks.length > 0 ? [`Allow ${hosts.hooks.join(", ")} for hooks.`] : []),
  ];
  // Skills come last: each is added in its own steps once this plan has finished.
  const skills: string[] = [];
  for (const piece of manifest.pieces) {
    const view = binding.views.get(piece.id);
    const kept = view?.check.status === "already_there";
    switch (piece.kind) {
      case "connector": {
        const label = view?.label ?? piece.templateId;
        sentences.push(
          kept
            ? `Keep ${label}, which is already saved.`
            : settings.deploymentProfile === "remote_hardened"
              ? `Save ${label}, switched off. On this install every action it takes asks you first.`
              : piece.asksFirst === "everything"
                ? `Save ${label}, switched off, and everything it does asks you first.`
                : `Save ${label}, switched off, set to Reading is free.`,
        );
        break;
      }
      case "tool_group_off": {
        const label = groupLabel(piece.groupId);
        sentences.push(
          kept
            ? `${label} is already off, and stays your own switch.`
            : `Turn ${label} off in every chat while ${manifest.name} is installed.`,
        );
        break;
      }
      case "hook":
        sentences.push(
          `Add a hook that sends event details, never message text, to ${hookHost(piece.url)}: ` +
            `${HOOK_TRIGGER_LABELS[piece.trigger] ?? piece.trigger}.`,
        );
        break;
      case "prompt_pack":
        sentences.push(`Add the prompt pack ${view?.label ?? piece.id} to Library › Prompt packs.`);
        break;
      case "skill":
        skills.push(`List the skill ${view?.label ?? piece.id}, which is added in its own steps after this.`);
        break;
    }
  }
  return [...sentences, ...skills];
}

export function savedConnectorSentence(label: string, approval: "reads_free" | "everything_asks"): string {
  return approval === "reads_free"
    ? `Saved ${label}, switched off, set to Reading is free.`
    : `Saved ${label}, switched off, and everything it does asks you first.`;
}

/** One plain sentence per finished step, then a skill's own steps (R66). */
export function finishedSentences(binding: InstallBinding, progress: InstallProgress, finished: boolean): string[] {
  const skills = binding.manifest.pieces.filter((piece) => piece.kind === "skill");
  return [
    ...(finished ? [`Installed ${binding.manifest.name}.`] : []),
    ...(progress.allowed.length > 0 ? [`Allowed ${progress.allowed.join(", ")}.`] : []),
    ...(progress.hookHostsAllowed.length > 0 ? [`Allowed ${progress.hookHostsAllowed.join(", ")} for hooks.`] : []),
    ...progress.done,
    ...(finished
      ? skills.map((piece) => `The skill ${binding.views.get(piece.id)?.label ?? piece.id} still needs its own steps.`)
      : []),
  ];
}

/**
 * The outcome when a step fails (R79): plain sentences for what was added, what didn't happen and what to do next. The
 * record keeps listing what was added, so uninstalling the plugin removes it. The owner's own words go to
 * `failureDetail`, for technical details only.
 */
export function stopped(
  binding: InstallBinding,
  progress: InstallProgress,
  step: InstallStep,
  error: unknown,
): EvolutionControlPlaneAdapterOutcome {
  const name = binding.manifest.name;
  // Another install's record landed first: the plain refusal says so, and nothing of this install was written.
  if (step === "record" && isGoatError(error) && error.httpStatus < 500) {
    return { status: "failed", result: { summary: error.message, failureCode: "plugin_install_refused" } };
  }
  const detail = failureDetail(error);
  const next = progress.recordWritten
    ? `Uninstall ${name} to remove what it added, then install it again.`
    : "Nothing was changed, so trying again is safe.";
  return {
    status: progress.recordWritten ? "manual_required" : "failed",
    result: {
      summary: boundedSentences([
        ...finishedSentences(binding, progress, false),
        whatFailed(binding, progress, step),
        next,
      ]),
      failureCode: `plugin_install_${step}_failed`,
      ...(detail ? { failureDetail: detail } : {}),
    },
  };
}

/** What didn't happen, naming the piece the step was working on. */
function whatFailed(binding: InstallBinding, progress: InstallProgress, step: InstallStep): string {
  const piece = progress.current;
  const label = piece ? (binding.views.get(piece.id)?.label ?? piece.id) : undefined;
  switch (step) {
    case "record":
      return `Couldn't start installing ${binding.manifest.name}.`;
    case "hosts":
      return "Couldn't allow the hosts it needs.";
    case "connectors":
      return label ? `Couldn't save ${label}.` : "Couldn't save its connectors.";
    case "tool_groups":
      return "Couldn't turn its tool groups off.";
    case "hooks":
      return piece?.kind === "hook"
        ? `Couldn't add the hook that sends event details to ${hookHost(piece.url)}.`
        : "Couldn't add its hooks.";
    case "prompt_packs":
      return label ? `Couldn't add the prompt pack ${label}.` : "Couldn't add its prompt packs.";
    case "finish":
      return "Couldn't mark the install as finished.";
  }
}
