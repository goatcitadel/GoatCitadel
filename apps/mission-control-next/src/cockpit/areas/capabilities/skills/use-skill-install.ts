import { useEffect } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { CapabilitySkillInstall, CapabilitySkillInstallStep, CapabilitySkillSource } from "@goatcitadel/contracts";
import {
  fetchCapabilitySkillInstalls,
  requestCapabilitySkillOperation,
  reviewCapabilitySkill,
} from "@goatcitadel/mission-control-shared/api/capability-skills";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { describeCheckFailure } from "./skill-check-copy";
import {
  __resetSkillInstallStoreForTests,
  cancelSkillInstallTick,
  installSignal,
  readSkillInstall,
  scheduleSkillInstallTick,
  setSkillInstall,
  setSkillInstallTicker,
  useSkillInstallEntry,
  type SkillInstallEntry,
  type SkillInstallState,
  type SkillInstallStepKind,
} from "./skill-install-store";

export type { SkillInstallState, SkillInstallStepKind } from "./skill-install-store";

/**
 * Waits between reads while a step is applied: a second for the first 30, then 3 seconds. The installs read allows 60
 * a minute, which a steady read a second would use up. A read that fails counts as one, so failing reads slow too.
 */
const APPLYING_MS = 1_000;
const APPLYING_FAST_WAITS = 30;
const APPLYING_SLOW_MS = 3_000;
/**
 * Waits between reads while a step waits for its approval, which never expires: 5 seconds at first, then less often,
 * at most every 30, as the skill switch reads its own approval.
 */
const WAITING_MS = [5_000, 5_000, 5_000, 10_000, 20_000, 30_000] as const;
/** The wait before a failed read is tried again at a step that is not read on its own (a read after a refusal). */
const UNPACED_RETRY_MS = 5_000;
/** Failed reads in a row before the panel says it can't check. */
const MISSED_READS_LIMIT = 3;

const DECLINED_INSTALL = "Not installed. The request was declined.";
const DECLINED_SWITCH_ON = "Installed, not switched on. The request to switch it on was declined.";
/** The notices that say a request was declined: the operator's own choice, unlike a request that didn't go through. */
const DECLINES: ReadonlySet<string> = new Set([DECLINED_INSTALL, DECLINED_SWITCH_ON]);
const NOT_FOUND = "This install can't be found anymore. Check it again to start over.";
const FAILED_STEP: Readonly<Record<SkillInstallStepKind, string>> = {
  install_inactive: "Installing didn't finish.",
  activate: "Switching on didn't finish.",
};
/** A stop whose step isn't known here and that comes without the Gateway's own line, which names the step. */
const FAILED_UNKNOWN = "It didn't finish.";

/**
 * What an install's step changes: Discover's marks ("Install not finished" with Continue) and the installs. Hub installs
 * send no event, so these are read again whenever a step changes or a step's request answers.
 */
const STEP_KEYS: readonly QueryKey[] = [
  ["skills", "capability-skill-discover"],
  ["skills", "capability-skill-installs"],
];
/** What only a finished install changes too: the installed list. */
const DONE_KEY: QueryKey = ["skills", "capability-skills"];

/** Where a check's install is read and what a finished one refreshes. */
export interface SkillInstallContext {
  readonly client: QueryClient;
  readonly workspaceId: string;
}

const contexts = new Map<string, SkillInstallContext>();
/** Checks whose install is being read now, and those to read again once that read ends. */
const reading = new Set<string>();
const readAgain = new Set<string>();
/** Checks with a step request on its way: their install is read once it answers, never while it is out. */
const sending = new Set<string>();
/** Bumped by every request, so a read that started before it is dropped. */
const generations = new Map<string, number>();
/** Reads at the current step, which set how often the next one comes, and the step they were at. */
const beats = new Map<string, { step: CapabilitySkillInstallStep; count: number }>();
const misses = new Map<string, number>();

const bump = (key: string) => generations.set(key, (generations.get(key) ?? 0) + 1);

