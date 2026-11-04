import type { CapabilityPluginDetail, CapabilityPluginDetailPiece, ChangePlanRecord } from "@goatcitadel/contracts";
import {
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { fetchCapabilityPluginDetail } from "@goatcitadel/mission-control-shared/api/capability-plugins";
import {
  fetchCapabilitySkillInstalls,
  requestCapabilitySkillOperation,
} from "@goatcitadel/mission-control-shared/api/capability-skills";
import { fetchChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { pluginInstallWaitMs, type Pace } from "./plugin-install-pacing";
import { DONE, ENDED } from "../change-plan-outcome";
import * as installCopy from "./plugin-check-copy";
export { DECLINED, installStopped } from "./plugin-check-copy";
import {
  clearPluginInstalls,
  cancelPluginInstallTick,
  pluginIdOfInstallKey,
  pluginInstallKey,
  pluginInstallSignal,
  readPluginInstall,
  schedulePluginInstallTick,
  setPluginInstall,
  setPluginInstallTicker,
  type PluginInstallEntry,
  type PluginSkillStepKind,
} from "./plugin-install-store";
import {
  refreshPluginInstallQueries,
  firstUnfinishedPiece,
  isFollowing,
  keep,
  stateLine,
  pluginSkillOperation,
  pluginWaitingStep,
  pendingSkillStep,
  type PluginInstallContext,
} from "./plugin-install-view";
import { setPluginUninstall } from "./plugin-uninstall-store";

// Following an install once it is confirmed: the plugin's own plan until the plugin has a record, then the plugin's
// detail while each skill goes through its two steps, asked for here as the Skills tab asks for them. The Gateway's
// answers are the truth; nothing here decides what a piece is or whether a step may run.

/** Failed reads in a row before the panel says it can't check. */
const MISSED_READS_LIMIT = 3;

const contexts = new Map<string, PluginInstallContext>();
/** Keys being read now, and those to read again once that read ends. */
const reading = new Set<string>();
const readAgain = new Set<string>();
/** Keys with a request on its way: they are read once it answers, never while it is out. */
const sending = new Map<string, symbol>();
/** Bumped by every request, so a read that started before it is dropped. */
const generations = new Map<string, number>();
/** Reads at the current stage, which set how often the next one comes. */
const beats = new Map<string, { stage: string; pace: Pace; count: number }>();
const misses = new Map<string, number>();
/** Approvals whose step was looked up already, so each is read once. */
const stepLookups = new Set<string>();
let custody = 0;

subscribeGatewayAccessChange(retirePluginInstallFlow);
subscribeGatewayCallerScope(retirePluginInstallFlow);

/** The stage of a step the rate limit refused. */
const LIMITED = "limited:";

export const installContext = (key: string) => contexts.get(key);
export const setInstallContext = (key: string, context: PluginInstallContext) => contexts.set(key, context);
export const bump = (key: string) => generations.set(key, (generations.get(key) ?? 0) + 1);
export const generationOf = (key: string) => generations.get(key) ?? 0;
export const pluginInstallCustody = () => custody;

export function refreshInstall(key: string, done = false) {
  refreshPluginInstallQueries(contexts.get(key)?.client, done);
}

/** Counts one more wait at the stage and schedules the next read after it. */
function paced(key: string, stage: string, pace: Pace) {
  const beat = beats.get(key);
  const count = beat?.stage === stage ? beat.count + 1 : 1;
  beats.set(key, { stage, pace, count });
  schedulePluginInstallTick(key, pluginInstallWaitMs(pace, count));
}

function missedRead(key: string) {
  const entry = readPluginInstall(key);
  if (!entry || !(entry.state.phase === "planned" || isFollowing(entry))) return;
  const missed = (misses.get(key) ?? 0) + 1;
  misses.set(key, missed);
  if (missed >= MISSED_READS_LIMIT && !entry.unreadable) setPluginInstall(key, { ...entry, unreadable: true });
  const beat = beats.get(key);
  paced(key, beat?.stage ?? "missed", beat?.pace ?? "applying");
}

/** Starts following the plugin's own plan: at once when it is applying, after a wait while its approval waits. */
export function followPlan(key: string, now: boolean) {
  misses.delete(key);
  beats.delete(key);
  if (now) void readPlan(key);
  else paced(key, "plan:awaiting_approval", "waiting");
}

/** Reads what the key follows now: its plan while planned, its detail while following. */
export function readNow(key: string) {
  beats.delete(key);
  const phase = readPluginInstall(key)?.state.phase;
  if (phase === "planned") return void readPlan(key);
  if (phase === "following") return void readDetail(key);
}

setPluginInstallTicker((key) => (readPluginInstall(key)?.state.phase === "planned" ? readPlan(key) : readDetail(key)));

/** Reads the plugin's plan once; once it has applied, the plugin's detail too, which the install goes on from. */
async function readPlan(key: string) {
  const entry = readPluginInstall(key);
  const context = contexts.get(key);
  if (!context || entry?.state.phase !== "planned" || sending.has(key)) return;
  if (reading.has(key)) return void readAgain.add(key);
  const { planId, inspection } = entry.state;
  const started = custody;
  const generation = generationOf(key);
  reading.add(key);
  let plan: ChangePlanRecord | undefined;
  let detail: CapabilityPluginDetail | undefined;
  try {
    plan = await fetchChangePlan(planId, { workspaceId: context.workspaceId });
    if (started === custody && generationOf(key) === generation && DONE.has(plan.status)) {
      // Applied, so the record is there; a 404 now is a read to try again, not a plugin that went.
      detail = await fetchCapabilityPluginDetail(context.workspaceId, inspection.pluginId, {
        signal: pluginInstallSignal(key),
      });
    }
  } catch {
    plan = undefined;
  }
  if (started !== custody) return;
  reading.delete(key);
  if (readAgain.delete(key) || generationOf(key) !== generation) return void readPlan(key);
  if (!plan || (DONE.has(plan.status) && !detail)) return missedRead(key);
  misses.delete(key);
  receivePlan(key, plan, detail);
}

function receivePlan(key: string, plan: ChangePlanRecord, detail: CapabilityPluginDetail | undefined) {
  const entry = readPluginInstall(key);
  if (entry?.state.phase !== "planned") return;
  if (detail) return moveToPlugin(key, entry, detail);
  if (ENDED.has(plan.status)) return planEnded(key, entry, plan);
  const action = plan.requiredAction;
  const approvalId = plan.status === "awaiting_approval" && action?.kind === "approval" ? action.approvalId : undefined;
  const { planId, inspection } = entry.state;
  setPluginInstall(key, {
    ...entry,
    asking: false,
    unreadable: false,
    state: { phase: "planned", planId, inspection, ...(approvalId ? { approvalId } : {}) },
  });
  paced(key, `plan:${plan.status}`, approvalId ? "waiting" : "applying");
}

/** Why the plugin's plan ended without applying. A decline or an expiry leaves the check, so Install is offered again. */
function planEnded(key: string, entry: PluginInstallEntry, plan: ChangePlanRecord) {
  if (entry.state.phase !== "planned") return;
  const { inspection } = entry.state;
  const back = (notice: string, declined: boolean) =>
    setPluginInstall(key, { ...keep(entry), state: { phase: "ready", inspection }, notice, declined });
  refreshInstall(key);
  const outcome = installCopy.endedInstallNotice(plan);
  if (outcome) return back(outcome.notice, outcome.declined);
  // The plan's own summary says what was added and what to do next.
  const message = plan.result?.summary?.trim() || installCopy.installStopped(inspection.name);
  setPluginInstall(key, { ...keep(entry), state: { phase: "failed", message, inspection } });
}

/** The plugin has a record: its own key goes on from here, where a reload finds it too. */
function moveToPlugin(key: string, entry: PluginInstallEntry, detail: CapabilityPluginDetail) {
  const target = pluginInstallKey(detail.pluginId);
  const context = contexts.get(key)!;
  contexts.set(target, { client: context.client, workspaceId: detail.workspaceId });
  bump(target);
  cancelPluginInstallTick(target);
  setPluginInstall(target, { state: { phase: "following", detail }, source: entry.source, chain: entry.chain });
  // An uninstall this session saw for an earlier copy of the plugin says nothing about this one.
  setPluginUninstall(detail.pluginId, undefined);
  setPluginInstall(key, { ...keep(entry), state: { phase: "following", detail }, movedTo: target });
  refreshInstall(target);
  receiveDetail(target, detail);
}

/**
 * Takes on a plugin's detail when nothing here follows it yet (after a reload, say), or, with `reread`, a detail read
 * afresh for an install this session saw finish or stop: the Gateway may have moved on since (a skill switched off).
 */
export function adoptPluginDetail(
  key: string,
  detail: CapabilityPluginDetail,
  context: PluginInstallContext,
  reread = false,
) {
  const state = readPluginInstall(key)?.state;
  if (state && !(reread && (state.phase === "done" || state.phase === "failed"))) return;
  // The same answer again (a refresh the finish itself asked for) changes nothing.
  if (state && "detail" in state && stateLine(state.detail) === stateLine(detail)) return;
  contexts.set(key, context);
  bump(key);
  setPluginInstall(key, { state: { phase: "following", detail } });
  receiveDetail(key, detail);
}

/** "Continue": asks for the first unfinished skill's next step, and goes on through every step after it. */
export function continueInstall(key: string) {
  const entry = readPluginInstall(key);
  if (entry?.state.phase !== "following" || entry.asking) return;
  setPluginInstall(key, { ...entry, chain: true, asked: undefined, notice: undefined, declined: false });
  receiveDetail(key, entry.state.detail);
}

async function readDetail(key: string, force = false) {
  const context = contexts.get(key);
  const entry = readPluginInstall(key);
  const pluginId = entry?.state.phase === "following" ? entry.state.detail.pluginId : pluginIdOfInstallKey(key);
  if (!context || !pluginId || sending.has(key) || !(force || isFollowing(entry))) return;
  if (reading.has(key)) return void readAgain.add(key);
  const started = custody;
  const generation = generationOf(key);
  reading.add(key);
  let detail: CapabilityPluginDetail | undefined;
  let gone = false;
  try {
    detail = await fetchCapabilityPluginDetail(context.workspaceId, pluginId, { signal: pluginInstallSignal(key) });
  } catch (error) {
    gone = isApiRequestError(error) && error.status === 404;
  }
  if (started !== custody) return;
  reading.delete(key);
  if (readAgain.delete(key) || generationOf(key) !== generation) return void readDetail(key, force);
  if (!detail && !gone) return missedRead(key);
  misses.delete(key);
  const current = readPluginInstall(key);
  if (!current || !(force || isFollowing(current))) return;
  if (detail) return receiveDetail(key, detail);
  setPluginInstall(key, { ...keep(current), state: { phase: "failed", message: installCopy.NOT_FOUND } });
  refreshInstall(key);
}

/** Takes on the plugin's detail and moves the install on from its first unfinished piece. */
function receiveDetail(key: string, detail: CapabilityPluginDetail) {
  const entry = readPluginInstall(key);
  if (!entry) return;
  const before = entry.state.phase === "following" ? entry.state.detail : undefined;
  if (stateLine(before) !== stateLine(detail)) refreshInstall(key);
  if (detail.state === "installed") {
    setPluginInstall(key, { ...keep(entry), state: { phase: "done", pluginId: detail.pluginId, detail } });
    return refreshInstall(key, true);
  }
  if (detail.state === "uninstalling") {
    return setPluginInstall(key, {
      ...keep(entry),
      state: { phase: "failed", message: installCopy.UNINSTALLING, detail },
    });
  }
  const piece = firstUnfinishedPiece(detail.pieces);
  if (piece?.kind === "skill") return skillPiece(key, entry, detail, piece);
  otherPiece(key, entry, detail, piece);
}

function skillPiece(
  key: string,
  entry: PluginInstallEntry,
  detail: CapabilityPluginDetail,
  piece: CapabilityPluginDetailPiece,
) {
  const asked = entry.asked?.pieceId === piece.pieceId ? entry.asked.kind : undefined;
  const following = { ...entry, asking: false, unreadable: false, state: { phase: "following" as const, detail } };
  switch (piece.state) {
    case "check_passed":
    case "installed_off": {
      const kind: PluginSkillStepKind = piece.state === "check_passed" ? "install_inactive" : "activate";
      // Back where it was after asking for this very step: declined, expired or withdrawn, the detail can't tell.
      if (asked === kind) {
        const notice = installCopy.stepNotDone(piece.label, kind);
        return setPluginInstall(key, { ...following, chain: false, asked: undefined, notice, declined: true });
      }
      setPluginInstall(key, following);
      return entry.chain ? void requestStep(key, piece, kind) : undefined;
    }
    case "waiting_for_approval": {
      const approvalId = piece.pendingApprovalId;
      setPluginInstall(key, {
        ...following,
        state: { ...following.state, ...(approvalId ? { waitingApprovalId: approvalId } : {}) },
      });
      if (approvalId && !asked && !pendingSkillStep(piece)) void lookUpWaitingStep(key, piece, approvalId);
      return paced(key, `${piece.pieceId}:waiting:${approvalId ?? ""}`, "waiting");
    }
    case "installing":
      setPluginInstall(key, following);
      return paced(key, `${piece.pieceId}:installing`, "applying");
    case "failed":
      return setPluginInstall(key, {
        ...keep(entry),
        state: { phase: "failed", message: installCopy.stepStopped(piece.label, asked), detail },
      });
    default:
      // Its check can't be read right now: the reads go on, and nothing is claimed about it.
      setPluginInstall(key, { ...following, unreadable: true });
      return paced(key, `${piece.pieceId}:unknown`, "waiting");
  }
}

/** A piece that isn't a skill: the plan still adds it, it can't be read, or the install stopped before it. */
function otherPiece(
  key: string,
  entry: PluginInstallEntry,
  detail: CapabilityPluginDetail,
  piece: CapabilityPluginDetailPiece | undefined,
) {
  const following = { ...entry, asking: false, unreadable: false, state: { phase: "following" as const, detail } };
  if (!piece || piece.state === "installing") {
    setPluginInstall(key, following);
    return paced(key, "plan:applying", "applying");
  }
  if (piece.state === "unknown") {
    setPluginInstall(key, { ...following, unreadable: true });
    return paced(key, `${piece.pieceId}:unknown`, "waiting");
  }
  // Only uninstalling it can clean up after this, which the plugin's own panel offers.
  setPluginInstall(key, {
    ...keep(entry),
    state: { phase: "failed", message: installCopy.pieceStopped(detail.name), detail },
  });
  void readPlanSummary(key, detail);
}

/** The install plan's own summary for a stop, which says what it added and what to do next. */
async function readPlanSummary(key: string, detail: CapabilityPluginDetail) {
  const context = contexts.get(key);
  if (!context) return;
  const started = custody;
  const generation = generationOf(key);
  // A plan that can't be read leaves the panel's own line.
  const plan = await fetchChangePlan(detail.installPlanId, { workspaceId: context.workspaceId }).catch(() => undefined);
  if (started !== custody || generationOf(key) !== generation) return;
  const summary = plan?.result?.summary?.trim();
  const entry = readPluginInstall(key);
  if (summary && entry?.state.phase === "failed" && entry.state.detail?.pluginId === detail.pluginId) {
    setPluginInstall(key, { ...entry, state: { ...entry.state, message: summary } });
  }
}

/** Which step a waiting approval is for, from the skill's own install, when the detail doesn't name it. */
async function lookUpWaitingStep(key: string, piece: CapabilityPluginDetailPiece, approvalId: string) {
  const context = contexts.get(key);
  if (!context || !piece.skillSnapshotId || stepLookups.has(approvalId)) return;
  const started = custody;
  stepLookups.add(approvalId);
  try {
    const answer = await fetchCapabilitySkillInstalls(context.workspaceId, {
      snapshotId: piece.skillSnapshotId,
      signal: pluginInstallSignal(key),
    });
    if (started !== custody) return;
    const step = answer.installs.find((install) => install.snapshotId === piece.skillSnapshotId)?.step;
    const kind = pluginWaitingStep(step);
    const entry = readPluginInstall(key);
    if (kind && entry?.state.phase === "following" && entry.state.waitingApprovalId === approvalId) {
      setPluginInstall(key, { ...entry, waitingStep: { approvalId, kind } });
    }
  } catch {
    // Its approval is titled by the skill alone until a later wait looks it up again.
    if (started === custody) stepLookups.delete(approvalId);
  }
}

/** Asks for one of a skill's steps in the plugin's workspace, and reads the detail once the request answers. */
async function requestStep(key: string, piece: CapabilityPluginDetailPiece, kind: PluginSkillStepKind) {
  const entry = readPluginInstall(key);
  const context = contexts.get(key);
  if (!entry || !context || entry.asking || sending.has(key) || !piece.skillSnapshotId) return;
  const started = custody;
  const request = Symbol();
  bump(key);
  const generation = generationOf(key);
  cancelPluginInstallTick(key);
  misses.delete(key);
  // A step asked again after the rate limit refused it keeps counting its waits, so the retries slow down.
  if (!beats.get(key)?.stage.startsWith(LIMITED)) beats.delete(key);
  setPluginInstall(key, { ...entry, asking: true, asked: { pieceId: piece.pieceId, kind }, notice: undefined });
  if (started !== custody || generationOf(key) !== generation) return;
  sending.set(key, request);
  const takeRequest = () => {
    if (started !== custody || sending.get(key) !== request) return false;
    sending.delete(key);
    return generationOf(key) === generation;
  };
  try {
    await requestCapabilitySkillOperation(pluginSkillOperation(context.workspaceId, piece.skillSnapshotId, kind));
  } catch (error) {
    if (takeRequest()) refusedStep(key, kind, error);
    return;
  }
  if (!takeRequest()) return;
  beats.delete(key);
  refreshInstall(key);
  const current = readPluginInstall(key);
  if (!current?.asking || current.asked?.kind !== kind) return;
  // Approved or waiting: the detail is read at once and says which.
  bump(key);
  void readDetail(key);
}

function refusedStep(key: string, kind: PluginSkillStepKind, error: unknown) {
  const current = readPluginInstall(key);
  if (!current?.asking || current.asked?.kind !== kind) return;
  bump(key);
  const status = isApiRequestError(error) ? error.status : undefined;
  // The 20-a-minute step limit: asked again on the waiting pace (5 seconds, slowing to every 30), and the confirmation
  // goes on. Nothing changed, so nothing is refreshed, and the detail is read only as often as the step is asked.
  if (status === 429) {
    setPluginInstall(key, { ...current, asking: false, asked: undefined });
    return paced(key, `${LIMITED}${kind}`, "waiting");
  }
  refreshInstall(key);
  const detail = current.state.phase === "following" ? current.state.detail : undefined;
  if (status === 404) {
    return setPluginInstall(key, {
      ...keep(current),
      state: { phase: "failed", message: installCopy.refusalMessage(error), ...(detail ? { detail } : {}) },
    });
  }
  setPluginInstall(key, {
    ...current,
    asking: false,
    asked: undefined,
    chain: false,
    notice: installCopy.refusalMessage(error),
  });
  // A step the checks don't allow now: the detail is read again to show why.
  if (status === 409) void readDetail(key, true);
}

/** Forgets a key's flow state (not its entry). */
export function forgetFlow(key: string) {
  bump(key);
  contexts.delete(key);
  sending.delete(key);
  beats.delete(key);
  misses.delete(key);
}

export function retirePluginInstallFlow() {
  custody += 1;
  contexts.clear();
  reading.clear();
  readAgain.clear();
  sending.clear();
  generations.clear();
  beats.clear();
  misses.clear();
  stepLookups.clear();
  clearPluginInstalls();
}

export type { PluginInstallContext } from "./plugin-install-view";

export { keep } from "./plugin-install-view";
