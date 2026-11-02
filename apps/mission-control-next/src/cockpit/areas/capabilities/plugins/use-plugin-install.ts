import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ApprovalRequest,
  CapabilityPluginDetail,
  CapabilityPluginInspection,
  PluginActionOutcome,
  PluginSource,
} from "@goatcitadel/contracts";
import {
  inspectCapabilityPlugin,
  installCapabilityPlugin,
} from "@goatcitadel/mission-control-shared/api/capability-plugins";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { pendingSkillStep } from "./plugin-install-view";
import { manifestRefusalLines, pluginRefusalOf, refusalMessage, wasAnswered } from "./plugin-check-copy";
import {
  __resetPluginInstallFlowForTests,
  adoptPluginDetail,
  bump,
  continueInstall,
  followPlan,
  forgetFlow,
  installContext,
  installStopped,
  keep,
  readNow,
  refreshInstall,
  setInstallContext,
  type PluginInstallContext,
} from "./plugin-install-flow";
import {
  cancelPluginInstallTick,
  pluginIdOfInstallKey,
  pluginInstallKey,
  readPluginInstall,
  setPluginInstall,
  usePluginInstallEntry,
  type PluginInstallEntry,
  type PluginInstallState,
  type PluginSkillStepKind,
} from "./plugin-install-store";

export type { PluginInstallState, PluginSkillStepKind } from "./plugin-install-store";
export { adoptPluginDetail, type PluginInstallContext } from "./plugin-install-flow";

/** The inspection or detail a state shows, whichever it holds. */
export function shownOf(
  state: PluginInstallState | undefined,
): CapabilityPluginInspection | CapabilityPluginDetail | undefined {
  if (!state) return undefined;
  if ("inspection" in state && state.inspection) return state.inspection;
  return "detail" in state ? state.detail : undefined;
}

function sameSource(left: PluginSource | undefined, right: PluginSource): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A refused manifest, as its panel shows it: its plain line, with the refusal's own words for Technical details. */
function refusedState(
  code: string,
  inspectionId: string,
  message: string,
  field: string | undefined,
): Extract<PluginInstallState, { phase: "check_failed" }> {
  return {
    phase: "check_failed",
    message: manifestRefusalLines(code, message)[0]!,
    code,
    inspectionId,
    technical: `${code}: ${message}${field ? ` (${field})` : ""}`,
  };
}

function inspectionState(inspection: CapabilityPluginInspection): PluginInstallState {
  const { refusal } = inspection;
  if (!refusal) return { phase: "ready", inspection };
  return refusedState(refusal.code, inspection.inspectionId, refusal.message, refusal.field);
}

/**
 * Takes on an inspection as the Gateway reads it, when nothing here follows it yet (an address after a reload, say).
 * With `replace`, a newer answer replaces what the key held.
 */
export function adoptPluginInspection(
  key: string,
  inspection: CapabilityPluginInspection,
  context: PluginInstallContext,
  extra: Partial<PluginInstallEntry> = {},
  replace = false,
) {
  if (readPluginInstall(key) && !replace) return;
  setInstallContext(key, context);
  bump(key);
  setPluginInstall(key, { ...extra, state: inspectionState(inspection) });
}

/**
 * Checks a source for the panel `key`. A new check gets a new attempt key; only a check whose answer never came is sent
 * again with the same one, so the Gateway hands back that check rather than making a second.
 */
export function startPluginInspection(key: string, source: PluginSource, context: PluginInstallContext) {
  const before = readPluginInstall(key);
  if (before?.state.phase === "checking") return;
  const retry = before?.state.phase === "check_failed" && before.lost === true && sameSource(before.source, source);
  const checkKey = retry && before.checkKey ? before.checkKey : crypto.randomUUID();
  setInstallContext(key, context);
  bump(key);
  cancelPluginInstallTick(key);
  setPluginInstall(key, { state: { phase: "checking" }, source, checkKey });
  void runInspection(key, source, checkKey, context);
}