/** The parts of an entry that outlast a step: the source and the check's key. */
function keep(entry: SkillInstallEntry): SkillInstallEntry {
  return { state: entry.state, source: entry.source, idempotencyKey: entry.idempotencyKey, notice: entry.notice };
}

export function installOf(state: SkillInstallState | undefined): CapabilitySkillInstall | undefined {
  return state && "install" in state ? state.install : undefined;
}

/** The state a check's install reads as when no confirmation here is following it. */
function stateFor(install: CapabilitySkillInstall): SkillInstallState {
  switch (install.step) {
    case "check_passed":
    case "blocked":
      return { phase: "ready", install };
    case "done":
      return { phase: "done", skillId: install.installedSkillId ?? "", install };
    case "failed":
      return { phase: "failed", message: FAILED_UNKNOWN, install };
    default:
      return { phase: "following", install };
  }
}

/** How a step is read: `waiting` for its approval, `applying` while it is applied or its request is out, else not at all. */
function paceOf(step: CapabilitySkillInstallStep | undefined, asking: boolean): "applying" | "waiting" | undefined {
  if (step === "waiting_install" || step === "waiting_switch_on") return "waiting";
  return asking || step === "installing" || step === "switching_on" ? "applying" : undefined;
}

/** Counts one more wait at the step, after a read or a failed one, and says how long it is. */
function nextWait(key: string, step: CapabilitySkillInstallStep, pace: "applying" | "waiting"): number {
  const beat = beats.get(key);
  const count = beat?.step === step ? beat.count + 1 : 1;
  beats.set(key, { step, count });
  if (pace === "waiting") return WAITING_MS[Math.min(count, WAITING_MS.length) - 1] ?? WAITING_MS[0];
  return count <= APPLYING_FAST_WAITS ? APPLYING_MS : APPLYING_SLOW_MS;
}

function schedule(key: string, step: CapabilitySkillInstallStep) {
  const pace = paceOf(step, false);
  if (pace) scheduleSkillInstallTick(key, nextWait(key, step, pace));
  else cancelSkillInstallTick(key);
}

const isFollowing = (entry: SkillInstallEntry | undefined) =>
  entry?.state.phase === "following" || entry?.asking === true;

/** Reads Discover and the installs again, and the installed list too once an install is done. */
function refreshInstalls(key: string, done = false) {
  const client = contexts.get(key)?.client;
  for (const queryKey of done ? [...STEP_KEYS, DONE_KEY] : STEP_KEYS) void client?.invalidateQueries({ queryKey });
}

/**
 * Takes on an install read from the Gateway, after a request of this panel or on its own. A step that changed (on its
 * way, declined back to the step before, stopped or done) is shown in Discover and the installs at once.
 */
function receive(key: string, install: CapabilitySkillInstall | undefined) {
  const entry = readSkillInstall(key);
  if (!entry) return;
  if (!install) {
    setSkillInstall(key, { ...keep(entry), state: { phase: "failed", message: NOT_FOUND } });
    return refreshInstalls(key);
  }
  const changed = installOf(entry.state)?.step !== install.step;
  take(key, entry, install);
  if (changed) refreshInstalls(key, install.step === "done");
}

function take(key: string, entry: SkillInstallEntry, install: CapabilitySkillInstall) {
  const { asked } = entry;
  switch (install.step) {
    case "done":
      return setSkillInstall(key, { ...keep(entry), state: stateFor(install) });
    case "failed":
      return setSkillInstall(key, {
        ...keep(entry),
        asked,
        state: { phase: "failed", message: asked ? FAILED_STEP[asked] : FAILED_UNKNOWN, install },
      });
    case "installed_off":
      // Installed after this confirmation: switching on is asked for at once, with no other press.
      if (entry.chain && asked === "install_inactive") {
        setSkillInstall(key, { ...entry, asking: false, state: { phase: "following", install } });
        return void request(key, "activate", true);
      }
      // Back at installed_off after asking to switch it on: that request was declined.
      return setSkillInstall(key, {
        ...keep(entry),
        state: { phase: "following", install },
        ...(asked === "activate" ? { notice: DECLINED_SWITCH_ON } : {}),
      });
    case "check_passed":
    case "blocked":
      return setSkillInstall(key, {
        ...keep(entry),
        state: { phase: "ready", install },
        ...(asked === "install_inactive" && install.step === "check_passed" ? { notice: DECLINED_INSTALL } : {}),
      });
    default:
      setSkillInstall(key, { ...entry, asking: false, unreadable: false, state: { phase: "following", install } });
      return schedule(key, install.step);
  }
}

