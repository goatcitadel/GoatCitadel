import { isGoatError } from "@goatcitadel/contracts";
import type { PluginPieceLabel } from "./capability-plugin-detail.js";
import type { StoredPlugin, StoredPluginPiece } from "./capability-plugin-store.js";
import type { EvolutionControlPlaneAdapterOutcome } from "./evolution-control-plane-adapter.js";
import { boundedSentences, failureDetail, groupLabel } from "./plugin-plan-support.js";
import type { ConnectorDecision, HolderDecision, UninstallScope } from "./plugin-uninstall-scope.js";
import type { SkillWaitReason } from "./plugin-uninstall-skills.js";

// The words a plugin uninstall shows: its plan, its summaries, and why a step stopped, with what to do next.

export const HOSTS_STAY = "Hosts it allowed stay in your allowlist.";

/** The uninstall's steps, in reverse install order; a failure's `failureCode` names the one it stopped at. */
export type UninstallStep = "record" | "hooks" | "prompt_packs" | "tool_groups" | "connectors" | "skills" | "finish";

/** What an apply has done so far, read by its summary. */
export interface UninstallProgress {
  removed: number;
  /** The piece a step was working on when it stopped. */
  current?: StoredPluginPiece;
  /** Connectors left to the operator because another installed plugin uses them. */
  readonly handedOver: string[];
  /** The skills whose removal still waits, by label. */
  readonly waiting: Array<{ label: string; reason: SkillWaitReason }>;
}

/** A step that stops with its own plain words and, when retrying alone won't help, its own next step. */
export class UninstallStepStopped extends Error {
  public constructor(
    public readonly what: string,
    detail: string,
    public readonly next?: string,
  ) {
    super(detail);
    this.name = "UninstallStepStopped";
  }
}

export function labelOf(piece: StoredPluginPiece, labels: ReadonlyMap<string, PluginPieceLabel>): string {
  const label = labels.get(piece.pieceId)?.label;
  if (label) return label;
  return piece.kind === "tool_group_off" && piece.ref ? groupLabel(piece.ref) : piece.pieceId;
}

export function piecesCount(count: number): string {
  return `${count} ${count === 1 ? "piece" : "pieces"}`;
}

/** What a hook sends to, as its detail says it, or its label. */
export function hookWords(piece: StoredPluginPiece, labels: ReadonlyMap<string, PluginPieceLabel>): string {
  const host = labels.get(piece.pieceId)?.hosts?.[0];
  return host ? `the hook that sends event details to ${host}` : `the hook ${labelOf(piece, labels)}`;
}

/** A hook named as the Hooks list shows it. */
export function holderWords(holder: Pick<HolderDecision, "label">): string {
  return `the hook "${holder.label}"`;
}

/** The plain steps the plan will take, in order, for its summary and its confirmation. */
export function plannedSentences(
  record: StoredPlugin,
  labels: ReadonlyMap<string, PluginPieceLabel>,
  installedSkills: ReadonlySet<string>,
  scope: UninstallScope,
): string[] {
  const owned = (kind: StoredPluginPiece["kind"]) =>
    record.pieces.filter((piece) => piece.kind === kind && piece.owned && piece.ref !== undefined);
  const sentences: string[] = [];
  for (const piece of owned("hook")) sentences.push(`Remove ${hookWords(piece, labels)}.`);
  if (!("unread" in scope.holders)) {
    for (const holder of scope.holders) {
      sentences.push(
        holder.action === "remove"
          ? `Remove ${holderWords(holder)}, which its unfinished install left.`
          : `Keep ${holderWords(holder)}, which uses a signing secret this plugin stored: remove that hook (or give ` +
              "it a new signing secret) in Hooks first.",
      );
    }
  }
  for (const piece of owned("prompt_pack")) {
    sentences.push(`Delete the prompt pack ${labelOf(piece, labels)}, with its runs and scores.`);
  }
  for (const piece of owned("tool_group_off")) sentences.push(`Stop holding ${labelOf(piece, labels)} off.`);
  if (scope.connectors) {
    for (const decision of scope.connectors) {
      const sentence = connectorSentence(decision);
      if (sentence) sentences.push(sentence);
    }
  } else {
    for (const piece of owned("connector")) sentences.push(`Remove the connector ${labelOf(piece, labels)}.`);
  }
  for (const piece of record.pieces.filter((item) => item.kind === "skill" && item.owned)) {
    if (installedSkills.has(piece.pieceId)) {
      sentences.push(`Remove the skill ${labelOf(piece, labels)}, so the AI can't use it.`);
    }
  }
  for (const piece of record.pieces.filter((item) => !item.owned)) {
    sentences.push(
      piece.handedOver
        ? `Keep ${labelOf(piece, labels)}, which is now yours.`
        : `Keep ${labelOf(piece, labels)}, which was already there.`,
    );
  }
  return [...sentences, HOSTS_STAY];
}