async function runInspection(key: string, source: PluginSource, checkKey: string, context: PluginInstallContext) {
  const stillChecking = () => {
    const entry = readPluginInstall(key);
    return entry?.state.phase === "checking" && entry.checkKey === checkKey;
  };
  let inspection: CapabilityPluginInspection;
  try {
    inspection = await inspectCapabilityPlugin({ workspaceId: context.workspaceId, source }, { attemptKey: checkKey });
  } catch (error) {
    if (stillChecking()) inspectionRefused(key, source, checkKey, context, error);
    return;
  }
  if (!stillChecking()) return;
  const target = inspection.inspectionId;
  adoptPluginInspection(target, inspection, { ...context, workspaceId: inspection.workspaceId }, { source }, true);
  setPluginInstall(key, { state: inspectionState(inspection), source, checkKey, movedTo: target });
}

function inspectionRefused(
  key: string,
  source: PluginSource,
  checkKey: string,
  context: PluginInstallContext,
  error: unknown,
) {
  const refusal = pluginRefusalOf(error);
  const message = refusalMessage(error);
  // A refused manifest's check is kept, and its own address reads it back.
  if (refusal?.inspectionId) {
    const state = refusedState(refusal.code, refusal.inspectionId, message, refusal.field);
    setInstallContext(refusal.inspectionId, context);
    setPluginInstall(refusal.inspectionId, { state, source });
    return setPluginInstall(key, { state, source, checkKey, movedTo: refusal.inspectionId });
  }
  setPluginInstall(key, {
    source,
    checkKey,
    lost: !wasAnswered(error),
    state: { phase: "check_failed", message, ...(refusal ? { code: refusal.code } : {}) },
  });
}

/**
 * The panel's one confirmation. At a check that passed it posts the install, then follows the plan and each skill's
 * two steps; at an install that isn't finished ("Continue") it carries on from the first unfinished piece. It resolves
 * `true` once an install request was answered, when the secrets it carried are spent; `false` when nothing was sent
 * or no answer came, so a retry may send the same ones again under the same attempt key.
 */
export async function confirmPluginInstall(key: string, hookSecrets: Readonly<Record<string, string>>) {
  const entry = readPluginInstall(key);
  if (entry?.state.phase === "following") {
    continueInstall(key);
    return false;
  }
  const context = installContext(key);
  if (entry?.state.phase !== "ready" || entry.asking || !entry.state.inspection.installable || !context) return false;
  const { inspection } = entry.state;
  bump(key);
  setPluginInstall(key, { ...entry, asking: true, chain: true, lost: false, notice: undefined });
  const installKey = await attemptKeyFor(key, entry, hookSecrets);
  const asking = readPluginInstall(key);
  if (asking) setPluginInstall(key, { ...asking, installKey });
  const secrets = Object.keys(hookSecrets).length > 0 ? { hookSecrets: { ...hookSecrets } } : {};
  let outcome: PluginActionOutcome;
  try {
    outcome = await installCapabilityPlugin(
      { workspaceId: inspection.workspaceId, inspectionId: inspection.inspectionId, ...secrets },
      { attemptKey: installKey },
    );
  } catch (error) {
    if (wasAnswered(error)) lostSecrets.delete(key);
    else lostSecrets.set(key, await digestOf(hookSecrets));
    return installRefused(key, error);
  }
  lostSecrets.delete(key);
  refreshInstall(key);
  receiveOutcome(key, outcome);
  return true;
}

/**
 * A digest of the signing secrets an install request carried whose answer never came, by key. Only the digest is kept,
 * here and never in the store, so a retry can tell whether it sends the same secrets.
 */
const lostSecrets = new Map<string, string>();