function missedRead(key: string) {
  const entry = readSkillInstall(key);
  if (!isFollowing(entry) || !entry) return;
  const missed = (misses.get(key) ?? 0) + 1;
  misses.set(key, missed);
  if (missed >= MISSED_READS_LIMIT && !entry.unreadable) setSkillInstall(key, { ...entry, unreadable: true });
  const step = installOf(entry.state)?.step ?? "check_passed";
  const pace = paceOf(step, entry.asking === true);
  scheduleSkillInstallTick(key, pace ? nextWait(key, step, pace) : UNPACED_RETRY_MS);
}

/** Reads the check's install once. `force` reads it although nothing is followed (a refusal may have changed it). */
async function readInstall(key: string, force = false) {
  const context = contexts.get(key);
  if (!context || sending.has(key) || !(force || isFollowing(readSkillInstall(key)))) return;
  if (reading.has(key)) {
    readAgain.add(key);
    return;
  }
  const generation = generations.get(key) ?? 0;
  reading.add(key);
  let install: CapabilitySkillInstall | undefined;
  let failed = false;
  try {
    const answer = await fetchCapabilitySkillInstalls(context.workspaceId, {
      snapshotId: key,
      signal: installSignal(key),
    });
    install = answer.installs.find((item) => item.snapshotId === key);
  } catch {
    failed = true;
  }
  reading.delete(key);
  const stale = (generations.get(key) ?? 0) !== generation;
  if (readAgain.delete(key) || stale) return void readInstall(key, force);
  if (failed) return missedRead(key);
  misses.delete(key);
  if (force || isFollowing(readSkillInstall(key))) receive(key, install);
}

setSkillInstallTicker((key) => readInstall(key));