function connectorSentence(decision: ConnectorDecision): string | undefined {
  switch (decision.action) {
    case "remove":
      return `Remove the connector ${decision.label}.`;
    case "keep":
      return keptConnectorWords(decision, "Keep");
    case "unknown":
      return `Keep ${decision.label} for now, as it can't be told whether ${decision.plugin} uses it.`;
    case "handed_over":
      return `Keep ${decision.label}, which is now yours.`;
    case "gone":
      return undefined;
  }
}

/** A connector left to the operator: "Keep" in the plan, "Kept" once done. */
export function keptConnectorWords(
  decision: Extract<ConnectorDecision, { action: "keep" }>,
  verb: "Keep" | "Kept",
): string {
  return `${verb} ${decision.label}, which ${decision.keeper} ${decision.sure ? "uses" : "may use"}.`;
}

export function completedSummary(progress: UninstallProgress): string {
  return boundedSentences([`Removed ${piecesCount(progress.removed)}.`, ...progress.handedOver, HOSTS_STAY]);
}

/** Everything else is removed; a skill still waits for its revoke, for that revoke to apply, or for its own step. */
export function waitingSummary(record: StoredPlugin, progress: UninstallProgress): string {
  const removing = progress.waiting.filter((item) => item.reason === "removing").length;
  const then =
    removing === progress.waiting.length
      ? `Once ${removing === 1 ? "it's" : "they're"} off, uninstall ${record.name} again to finish.`
      : `Then uninstall ${record.name} again to finish.`;
  return boundedSentences([
    `Removed ${piecesCount(progress.removed)}.`,
    ...progress.handedOver,
    HOSTS_STAY,
    ...progress.waiting.map(({ label, reason }) => WAITING_WORDS[reason](label)),
    then,
  ]);
}

const WAITING_WORDS: Readonly<Record<SkillWaitReason, (label: string) => string>> = {
  revoke: (label) => `Removing the skill ${label} waits for your approval.`,
  removing: (label) => `The skill ${label} is being removed.`,
  own_step: (label) => `The skill ${label} is still taking one of its own steps.`,
};

/** The hooks couldn't be read in full, so no stored secret was deleted. */
export function undecidedSecretsStop(error: unknown): UninstallStepStopped {
  return new UninstallStepStopped(
    "Couldn't tell whether its hooks still use the signing secrets it stored, so they were kept.",
    failureDetail(error) ?? "The hooks or the install couldn't be read.",
  );
}

/** A hook holding a stored secret that isn't one the install left: both stay until the operator changes that hook. */
export function holderKeptStop(record: StoredPlugin, holder: HolderDecision): UninstallStepStopped {
  return new UninstallStepStopped(
    `${capitalized(holderWords(holder))}${holder.host ? `, which sends event details to ${holder.host},` : ""} uses a ` +
      "signing secret this plugin stored, so both were kept.",
    `Hook ${holder.hookId} holds the secret stored for piece ${holder.pieceId}.`,
    `Remove that hook (or give it a new signing secret) in Hooks, then uninstall ${record.name} again.`,
  );
}

/** Another plugin's connectors can't be read, so nothing was decided about this one. */
export function connectorUnknownStop(
  record: StoredPlugin,
  decision: Extract<ConnectorDecision, { action: "unknown" }>,
): UninstallStepStopped {
  return new UninstallStepStopped(
    `Couldn't tell whether ${decision.plugin} uses ${decision.label}, so no connector was removed.`,
    `The manifest of the plugin ${decision.plugin} can't be read.`,
    `Try again later, or uninstall ${decision.plugin} first, then uninstall ${record.name} again.`,
  );
}

