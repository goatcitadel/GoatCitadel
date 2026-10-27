import { useSyncExternalStore } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { CapabilityConnectorItem, McpServerRecord } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { queryKeys } from "../../../data/query-keys";

export type ConnectorInstallStep = "plan" | "approval" | "sign_in" | "finish_sign_in" | "switch_on" | "connect";

/**
 * Where one install (or a saved server's sign-in or connect) stands. Every message is plain words; `detail` is error
 * text for TechnicalDetails only.
 */
export type ConnectorInstallState =
  | { phase: "idle" }
  | { phase: "working"; step: ConnectorInstallStep }
  | { phase: "waiting_inbox"; approvalId: string; planId: string }
  | {
      phase: "signing_in";
      authorizeUrl: string;
      signInHost: string;
      scopes: string;
      /** Set when a pasted code's state doesn't match this sign-in (R82); gone once the phase moves on. */
      manualError?: string;
    }
  | { phase: "done"; serverId: string }
  | { phase: "failed"; step: ConnectorInstallStep; message: string; changed: string[]; detail?: string }
  | { phase: "stopped"; message: string; changed: string[] };

export const IDLE: ConnectorInstallState = { phase: "idle" };
/** One object per step, so a step that is set again does not change the record. */
export const WORKING: Readonly<Record<ConnectorInstallStep, ConnectorInstallState>> = {
  plan: { phase: "working", step: "plan" },
  approval: { phase: "working", step: "approval" },
  sign_in: { phase: "working", step: "sign_in" },
  finish_sign_in: { phase: "working", step: "finish_sign_in" },
  switch_on: { phase: "working", step: "switch_on" },
  connect: { phase: "working", step: "connect" },
};

/** One flow as readers see it. A record is replaced on every change, never edited, so each change re-renders. */
export interface ConnectorInstallFlow {
  readonly id: number;
  readonly state: ConnectorInstallState;
  /** The saved server, once the install made it, or the server a resume runs for. */
  readonly serverId?: string;
  /** The install's plan while the flow follows it. */
  readonly planId?: string;
  /** Set while the plan should be read again: how often, in milliseconds. Mounted hooks run the reads. */
  readonly pollMs?: number;
}

// Flows live for this app session, outside any component, so a panel that unmounts or a list that refreshes (the
// template row becoming a saved-server row) never loses one (R68). Nothing here is stored in the browser. Each flow has
// a record that rows read and a run (below) that its steps keep.
const flows = new Map<number, ConnectorInstallFlow>();
// "template:<templateId>" and "server:<serverId>" both lead to a flow, so either row finds it.
const index = new Map<string, number>();
const listeners = new Set<() => void>();
let nextId = 1;

export const templateKey = (templateId: string) => `template:${templateId}`;
export const serverKey = (serverId: string) => `server:${serverId}`;

function publish() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readInstallFlow(id: number): ConnectorInstallFlow | undefined {
  return flows.get(id);
}

/** A new idle flow, found from each key. */
export function createInstallFlow(keys: readonly string[]): ConnectorInstallFlow {
  const flow: ConnectorInstallFlow = { id: nextId, state: { phase: "idle" } };
  nextId += 1;
  flows.set(flow.id, flow);
  for (const key of keys) index.set(key, flow.id);
  publish();
  return flow;
}

/** Replaces a flow's record with `change` applied. A key set to `undefined` is dropped; no change keeps the record. */
export function updateInstallFlow(
  id: number,
  change: Partial<Omit<ConnectorInstallFlow, "id">>,
): ConnectorInstallFlow | undefined {
  const current = flows.get(id);
  if (!current) return undefined;
  if (Object.entries(change).every(([key, value]) => current[key as keyof ConnectorInstallFlow] === value)) {
    return current;
  }
  const next = Object.fromEntries(
    Object.entries({ ...current, ...change }).filter(([, value]) => value !== undefined),
  ) as unknown as ConnectorInstallFlow;
  flows.set(id, next);
  publish();
  return next;
}

export function indexInstallFlow(id: number, key: string) {
  index.set(key, id);
  publish();
}

/** Forgets a flow: its rows read idle again. */
export function deleteInstallFlow(id: number) {
  flows.delete(id);
  for (const [key, value] of [...index]) if (value === id) index.delete(key);
  publish();
}

export const isActiveInstallState = (state: ConnectorInstallState) =>
  state.phase === "working" || state.phase === "waiting_inbox" || state.phase === "signing_in";

/**
 * The flow a row shows. A template row looks it up by its template, and keeps an install it started until the flow is
 * forgotten (dismissed, or started again), so the panel can stay on it until the list shows the saved server (R80).
 * A saved server's row looks it up by its server first. It takes its template's flow only while that flow is still
 * running and has no other server, or once it carries this row's server: a finished template flow that saved nothing
 * (an "already saved" refusal) is not this row's, and doesn't take its Reconnect.
 */
