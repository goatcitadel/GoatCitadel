import { useSyncExternalStore } from "react";
import type { CapabilityPluginDetail, CapabilityPluginInspection, PluginSource } from "@goatcitadel/contracts";

/**
 * Where one install panel stands. `ready` holds an inspection (installable or not); `planned` the plugin's own plan,
 * between the confirmation and the plugin's record; `following` the plugin's detail while its skills' steps go on;
 * `done` is installed with every skill switched on. Messages are plain words.
 */
export type PluginInstallState =
  | { phase: "idle" }
  | { phase: "checking" }
  | {
      phase: "check_failed";
      message: string;
      code?: string;
      /** A refused manifest's kept inspection, which its own address reads back. */
      inspectionId?: string;
      /** The refusal's own words and where in the manifest, for Technical details only. */
      technical?: string;
    }
  | { phase: "ready"; inspection: CapabilityPluginInspection }
  | { phase: "planned"; planId: string; approvalId?: string; inspection: CapabilityPluginInspection }
  | { phase: "following"; detail: CapabilityPluginDetail; waitingApprovalId?: string }
  | { phase: "done"; pluginId: string; detail?: CapabilityPluginDetail }
  | { phase: "failed"; message: string; detail?: CapabilityPluginDetail; inspection?: CapabilityPluginInspection };

/** The two steps each of a plugin's skills goes through. */
export type PluginSkillStepKind = "install_inactive" | "activate";

/**
 * One panel's flow, kept for this app session outside any component, so closing the panel or a list that reads again
 * loses nothing. Keys: `draft:<kind>` before a check answers, the inspection's id after, and `plugin:<id>` once the
 * plugin has a record (which a reload finds again through the plugin's detail). Nothing is stored in the browser, and
 * a hook's signing secret never enters an entry: it stays in the panel until the install request answers.
 */
export interface PluginInstallEntry {
  readonly state: PluginInstallState;
  /** The source the last check read, for Check again (a folder's path as it was typed, too). */
  readonly source?: PluginSource;
  /** The last check's attempt key, sent again only to retry a check whose answer never came. */
  readonly checkKey?: string;
  /** The last install confirmation's attempt key, sent again only to retry one whose answer never came. */
  readonly installKey?: string;
  /** The last request (a check or the install) got no answer at all. */
  readonly lost?: boolean;
  /** A request is on its way, or its answer isn't read back yet. */
  readonly asking?: boolean;
  /** The confirmation goes on through each skill's two steps. */
  readonly chain?: boolean;
  /** The skill step this app session asked for last, and for which piece. */
  readonly asked?: { readonly pieceId: string; readonly kind: PluginSkillStepKind };
  /** Which step a waiting approval is for, read from the skill's own install when nothing here asked for it. */
  readonly waitingStep?: { readonly approvalId: string; readonly kind: PluginSkillStepKind };
  /** A plain line about the last request: a decline, or why it didn't go through. */
  readonly notice?: string;
  /** The notice is a decline (the operator's own choice), not a request that didn't go through. */
  readonly declined?: boolean;
  /** The flow couldn't be read several times in a row; the reads go on. */
  readonly unreadable?: boolean;
  /** The key this panel should move to, once. */
  readonly movedTo?: string;
  /** When the entry reached `done` or `failed` (`Date.now()`): only a read after that can say the Gateway moved on. */
  readonly endedAt?: number;
}

const DRAFT_PREFIX = "draft:";
const PLUGIN_PREFIX = "plugin:";

/** A panel's key before its check has answered: `draft:git`, `draft:folder` or `draft:built_in:<plugin id>`. */
export function draftPluginInstallKey(name: string): string {
  return `${DRAFT_PREFIX}${name}`;
}

export function isDraftPluginInstallKey(key: string): boolean {
  return key.startsWith(DRAFT_PREFIX);
}

/** The key of a plugin's install once it has a record: Continue and a reload find it by this. */
export function pluginInstallKey(pluginId: string): string {
  return `${PLUGIN_PREFIX}${pluginId}`;
}

/** The plugin a `plugin:<id>` key names, or undefined for a draft's or an inspection's key. */
export function pluginIdOfInstallKey(key: string): string | undefined {
  return key.startsWith(PLUGIN_PREFIX) ? key.slice(PLUGIN_PREFIX.length) || undefined : undefined;
}

/** Whether a key is an inspection's id: neither a draft's nor a plugin's. */
export function isInspectionKey(key: string): boolean {
  return !isDraftPluginInstallKey(key) && pluginIdOfInstallKey(key) === undefined;
}

const entries = new Map<string, PluginInstallEntry>();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// One timer per key while its install is followed, and the reads it started. They don't depend on a mounted panel, so
// closing the panel doesn't stall an install. What a timer runs belongs to the flow's module, which registers it.
const timers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
const controllers = new Map<string, AbortController>();
let tickOf: ((key: string) => unknown) | undefined;

/** Sets what each key's timer runs. The flow's module calls it once. */
export function setPluginInstallTicker(tick: (key: string) => unknown) {
  tickOf = tick;
}

/** Runs the key's next read after `ms`, in place of any read already scheduled. */
export function schedulePluginInstallTick(key: string, ms: number) {
  cancelPluginInstallTick(key);
  timers.set(
    key,
    globalThis.setTimeout(() => {
      timers.delete(key);
      void tickOf?.(key);
    }, ms),
  );
}

export function cancelPluginInstallTick(key: string) {
  const scheduled = timers.get(key);
  if (scheduled !== undefined) globalThis.clearTimeout(scheduled);
  timers.delete(key);
}

/** The signal for the key's reads. It aborts when the entry goes or reaches an end. */
export function pluginInstallSignal(key: string): AbortSignal {
  let controller = controllers.get(key);
  if (!controller) {
    controller = new AbortController();
    controllers.set(key, controller);
  }
  return controller.signal;
}

function stopFollowing(key: string) {
  cancelPluginInstallTick(key);
  controllers.get(key)?.abort();
  controllers.delete(key);
}

export function readPluginInstall(key: string): PluginInstallEntry | undefined {
  return entries.get(key);
}

/** Replaces the key's entry; `undefined` forgets it. An entry that reached an end stops its reads. */
export function setPluginInstall(key: string, next: PluginInstallEntry | undefined) {
  if (entries.get(key) === next) return;
  const entry = next ? stampEnd(entries.get(key), next) : undefined;
  if (entry) entries.set(key, entry);
  else entries.delete(key);
  const phase = entry?.state.phase;
  if (!entry || phase === "done" || phase === "failed" || phase === "check_failed" || entry.movedTo) {
    stopFollowing(key);
  }
  publish();
}

const isEnd = (entry: PluginInstallEntry | undefined) =>
  entry?.state.phase === "done" || entry?.state.phase === "failed";

/** Marks when an entry reached an end, once; an entry that goes on from there loses the mark. */
function stampEnd(before: PluginInstallEntry | undefined, next: PluginInstallEntry): PluginInstallEntry {
  if (!isEnd(next)) return next.endedAt === undefined ? next : { ...next, endedAt: undefined };
  if (next.endedAt !== undefined) return next;
  return { ...next, endedAt: isEnd(before) && before?.endedAt !== undefined ? before.endedAt : Date.now() };
}

export function usePluginInstallEntry(key: string | undefined): PluginInstallEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (key === undefined ? undefined : entries.get(key)),
    () => undefined,
  );
}

export function __resetPluginInstallStoreForTests() {
  for (const key of [...timers.keys(), ...controllers.keys()]) stopFollowing(key);
  entries.clear();
  publish();
}