/** A revoke that was approved and ended without revoking the skill, and asking again gets the same answer. */
export function revokeDidntTakeStop(
  record: StoredPlugin,
  label: string,
  approvalId: string,
  ended: string,
): UninstallStepStopped {
  return new UninstallStepStopped(
    `Couldn't remove the skill ${label}: its removal was approved, but it didn't take effect.`,
    `Revoke approval ${approvalId} ${ended}.`,
    `Uninstalling again won't change that until the skill changes. Switch it off in Skills so the AI can't use it, ` +
      `then uninstall ${record.name} again.`,
  );
}

/**
 * The skills step's stop once every skill was tried: the first skill that stopped, then each other one that stopped or
 * still waits, so none goes unnamed. Its next step and detail are the first stop's.
 */
export function skillsStop(
  stops: readonly UninstallStepStopped[],
  waiting: UninstallProgress["waiting"],
): UninstallStepStopped {
  const [first, ...others] = stops;
  return new UninstallStepStopped(
    [
      first!.what,
      ...others.map((stop) => stop.what),
      ...waiting.map(({ label, reason }) => WAITING_WORDS[reason](label)),
    ].join(" "),
    first!.message,
    first!.next,
  );
}

/** A piece its owner removed, whose record write then failed. */
export function recordedStop(what: string, error: unknown): UninstallStepStopped {
  return new UninstallStepStopped(
    `Removed ${what}, but couldn't record it.`,
    failureDetail(error) ?? "The plugin's record couldn't be saved.",
  );
}

/**
 * The outcome when a step fails: what was removed, what wasn't, and what to do next. The record keeps listing what is
 * left, so uninstalling again goes on from there. The owner's own words go to `failureDetail` only.
 */
export function stopped(
  record: StoredPlugin,
  labels: ReadonlyMap<string, PluginPieceLabel>,
  progress: UninstallProgress,
  step: UninstallStep,
  error: unknown,
): EvolutionControlPlaneAdapterOutcome {
  // Another change to the record landed first: the plain refusal says so, and nothing was removed.
  if (step === "record" && isGoatError(error) && error.httpStatus < 500) {
    return { status: "failed", result: { summary: error.message, failureCode: "plugin_uninstall_refused" } };
  }
  const detail = failureDetail(error);
  const own = error instanceof UninstallStepStopped ? error : undefined;
  return {
    status: step === "record" ? "failed" : "manual_required",
    result: {
      summary: boundedSentences([
        ...(progress.removed > 0 ? [`Removed ${piecesCount(progress.removed)}.`] : []),
        ...progress.handedOver,
        own ? own.what : whatFailed(record, labels, progress.current, step),
        own?.next ??
          (step === "record"
            ? "Nothing was removed, so trying again is safe."
            : `Uninstall ${record.name} again to finish.`),
      ]),
      failureCode: `plugin_uninstall_${step}_failed`,
      ...(detail ? { failureDetail: detail } : {}),
    },
  };
}

/** What didn't happen, naming the piece the step was working on. */
function whatFailed(
  record: StoredPlugin,
  labels: ReadonlyMap<string, PluginPieceLabel>,
  piece: StoredPluginPiece | undefined,
  step: UninstallStep,
): string {
  const label = piece ? labelOf(piece, labels) : undefined;
  switch (step) {
    case "record":
      return `Couldn't start uninstalling ${record.name}.`;
    case "hooks":
      return piece ? `Couldn't remove ${hookWords(piece, labels)}.` : "Couldn't remove its hooks.";
    case "prompt_packs":
      return label ? `Couldn't delete the prompt pack ${label}.` : "Couldn't delete its prompt packs.";
    case "tool_groups":
      return "Couldn't stop holding its tool groups off.";
    case "connectors":
      return label ? `Couldn't remove the connector ${label}.` : "Couldn't remove its connectors.";
    case "skills":
      return label ? `Couldn't remove the skill ${label}.` : "Couldn't remove its skills.";
    case "finish":
      return `Couldn't finish uninstalling ${record.name}.`;
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