async function digestOf(secrets: Readonly<Record<string, string>>): Promise<string> {
  const text = JSON.stringify(Object.entries(secrets).sort(([left], [right]) => left.localeCompare(right)));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The install's attempt key. A retry after an answer that never came reuses the lost request's key only when it sends
 * the same secrets: under that key the Gateway answers from the first request, which holds the first secrets, so a
 * secret typed again differently goes out as a new request with a new key instead.
 */
async function attemptKeyFor(
  key: string,
  entry: PluginInstallEntry,
  hookSecrets: Readonly<Record<string, string>>,
): Promise<string> {
  if (!entry.lost || !entry.installKey) return crypto.randomUUID();
  const same = lostSecrets.get(key) === (await digestOf(hookSecrets));
  return same ? entry.installKey : crypto.randomUUID();
}

function installRefused(key: string, error: unknown): boolean {
  const current = readPluginInstall(key);
  if (!current?.asking || current.state.phase !== "ready") return wasAnswered(error);
  bump(key);
  const notice = refusalMessage(error);
  if (!wasAnswered(error)) {
    setPluginInstall(key, { ...current, asking: false, chain: false, lost: true, notice, declined: false });
    return false;
  }
  // A check that isn't there any more can only be made again.
  if (isApiRequestError(error) && error.status === 404) {
    const { inspection } = current.state;
    setPluginInstall(key, { ...keep(current), state: { phase: "failed", message: notice, inspection } });
    return true;
  }
  setPluginInstall(key, { ...current, asking: false, chain: false, notice, declined: false });
  return true;
}

function receiveOutcome(key: string, outcome: PluginActionOutcome) {
  const entry = readPluginInstall(key);
  if (entry?.state.phase !== "ready") return;
  const { inspection } = entry.state;
  if (outcome.outcome === "failed") {
    const message = outcome.summary.trim() || installStopped(inspection.name);
    return setPluginInstall(key, { ...keep(entry), state: { phase: "failed", message, inspection } });
  }
  const approvalId = outcome.outcome === "waiting" ? outcome.approvalId : undefined;
  setPluginInstall(key, {
    ...entry,
    asking: false,
    state: { phase: "planned", planId: outcome.planId, inspection, ...(approvalId ? { approvalId } : {}) },
  });
  followPlan(key, !approvalId);
}

/** Forgets a panel's flow, so it starts again in the workspace active then. */
export function resetPluginInstall(key: string) {
  lostSecrets.delete(key);
  forgetFlow(key);
  setPluginInstall(key, undefined);
}

/**
 * The key a panel should move to, once: the next call answers nothing. A check that handed over to its plugin keeps
 * only the hand-over, with nothing of its own to show, so reopening its address (a copied link) goes to the plugin's
 * panel again rather than to a frozen "Installing…".
 */
export function takePluginInstallMove(key: string): string | undefined {
  const entry = readPluginInstall(key);
  if (!entry?.movedTo) return undefined;
  const target = entry.movedTo;
  if (pluginIdOfInstallKey(target) !== undefined) {
    forgetFlow(key);
    setPluginInstall(key, { state: IDLE, movedTo: target });
  } else {
    setPluginInstall(key, { ...entry, movedTo: undefined });
  }
  return target;
}

export interface PluginInstall {
  state: PluginInstallState;
  /** A request is on its way, or its answer isn't read back yet. */
  asking: boolean;
  /** The confirmation goes on through each skill's steps. */
  chain: boolean;
  /** A decline, or why the last request didn't go through. */
  notice?: string;
  /** The notice is a decline rather than a request that didn't go through. */
  declined: boolean;
  /** The install couldn't be read several times in a row; the reads go on. */
  unreadable: boolean;
  /** The source the last check read. */
  source?: PluginSource;
  /** The key this panel should move to, once. */
  movedTo?: string;
  /** The workspace the check was made in, or the plugin installed in: where its approvals and steps belong. */
  workspaceId: string;
  /** Which step the waiting skill approval is for, when known. */
  waitingStep?: PluginSkillStepKind;
  /** The skill step this app session asked for last, and for which piece. */
  asked?: { pieceId: string; kind: PluginSkillStepKind };
  inspect(source: PluginSource): void;
  /** Install (at a check that passed), or Continue (at an install that isn't finished). */
  confirm(hookSecrets: Readonly<Record<string, string>>): Promise<boolean>;
  /**
   * Reads now, for a decision made in the panel's approval. With `approved` for a skill step's approval, the install
   * goes on through the steps after it.
   */
  checkNow(status?: ApprovalRequest["status"]): void;
}

const IDLE: PluginInstallState = { phase: "idle" };

/**
 * A skill step's approval approved in the panel: the install goes on through the steps after it, as it does from the
 * confirmation. A reload loses the confirmation's chain, so approving a step reopened by Continue carries it on. The
 * step is kept as asked, so one that comes back unapplied reads as not done rather than being asked again. A step not
 * known here leaves the chain as it was.
 */
export function stepApproved(key: string, kind: PluginSkillStepKind | undefined) {
  const entry = readPluginInstall(key);
  const state = entry?.state;
  if (!entry || !kind || state?.phase !== "following" || !state.waitingApprovalId) return;
  const piece = state.detail.pieces.find((item) => item.pendingApprovalId === state.waitingApprovalId);
  if (piece?.kind !== "skill") return;
  setPluginInstall(key, { ...entry, chain: true, asked: { pieceId: piece.pieceId, kind } });
}

function waitingStepOf(entry: PluginInstallEntry | undefined): PluginSkillStepKind | undefined {
  const state = entry?.state;
  if (state?.phase !== "following" || !state.waitingApprovalId) return undefined;
  const piece = state.detail.pieces.find((item) => item.pendingApprovalId === state.waitingApprovalId);
  // The Gateway's own word first; then the step this session asked for, then the skill's own install.
  const named = pendingSkillStep(piece);
  if (named) return named;
  if (piece && entry?.asked?.pieceId === piece.pieceId) return entry.asked.kind;
  return entry?.waitingStep?.approvalId === state.waitingApprovalId ? entry.waitingStep.kind : undefined;
}

/**
 * One install panel's flow: checking a source, then installing every piece from one confirmation, or carrying on with
 * one that isn't finished. `seed` is the inspection or the plugin's detail as the Gateway read it, taken on when nothing
 * here follows the key yet (after a reload); with `reread`, a detail read afresh replaces an install this session saw
 * finish or stop. Every view of the same key reads the same entry, which outlasts each.
 */
export function usePluginInstall(
  key: string,
  seed?: { inspection?: CapabilityPluginInspection | null; detail?: CapabilityPluginDetail | null; reread?: boolean },
): PluginInstall {
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const entry = usePluginInstallEntry(key);
  const inspection = seed?.inspection;
  const detail = seed?.detail;
  const reread = seed?.reread === true;

  useEffect(() => {
    if (inspection && inspection.inspectionId === key) {
      adoptPluginInspection(key, inspection, { client, workspaceId: inspection.workspaceId });
    }
  }, [key, inspection, client]);
  useEffect(() => {
    if (detail && pluginInstallKey(detail.pluginId) === key) {
      adoptPluginDetail(key, detail, { client, workspaceId: detail.workspaceId }, reread);
    }
  }, [key, detail, client, reread]);

  return {
    state: entry?.state ?? IDLE,
    asking: entry?.asking === true,
    chain: entry?.chain === true,
    notice: entry?.notice,
    declined: entry?.declined === true,
    unreadable: entry?.unreadable === true,
    source: entry?.source,
    movedTo: entry?.movedTo,
    workspaceId: installContext(key)?.workspaceId ?? workspaceId,
    waitingStep: waitingStepOf(entry),
    ...(entry?.asked ? { asked: entry.asked } : {}),
    inspect: (source) => startPluginInspection(key, source, installContext(key) ?? { client, workspaceId }),
    confirm: (hookSecrets) => confirmPluginInstall(key, hookSecrets),
    checkNow: (status) => {
      if (status === "approved") stepApproved(key, waitingStepOf(readPluginInstall(key)));
      readNow(key);
    },
  };
}

export function __resetPluginInstallsForTests() {
  lostSecrets.clear();
  __resetPluginInstallFlowForTests();
}
