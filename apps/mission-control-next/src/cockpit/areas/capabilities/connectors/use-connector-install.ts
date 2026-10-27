import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CapabilityConnectorItem,
  ChangePlanRecord,
  ChangePlanRequiredAction,
  ChangePlanStatus,
  ConnectorInstallResponse,
} from "@goatcitadel/contracts";
import { installCapabilityConnector } from "@goatcitadel/mission-control-shared/api/capability-connectors";
import { cancelChangePlan, fetchChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../../data/query-keys";
import { connectServer, startSignIn, submitSignInCode, switchOn } from "./connector-install-server-steps";
import {
  __resetConnectorInstallFlowsForTests,
  beginRun,
  createInstallFlow,
  failInstallFlow as fail,
  findInstallFlow,
  forgetInstallFlow,
  IDLE,
  indexInstallFlow,
  isCurrent,
  patchRun,
  readInstallFlow,
  readRun,
  refreshConnector,
  retireRun,
  runName,
  serverKey,
  settleInstallFlow as settle,
  technicalText,
  templateKey,
  updateInstallFlow,
  useInstallFlow,
  WORKING,
  type ConnectorInstallState,
  type RunStart,
} from "./connector-install-store";

export type { ConnectorInstallState, ConnectorInstallStep } from "./connector-install-store";

/** Install plans are made in the installation's own workspace, whichever workspace the page shows. */
const PLAN_CONTEXT = { workspaceId: "default" } as const;
const INBOX_POLL_MS = 5_000;
const APPLY_POLL_MS = 1_000;
/** Quick reads while a plan applies (as approvePlanInPlace does); after these it is read at the Inbox pace. */
const APPLY_POLL_ROUNDS = 12;
const SERVER_REF = "mcp_server:";

const DONE: ReadonlySet<ChangePlanStatus> = new Set(["completed", "applied", "monitoring"]);
const ENDED: ReadonlySet<ChangePlanStatus> = new Set([
  "failed",
  "cancelled",
  "rolled_back",
  "rollback_failed",
  "manual_required",
]);

/** The install route's 409 refusals, by the field it names (R69). */
const REFUSED = new Map([
  ["needsApiKey", "This app needs an API key. Set it up in Settings."],
  ["needsSignInSetup", "Sign-in isn't set up for this app yet."],
  ["alreadyInstalled", "This app is already saved. Reload to see it."],
  ["templateId", "This app can't be installed from here."],
]);
const DECLINED = "You declined this install in Inbox. Nothing was changed.";
const EXPIRED = "This request expired after 15 minutes. Start again.";
const WITHDRAWN = "This install was cancelled. Nothing was changed.";
const UNFINISHED = "The install didn't finish.";
const UNCHECKED = "Couldn't check the install. Reload to see where it stands.";
const NOT_FOUND = "The install finished, but the new app wasn't found. Reload to see it.";
const INSTALL_STOPPED = "Install stopped. Nothing was changed.";
const NOT_STOPPED = "Couldn't stop the install. Reload to see where it stands.";

type RunContext = Pick<RunStart, "client" | "listKey">;

const isActive = (state: ConnectorInstallState) =>
  state.phase === "working" || state.phase === "waiting_inbox" || state.phase === "signing_in";
const approvalIdOf = (action: ChangePlanRequiredAction | undefined) =>
  action?.kind === "approval" ? action.approvalId : undefined;
const changedSoFar = (id: number) => [...(readRun(id)?.changed ?? [])];

function refusalWords(error: unknown): string | undefined {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object")
    return undefined;
  const field = (error.body as { details?: { field?: unknown } }).details?.field;
  return typeof field === "string" ? REFUSED.get(field) : undefined;
}

async function install(id: number, token: number, templateId: string, enableChatConnectors: boolean) {
  let response: ConnectorInstallResponse;
  try {
    response = await installCapabilityConnector({ templateId, enableChatConnectors });
  } catch (error) {
    if (!isCurrent(id, token)) return;
    const words = refusalWords(error) ?? `Couldn't start the install. ${describeApiError(error).summary}`;
    fail(id, "plan", words, technicalText(error));
    return;
  }
  if (!isCurrent(id, token)) return;
  const receipt = response?.changePlanReceipt;
  if (!receipt?.planId) return fail(id, "plan", UNCHECKED);
  updateInstallFlow(id, { planId: receipt.planId });
  const approvalId = approvalIdOf(receipt.requiredAction);
  if (receipt.status === "awaiting_approval" && approvalId) return waitInInbox(id, receipt.planId, approvalId);
  await readPlan(id);
}

function isThisInstall(plan: ChangePlanRecord, planId: string | undefined, templateId: string | undefined) {
  return (
    plan?.planId === planId &&
    plan.kind === "connector_install" &&
    plan.request?.kind === "connector_install" &&
    plan.request.templateId === templateId &&
    plan.origin?.surface === "capabilities" &&
    plan.origin.workspaceId === PLAN_CONTEXT.workspaceId
  );
}

function waitInInbox(id: number, planId: string, approvalId: string) {
  const { state } = readInstallFlow(id) ?? {};
  const waiting = state?.phase === "waiting_inbox" && state.planId === planId && state.approvalId === approvalId;
  updateInstallFlow(id, {
    ...(waiting ? {} : { state: { phase: "waiting_inbox", approvalId, planId } }),
    pollMs: INBOX_POLL_MS,
  });
}

/** Reads the install's plan once and moves the flow on. The hook's effect calls it while the flow polls. */
async function readPlan(id: number) {
  const flow = readInstallFlow(id);
  const run = readRun(id);
  if (!flow?.planId || !run || run.reading) return;
  const { token } = run;
  patchRun(id, { reading: true });
  let plan: ChangePlanRecord;
  try {
    plan = await fetchChangePlan(flow.planId, PLAN_CONTEXT);
  } catch (error) {
    if (isCurrent(id, token)) missedRead(id, error);
    return;
  } finally {
    if (isCurrent(id, token)) patchRun(id, { reading: false });
  }
  if (!isCurrent(id, token)) return;
  patchRun(id, { misses: 0 });
  if (!isThisInstall(plan, flow.planId, run.templateId))
    return fail(id, "plan", UNCHECKED, "The plan read is not this install.");
  if (DONE.has(plan.status)) return afterPlan(id, token, plan);
  if (ENDED.has(plan.status)) return planEnded(id, plan);
  const approvalId = approvalIdOf(plan.requiredAction);
  if (plan.status === "awaiting_approval" && approvalId) return waitInInbox(id, plan.planId, approvalId);
  // Still applying (or between steps): read it again, quickly at first.
  const rounds = run.rounds + 1;
  patchRun(id, { rounds });
  updateInstallFlow(id, { state: WORKING.plan, pollMs: rounds > APPLY_POLL_ROUNDS ? INBOX_POLL_MS : APPLY_POLL_MS });
}

/** A read that failed. While it waits in Inbox the next read tries again; while it applies the tries are bounded. */
function missedRead(id: number, error: unknown) {
  if (readInstallFlow(id)?.state.phase === "waiting_inbox") return;
  const misses = (readRun(id)?.misses ?? 0) + 1;
  if (misses > APPLY_POLL_ROUNDS) return fail(id, "plan", UNCHECKED, technicalText(error));
  patchRun(id, { misses });
  updateInstallFlow(id, { pollMs: APPLY_POLL_MS });
}

/** Why the plan ended, in plain words. The control plane's own text for a denial or expiry is never shown. */
function planEnded(id: number, plan: ChangePlanRecord) {
  const code = plan.result?.failureCode;
  const summary = plan.result?.summary?.trim();
  const detail = plan.result?.failureDetail;
  if (code === "approval_denied") return fail(id, "approval", DECLINED);
  if (code === "approval_expired" || code === "expired") return fail(id, "approval", EXPIRED);
  if (plan.status === "cancelled") return fail(id, "approval", WITHDRAWN);
  // The install's own refusal is one plain sentence about why nothing changed.
  if (code === "connector_install_refused") return fail(id, "plan", summary || UNFINISHED, detail);
  // The install's own sentences say what happened and what to do next (R66, R79); don't parse them.
  if (code?.startsWith("connector_install_")) {
    patchRun(id, { changed: summary ? [summary] : [] });
    return fail(id, "plan", UNFINISHED, detail);
  }
  fail(id, "plan", UNFINISHED, [summary, detail].filter(Boolean).join(" ") || undefined);
}

/** Takes on the server the finished plan saved: what changed, its id, and the rows that show it. */
function adoptServer(id: number, plan: ChangePlanRecord): string | undefined {
  const summary = plan.result?.summary?.trim();
  patchRun(id, { changed: summary ? [summary] : [] });
  const serverId = plan.evidenceRefs?.find((ref) => ref.startsWith(SERVER_REF))?.slice(SERVER_REF.length);
  updateInstallFlow(id, { state: WORKING.plan, pollMs: undefined, ...(serverId ? { serverId } : {}) });
  if (serverId) indexInstallFlow(id, serverKey(serverId));
  refreshConnector(readRun(id), undefined);
  return serverId;
}

async function afterPlan(id: number, token: number, plan: ChangePlanRecord) {
  const serverId = adoptServer(id, plan);
  if (!serverId) return fail(id, "plan", NOT_FOUND);
  await (readRun(id)?.oauth ? startSignIn(id, token, serverId) : switchOn(id, token, serverId));
}

/** Withdraws a plan that waits in Inbox. One approved meanwhile has already run, and is reported as it stands. */
async function withdraw(id: number, planId: string) {
  const token = retireRun(id);
  updateInstallFlow(id, { state: WORKING.approval, pollMs: undefined });
  try {
    const plan = await fetchChangePlan(planId, PLAN_CONTEXT);
    if (!isCurrent(id, token)) return;
    if (!isThisInstall(plan, planId, readRun(id)?.templateId)) return fail(id, "approval", NOT_STOPPED);
    if (ENDED.has(plan.status)) return planEnded(id, plan);
    if (DONE.has(plan.status)) {
      adoptServer(id, plan);
      return settle(id, { phase: "stopped", message: stoppedWords(id), changed: changedSoFar(id) });
    }
    const action = plan.requiredAction;
    if (plan.status !== "awaiting_approval" || !action) return fail(id, "approval", NOT_STOPPED);
    await cancelChangePlan(planId, PLAN_CONTEXT, { expectedRevision: plan.revision, actionNonce: action.actionNonce });
    if (isCurrent(id, token)) settle(id, { phase: "stopped", message: INSTALL_STOPPED, changed: [] });
  } catch (error) {
    if (isCurrent(id, token)) fail(id, "approval", NOT_STOPPED, technicalText(error));
  }
}

function stoppedWords(id: number) {
  const name = runName(id);
  return readRun(id)?.enabled
    ? `Stopped. ${name} is switched on but may not be connected. Reload to check.`
    : `Stopped. ${name} is saved but switched off.`;
}

/**
 * Waiting in Inbox, the plan is withdrawn. Once the server is saved the flow just stops: no step runs after this, and
 * a sign-in return is no longer taken. A plan that is applying can't be stopped. A finished flow goes back to idle.
 */
function cancelFlow(id: number) {
  const state = readInstallFlow(id)?.state;
  if (!state) return;
  if (state.phase === "waiting_inbox") return void withdraw(id, state.planId);
  if (state.phase === "working" && (state.step === "plan" || state.step === "approval")) return;
  if (state.phase === "working" || state.phase === "signing_in") {
    return settle(id, { phase: "stopped", message: stoppedWords(id), changed: changedSoFar(id) });
  }
  forgetInstallFlow(id);
}

function startInstall(item: CapabilityConnectorItem, enableChatConnectors: boolean, context: RunContext) {
  const { templateId } = item;
  if (!templateId || item.source !== "mcp_template") return;
  const existing = findInstallFlow(item);
  if (existing && isActive(existing.state)) return;
  if (existing) forgetInstallFlow(existing.id);
  const flow = createInstallFlow([templateKey(templateId)]);
  const token = beginRun(flow.id, { ...context, name: item.name, templateId, oauth: item.auth === "oauth" });
  updateInstallFlow(flow.id, { state: WORKING.plan });
  void install(flow.id, token, templateId, enableChatConnectors);
}

function resumeServer(item: CapabilityConnectorItem, from: "sign_in" | "connect", context: RunContext) {
  const { serverId } = item;
  if (!serverId) return;
  const existing = findInstallFlow(item);
  if (existing && isActive(existing.state)) return;
  if (existing) forgetInstallFlow(existing.id);
  const flow = createInstallFlow([serverKey(serverId)]);
  const token = beginRun(flow.id, { ...context, name: item.name, oauth: true });
  updateInstallFlow(flow.id, { serverId, state: WORKING[from] });
  void (from === "connect" ? connectServer(flow.id, token, serverId) : startSignIn(flow.id, token, serverId));
}

export interface ConnectorInstall {
  state: ConnectorInstallState;
  /** The saved server once the install created it (or the item's own server), for the panel to re-point ?item= (R74). */
  serverId: string | undefined;
  start(options: { enableChatConnectors: boolean }): void;
  /** For a saved server: "sign_in" runs sign-in, then switch on and connect; "connect" runs connect only. */
  resume(from: "sign_in" | "connect"): void;
  submitManualCode(code: string, state: string): void;
  cancel(): void;
}

/**
 * One-button install for a connector row, driven end to end: the install plan (waiting in Inbox when it asks), sign-in
 * for OAuth apps, switch on, connect. A saved server's row resumes at sign-in or connect. The flow lives outside the
 * component (R68): a template row and the saved server's row that replaces it find the same flow, and plan reads run
 * while a hook showing the flow is mounted.
 */
export function useConnectorInstall(item: CapabilityConnectorItem): ConnectorInstall {
  const client = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const flow = useInstallFlow(item);
  const id = flow?.id;
  const pollMs = flow?.pollMs;
  useEffect(() => {
    if (id === undefined || !pollMs) return undefined;
    const timer = globalThis.setInterval(() => void readPlan(id), pollMs);
    return () => globalThis.clearInterval(timer);
  }, [id, pollMs]);
  const context: RunContext = { client, listKey: queryKeys.capabilityConnectors(activeWorkspaceId) };
  return {
    state: flow?.state ?? IDLE,
    serverId: flow?.serverId ?? item.serverId,
    start: (options) => startInstall(item, options.enableChatConnectors, context),
    resume: (from) => resumeServer(item, from, context),
    submitManualCode: (code, state) => {
      if (id !== undefined && code.trim()) submitSignInCode(id, code.trim(), state.trim());
    },
    cancel: () => {
      if (id !== undefined) cancelFlow(id);
    },
  };
}

export function __resetConnectorInstallForTests() {
  __resetConnectorInstallFlowsForTests();
}