export function findInstallFlow(
  item: Pick<CapabilityConnectorItem, "source" | "templateId" | "serverId">,
): ConnectorInstallFlow | undefined {
  const byServer = item.serverId ? index.get(serverKey(item.serverId)) : undefined;
  if (byServer !== undefined) return flows.get(byServer);
  const templateFlow = item.templateId ? index.get(templateKey(item.templateId)) : undefined;
  const byTemplate = templateFlow === undefined ? undefined : flows.get(templateFlow);
  if (!byTemplate || item.source === "mcp_template") return byTemplate;
  if (byTemplate.serverId !== undefined) return byTemplate.serverId === item.serverId ? byTemplate : undefined;
  return isActiveInstallState(byTemplate.state) ? byTemplate : undefined;
}

export function useInstallFlow(
  item: Pick<CapabilityConnectorItem, "source" | "templateId" | "serverId">,
): ConnectorInstallFlow | undefined {
  const { source, templateId, serverId } = item;
  return useSyncExternalStore(
    subscribe,
    () => findInstallFlow({ source, templateId, serverId }),
    () => undefined,
  );
}

/** What a running flow keeps beside its record: never shown, never stored in the browser. */
export interface FlowRun {
  /** Changed by every start, stop and settle; a step whose token is no longer current changes nothing. */
  readonly token: number;
  readonly name: string;
  readonly templateId?: string;
  /** Sign in after the install (the template uses OAuth). */
  readonly oauth: boolean;
  /** Plain sentences for what already happened (R66). */
  readonly changed: readonly string[];
  /** Whether the server is known to be switched on, for the words a stop uses. */
  readonly enabled: boolean;
  readonly client: QueryClient;
  readonly listKey: QueryKey;
  /** Plan reads while it applies, and plan reads in a row that failed. */
  readonly rounds: number;
  readonly misses: number;
  readonly reading: boolean;
  /** The sign-in this flow waits for: only a return with this state is taken. */
  readonly signIn?: { readonly state: string; readonly server: McpServerRecord; readonly stop: () => void };
}
export type RunStart = Pick<FlowRun, "name" | "templateId" | "oauth" | "client" | "listKey">;

const runs = new Map<number, FlowRun>();
let tokens = 0;

export const readRun = (id: number) => runs.get(id);
export const isCurrent = (id: number, token: number) => runs.get(id)?.token === token;
export const runName = (id: number) => runs.get(id)?.name ?? "This app";

export function patchRun(id: number, change: Partial<FlowRun>) {
  const run = runs.get(id);
  if (run) runs.set(id, { ...run, ...change });
}

export function addChanged(id: number, sentence: string) {
  patchRun(id, { changed: [...(runs.get(id)?.changed ?? []), sentence] });
}

/** Starts a run for the flow and returns its token. */
export function beginRun(id: number, start: RunStart): number {
  tokens += 1;
  runs.set(id, { ...start, token: tokens, changed: [], enabled: false, rounds: 0, misses: 0, reading: false });
  return tokens;
}

/** Ends whatever the flow was doing: its sign-in wait and every step still in flight. Returns the new token. */
export function retireRun(id: number): number {
  const run = runs.get(id);
  run?.signIn?.stop();
  tokens += 1;
  if (run) runs.set(id, { ...run, token: tokens, signIn: undefined, reading: false });
  return tokens;
}

/** Forgets a flow and its run: its rows read idle again. */
export function forgetInstallFlow(id: number) {
  retireRun(id);
  runs.delete(id);
  deleteInstallFlow(id);
}

/** Reads the list again, and the saved server's own reads once there is one. */
export function refreshConnector(run: FlowRun | undefined, serverId: string | undefined) {
  if (!run) return;
  void run.client.invalidateQueries({ queryKey: run.listKey });
  if (!serverId) return;
  void run.client.invalidateQueries({ queryKey: queryKeys.capabilityConnectorServer(serverId) });
  void run.client.invalidateQueries({ queryKey: queryKeys.capabilityConnectorTools(serverId) });
  void run.client.invalidateQueries({ queryKey: ["settings", "mcp-servers"] });
}

/**
 * Ends the flow in `state`. It keeps every key, so both the template row and the saved server's row still show the
 * result until the flow is forgotten.
 */
export function settleInstallFlow(id: number, state: ConnectorInstallState) {
  const run = runs.get(id);
  retireRun(id);
  const flow = updateInstallFlow(id, { state, pollMs: undefined });
  refreshConnector(run, flow?.serverId);
}

/** Ends the flow as failed at `step`, with what already changed. `detail` is for TechnicalDetails only. */
export function failInstallFlow(id: number, step: ConnectorInstallStep, message: string, detail?: string) {
  const changed = [...(runs.get(id)?.changed ?? [])];
  settleInstallFlow(id, { phase: "failed", step, message, changed, ...(detail ? { detail } : {}) });
}

/** An error's text for `detail`. */
export function technicalText(error: unknown) {
  const described = describeApiError(error);
  return described.technical ?? described.summary;
}

export function __resetConnectorInstallFlowsForTests() {
  for (const run of runs.values()) run.signIn?.stop();
  runs.clear();
  flows.clear();
  index.clear();
  nextId = 1;
  publish();
}