/** The route's own plain line for a refusal, or a plain summary. */
function refusalMessage(error: unknown): string {
  if (isApiRequestError(error) && typeof error.body === "object" && error.body !== null) {
    const message = (error.body as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return describeApiError(error).summary;
}

/** Asks for one install step of the check `key` and follows it. `chain` goes on to switch it on once installed. */
async function request(key: string, kind: SkillInstallStepKind, chain: boolean) {
  const entry = readSkillInstall(key);
  const context = contexts.get(key);
  const install = installOf(entry?.state);
  if (!entry || !context || !install || entry.asking) return;
  bump(key);
  cancelSkillInstallTick(key);
  // A new request is read at the first pace, however long the step it comes back to waited before.
  misses.delete(key);
  beats.delete(key);
  setSkillInstall(key, {
    state: { phase: "following", install },
    source: entry.source,
    idempotencyKey: entry.idempotencyKey,
    asked: kind,
    asking: true,
    chain,
  });
  sending.add(key);
  try {
    await requestCapabilitySkillOperation({ workspaceId: context.workspaceId, snapshotId: key, operationKind: kind });
  } catch (error) {
    sending.delete(key);
    refreshInstalls(key);
    const current = readSkillInstall(key);
    if (!current?.asking || current.asked !== kind) return;
    bump(key);
    // A check that isn't there any more can only be checked again.
    if (isApiRequestError(error) && error.status === 404) {
      return setSkillInstall(key, { ...keep(current), state: { phase: "failed", message: refusalMessage(error) } });
    }
    setSkillInstall(key, { ...keep(current), notice: refusalMessage(error), state: stateFor(install) });
    // A step the checks don't allow now: the install is read again to show why.
    if (isApiRequestError(error) && error.status === 409) void readInstall(key, true);
    return;
  }
  sending.delete(key);
  // Whatever the answer, the request may have made an approval or moved a step: Discover and the installs say so.
  refreshInstalls(key);
  const current = readSkillInstall(key);
  if (!current?.asking || current.asked !== kind) return;
  // Approved or waiting: the install is read at once and says which.
  bump(key);
  void readInstall(key);
}

function sameSource(left: CapabilitySkillSource | undefined, right: CapabilitySkillSource): boolean {
  if (!left || left.kind !== right.kind) return false;
  return left.kind === "pack"
    ? left.packId === (right as typeof left).packId
    : left.sourceRef === (right as typeof left).sourceRef;
}

/** The source to check again for an install: a pack by its id, a Git source by its address. */
export function checkSourceOf(install: CapabilitySkillInstall): CapabilitySkillSource {
  return install.source.kind === "pack"
    ? { kind: "pack", packId: install.source.packId }
    : { kind: "git", sourceRef: install.source.sourceRef };
}

/**
 * Checks a source for the panel `key`. A new check gets a new key; only a check whose answer never came (no refusal)
 * is sent again with the same one, so the Gateway hands back that check rather than making a second.
 */
export function startSkillInstallCheck(key: string, source: CapabilitySkillSource, context: SkillInstallContext) {
  const before = readSkillInstall(key);
  if (before?.state.phase === "checking") return;
  const retry =
    before?.state.phase === "check_failed" &&
    before.state.code === undefined &&
    before.idempotencyKey !== undefined &&
    sameSource(before.source, source);
  const idempotencyKey = retry && before.idempotencyKey ? before.idempotencyKey : crypto.randomUUID();
  contexts.set(key, context);
  bump(key);
  cancelSkillInstallTick(key);
  setSkillInstall(key, { state: { phase: "checking" }, source, idempotencyKey });
  void runCheck(key, source, idempotencyKey, context, before);
}

async function runCheck(
  key: string,
  source: CapabilitySkillSource,
  idempotencyKey: string,
  context: SkillInstallContext,
  before: SkillInstallEntry | undefined,
) {
  const stillChecking = () => {
    const entry = readSkillInstall(key);
    return entry?.state.phase === "checking" && entry.idempotencyKey === idempotencyKey;
  };
  let install: CapabilitySkillInstall;
  try {
    install = await reviewCapabilitySkill({ workspaceId: context.workspaceId, source, idempotencyKey });
  } catch (error) {
    if (!stillChecking()) return;
    const refusal = isApiRequestError(error) && error.status === 422 ? error.body : undefined;
    const code = (refusal as { details?: { reason?: unknown } } | undefined)?.details?.reason;
    const reason = typeof code === "string" ? code : undefined;
    return setSkillInstall(key, {
      source,
      idempotencyKey,
      state: {
        phase: "check_failed",
        message: describeCheckFailure(reason, describeApiError(error).summary),
        ...(refusal ? { code: reason ?? "SOURCE_REFUSED" } : {}),
      },
    });
  }
  if (!stillChecking()) return;
  const checkId = install.snapshotId;
  if (checkId === key) return adoptSkillInstall(key, install, context, { source, idempotencyKey }, true);
  adoptSkillInstall(checkId, install, context, { source }, true);
  // A panel that showed an earlier check keeps that check's state; one that waited for this check shows it.
  const previous = before && installOf(before.state)?.snapshotId === key ? before.state : stateFor(install);
  setSkillInstall(key, { state: previous, source, idempotencyKey, movedTo: checkId });
}

/**
 * Takes on a check's install as the Gateway reads it, when nothing here follows it yet (after a reload, say). With
 * `replace`, a newer read replaces what the panel held.
 */
export function adoptSkillInstall(
  key: string,
  install: CapabilitySkillInstall,
  context: SkillInstallContext,
  extra: Partial<SkillInstallEntry> = {},
  replace = false,
) {
  if (readSkillInstall(key) && !replace) return;
  contexts.set(key, context);
  bump(key);
  setSkillInstall(key, { ...extra, state: stateFor(install) });
  schedule(key, install.step);
}

/** Forgets a panel's flow, so the panel starts again. A check's own install is never forgotten this way. */
export function resetSkillInstall(key: string) {
  bump(key);
  setSkillInstall(key, undefined);
}

/** The check a panel should move to, once: the next call answers nothing. */
export function takeSkillInstallMove(key: string): string | undefined {
  const entry = readSkillInstall(key);
  if (!entry?.movedTo) return undefined;
  setSkillInstall(key, { ...entry, movedTo: undefined });
  return entry.movedTo;
}

export interface SkillInstall {
  state: SkillInstallState;
  /** The step this panel asked for last; set while it is asked and after it stopped. */
  asked?: SkillInstallStepKind;
  /** A step's request is on its way, or its answer isn't read back yet. */
  asking: boolean;
  /** The confirmation goes on to switch the skill on once it is installed. */
  chain: boolean;
  /** A decline, or why the last request didn't go through. */
  notice?: string;
  /** The notice is a decline rather than a request that didn't go through. */
  declined: boolean;
  /** The install couldn't be read several times in a row; the reads go on. */
  unreadable: boolean;
  /** The source the panel checks again. */
  source?: CapabilitySkillSource;
  /** The check this panel should move to, once it has made a new one. */
  movedTo?: string;
  /** The workspace the check was made in, where its approvals are read; the active one before any check. */
  workspaceId: string;
  check(source: CapabilitySkillSource): void;
  /**
   * The panel's one confirmation. At a passed check it asks to install, then to switch on once installed; at an
   * install that is installed but not switched on, it asks to switch on.
   */
  confirm(): void;
  /** Reads the install now, for a decision made in the panel's approval. */
  checkNow(): void;
}

const IDLE: SkillInstallState = { phase: "idle" };

/**
 * One install panel's flow: checking a source, then installing it and switching it on from one confirmation. `seed` is
 * the install as the Gateway read it, taken on when nothing here follows the check yet (after a reload). Every view of
 * the same key reads the same entry, which outlasts each.
 */
export function useSkillInstall(key: string, seed?: CapabilitySkillInstall | null): SkillInstall {
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const entry = useSkillInstallEntry(key);

  useEffect(() => {
    if (seed && seed.snapshotId === key) adoptSkillInstall(key, seed, { client, workspaceId });
  }, [key, seed, client, workspaceId]);

  const state = entry?.state ?? IDLE;
  const install = installOf(state);
  return {
    state,
    asked: entry?.asked,
    asking: entry?.asking === true,
    chain: entry?.chain === true,
    notice: entry?.notice,
    declined: entry?.notice !== undefined && DECLINES.has(entry.notice),
    unreadable: entry?.unreadable === true,
    source: entry?.source ?? (install ? checkSourceOf(install) : undefined),
    movedTo: entry?.movedTo,
    workspaceId: contexts.get(key)?.workspaceId ?? workspaceId,
    check: (source) => startSkillInstallCheck(key, source, contexts.get(key) ?? { client, workspaceId }),
    confirm: () => {
      const current = readSkillInstall(key);
      const shown = installOf(current?.state);
      if (!current || !shown || shown.snapshotId !== key) return;
      if (current.state.phase === "ready" && shown.step === "check_passed") void request(key, "install_inactive", true);
      else if (current.state.phase === "following" && shown.step === "installed_off" && !current.asking)
        void request(key, "activate", false);
    },
    checkNow: () => {
      beats.delete(key);
      void readInstall(key);
    },
  };
}

export function __resetSkillInstallsForTests() {
  contexts.clear();
  reading.clear();
  readAgain.clear();
  sending.clear();
  generations.clear();
  beats.clear();
  misses.clear();
  __resetSkillInstallStoreForTests();
}
