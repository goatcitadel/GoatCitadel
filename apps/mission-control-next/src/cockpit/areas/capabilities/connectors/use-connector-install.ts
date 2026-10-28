import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CapabilityConnectorItem,
  ChangePlanRecord,
  ChangePlanRequiredAction,
  ConnectorInstallResponse,
} from "@goatcitadel/contracts";
import { fetchApproval, resolveApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { installCapabilityConnector } from "@goatcitadel/mission-control-shared/api/capability-connectors";
import { cancelChangePlan, fetchChangePlan, fetchChangePlans } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../../data/query-keys";
import { DONE, ENDED } from "../change-plan-outcome";
import { connectServer, startSignIn, submitSignInCode, switchOn } from "./connector-install-server-steps";
import { inboxApprovalLink, MCP_SETTINGS_LINK, type ConnectorNextLink } from "./connector-links";
import {
  __resetConnectorInstallFlowsForTests,
  beginRun,
  createInstallFlow,
  failInstallFlow as fail,
  findInstallFlow,
  forgetInstallFlow,
  holdInstallPlan,
  IDLE,
  releaseInstallPlan,
  isActiveInstallState,
  indexInstallFlow,
  isCurrent,
  patchRun,
  readInstallFlow,
  readRun,
  refreshConnector,
  retireRun,
  runName,
  serverKey,
  setInstallPlanReader,
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
/** How many plans waiting in Inbox one read after a reload looks through (R88's flows are this app session's only). */
const RECOVERY_LIMIT = 100;
const SERVER_REF = "mcp_server:";

type Refusal = { readonly words: string; readonly link?: ConnectorNextLink };
/** The install route's 409 refusals, by the field it names (R69); words that send the operator somewhere link there. */
const REFUSED = new Map<string, Refusal>([
  ["needsApiKey", { words: "This app needs an API key. Set it up in Settings.", link: MCP_SETTINGS_LINK }],
  ["needsSignInSetup", { words: "Sign-in isn't set up for this app yet." }],
  ["alreadyInstalled", { words: "This app is already saved. Reload to see it." }],
  ["templateId", { words: "This app can't be installed from here." }],
]);
/** The install route's 503 when Change Plans are off (M5), which every Install on this install would hit. */
const SWITCHED_OFF: Refusal = {
  words:
    "Installing from here is switched off on this install, so nothing was changed. You can add it yourself in " +
    "Settings.",
  link: MCP_SETTINGS_LINK,
};
const DECLINED = "You declined this install in Inbox. Nothing was changed.";
const EXPIRED = "This request expired after 15 minutes. Start again.";
const WITHDRAWN = "This install was cancelled. Nothing was changed.";
const UNFINISHED = "The install didn't finish.";
const UNCHECKED = "Couldn't check the install. Reload to see where it stands.";
const NOT_FOUND = "The install finished, but the new app wasn't found. Reload to see it.";
const INSTALL_STOPPED = "Install stopped. Nothing was changed.";
const STOPPED_STILL_IN_INBOX = `${INSTALL_STOPPED} Its request is still in Inbox, where you can deny it.`;
const NOT_STOPPED = "Couldn't stop the install. Reload to see where it stands.";
const FOLLOWED_ELSEWHERE = "Another tab is following this install. It goes on there once you approve it in Inbox.";

type RunContext = Pick<RunStart, "client" | "listKey">;

const approvalIdOf = (action: ChangePlanRequiredAction | undefined) =>
  action?.kind === "approval" ? action.approvalId : undefined;
const changedSoFar = (id: number) => [...(readRun(id)?.changed ?? [])];

/** An install the route refused before it changed anything, by the field or reason its answer names. */
function refusalOf(error: unknown): Refusal | undefined {
  if (!isApiRequestError(error) || !error.body || typeof error.body !== "object") return undefined;
  const details = (error.body as { details?: { field?: unknown; reason?: unknown } }).details;
  if (error.status === 503 && details?.reason === "change_plans_off") return SWITCHED_OFF;
  return error.status === 409 && typeof details?.field === "string" ? REFUSED.get(details.field) : undefined;
}

async function install(id: number, token: number, templateId: string, enableChatConnectors: boolean) {
  let response: ConnectorInstallResponse;
  try {
    response = await installCapabilityConnector({ templateId, enableChatConnectors });
  } catch (error) {
    if (!isCurrent(id, token)) return;
    const refused = refusalOf(error);
    const words = refused?.words ?? `Couldn't start the install. ${describeApiError(error).summary}`;
    fail(id, "plan", words, technicalText(error), refused);
    return;
  }
  if (!isCurrent(id, token)) return;
  const receipt = response?.changePlanReceipt;
  if (!receipt?.planId) return fail(id, "plan", UNCHECKED);
  updateInstallFlow(id, { planId: receipt.planId });
  const approvalId = approvalIdOf(receipt.requiredAction);
  // This tab pressed Install, so it follows the plan, unless a tab that loaded while the request was in flight already
  // took it on: then only that tab goes on after approval.
  const held = await holdInstallPlan(receipt.planId);
  if (!isCurrent(id, token)) return;
  if (!held) {
    return settle(id, {
      phase: "stopped",
      message: FOLLOWED_ELSEWHERE,
      changed: [],
      ...(approvalId ? { link: inboxApprovalLink(approvalId) } : {}),
    });
  }
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

/** Reads the install's plan once and moves the flow on. The store's plan poll calls it while the flow polls (R88). */
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

setInstallPlanReader(readPlan);

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
  // The install's own sentences say what happened and what to do next (R66, R79); don't parse them. One that saved the
  // app names it (M3), so the panel hands over to the saved server instead of offering an Install it would refuse.
  if (code?.startsWith("connector_install_")) {
    patchRun(id, { changed: summary ? [summary] : [] });
    adoptServerRef(id, plan);
    return fail(id, "plan", UNFINISHED, detail);
  }
  fail(id, "plan", UNFINISHED, [summary, detail].filter(Boolean).join(" ") || undefined);
}

/** The server a plan saved, from its evidence, indexed so the saved server's row finds this flow too. */
function adoptServerRef(id: number, plan: ChangePlanRecord): string | undefined {
  const serverId = plan.evidenceRefs?.find((ref) => ref.startsWith(SERVER_REF))?.slice(SERVER_REF.length);
  if (!serverId) return undefined;
  updateInstallFlow(id, { serverId });
  indexInstallFlow(id, serverKey(serverId));
  return serverId;
}

/** Takes on the server the finished plan saved: what changed, its id, and the rows that show it. */
function adoptServer(id: number, plan: ChangePlanRecord): string | undefined {
  const summary = plan.result?.summary?.trim();
  patchRun(id, { changed: summary ? [summary] : [] });
  updateInstallFlow(id, { state: WORKING.plan, pollMs: undefined });
  const serverId = adoptServerRef(id, plan);
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
    if (!isCurrent(id, token)) return;
    const approvalId = approvalIdOf(action);
    const cleared = await denyOwnApproval(planId, approvalId);
    if (!isCurrent(id, token)) return;
    settle(
      id,
      cleared || !approvalId
        ? { phase: "stopped", message: INSTALL_STOPPED, changed: [] }
        : { phase: "stopped", message: STOPPED_STILL_IN_INBOX, changed: [], link: inboxApprovalLink(approvalId) },
    );
  } catch (error) {
    if (isCurrent(id, token)) fail(id, "approval", NOT_STOPPED, technicalText(error));
  }
}

/**
 * Denies the withdrawn plan's own Inbox approval (R93), so Inbox stops asking about it. It reads the approval first and
 * acts only on a pending one for this very plan, as `approvePlanInPlace` does. False when it couldn't be denied; the
 * withdrawal stands either way.
 */
async function denyOwnApproval(planId: string, approvalId: string | undefined): Promise<boolean> {
  if (!approvalId) return true;
  try {
    const approval = await fetchApproval(approvalId, PLAN_CONTEXT);
    if (approval.kind !== "change_plan_effect" || approval.payload?.planId !== planId) return true;
    if (approval.status !== "pending") return true;
    await resolveApproval(approvalId, "reject");
    return true;
  } catch {
    return false;
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
  if (existing && isActiveInstallState(existing.state)) return;
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
  if (existing && isActiveInstallState(existing.state)) return;
  if (existing) forgetInstallFlow(existing.id);
  const flow = createInstallFlow([serverKey(serverId)]);
  const token = beginRun(flow.id, { ...context, name: item.name, oauth: true });
  // Known from the row before the server is read, so a Stop that early says truly whether it is switched on.
  patchRun(flow.id, { enabled: item.state !== "turned_off" });
  updateInstallFlow(flow.id, { serverId, state: WORKING[from] });
  void (from === "connect" ? connectServer(flow.id, token, serverId) : startSignIn(flow.id, token, serverId));
}

/**
 * Asks for a new sign-in in place of one that is waiting (R94): the Gateway keeps a sign-in request for 10 minutes, and
 * one started in the background may be close to that by the time the operator comes back. What already changed stays.
 */
function restartSignIn(id: number) {
  const flow = readInstallFlow(id);
  if (flow?.state.phase !== "signing_in" || !flow.serverId) return;
  void startSignIn(id, retireRun(id), flow.serverId);
}

/**
 * Plans from before a reload that still wait in Inbox are read once per app session, when the list first loads: a
 * reload forgets every flow, and an Install pressed then would be refused while the old plan holds the template.
 */
let recovery: "reading" | "done" | undefined;

function recoverWaitingInstalls(items: readonly CapabilityConnectorItem[], context: RunContext) {
  if (recovery) return;
  recovery = "reading";
  fetchChangePlans(PLAN_CONTEXT, { status: "awaiting_approval", limit: RECOVERY_LIMIT }).then(
    (read) => {
      recovery = "done";
      for (const plan of read?.items ?? []) void followWaitingPlan(plan, items, context);
    },
    () => {
      // Nothing was taken on, so the next time the tab reads a changed list (or opens again) it reads the plans again.
      recovery = undefined;
    },
  );
}

/**
 * Takes on one Capabilities install that waits in Inbox for a template in the list, as the flow that made it would
 * follow it: the row reads "Waiting on you in Inbox", Stop withdraws it, and an approval goes on to sign in, switch it
 * on and connect it. A template that already has a flow in this tab keeps it, and a plan another tab follows is left
 * to that tab.
 */
async function followWaitingPlan(
  plan: ChangePlanRecord,
  items: readonly CapabilityConnectorItem[],
  context: RunContext,
) {
  const templateId = plan?.request?.kind === "connector_install" ? plan.request.templateId : undefined;
  const item = items.find((entry) => entry.source === "mcp_template" && entry.templateId === templateId);
  const approvalId = approvalIdOf(plan?.requiredAction);
  if (!item || !templateId || !approvalId || plan.status !== "awaiting_approval") return;
  if (!isThisInstall(plan, plan.planId, templateId) || findInstallFlow(item)) return;
  if (!(await holdInstallPlan(plan.planId))) return;
  // An Install pressed while the lock was asked for made its own flow, which keeps the template.
  if (findInstallFlow(item)) return releaseInstallPlan(plan.planId);
  const flow = createInstallFlow([templateKey(templateId)]);
  beginRun(flow.id, { ...context, name: item.name, templateId, oauth: item.auth === "oauth" });
  updateInstallFlow(flow.id, { planId: plan.planId });
  waitInInbox(flow.id, plan.planId, approvalId);
}

/** Called by the Connectors tab with its list: after a reload, takes back on the installs that wait in Inbox. */
export function useRecoveredInstalls(items: readonly CapabilityConnectorItem[] | undefined): void {
  const client = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  useEffect(() => {
    if (items) recoverWaitingInstalls(items, { client, listKey: queryKeys.capabilityConnectors(activeWorkspaceId) });
  }, [items, client, activeWorkspaceId]);
}

export interface ConnectorInstall {
  state: ConnectorInstallState;
  /** The saved server once the install created it (or the item's own server): the panel finds its row by it (R80). */
  serverId: string | undefined;
  start(options: { enableChatConnectors: boolean }): void;
  /** For a saved server: "sign_in" runs sign-in, then switch on and connect; "connect" runs connect only. */
  resume(from: "sign_in" | "connect"): void;
  submitManualCode(code: string, state: string): void;
  /** While signing in: asks for a new sign-in request in place of the one waiting (R94). */
  restartSignIn(): void;
  cancel(): void;
}

/**
 * One-button install for a connector row, driven end to end: the install plan (waiting in Inbox when it asks), sign-in
 * for OAuth apps, switch on, connect. A saved server's row resumes at sign-in or connect. The flow lives outside the
 * component (R68): a template row and the saved server's row that replaces it find the same flow. The store reads the
 * plan whether or not anything is mounted, and the flow goes on by itself until it signs in or is done (R88).
 */
export function useConnectorInstall(item: CapabilityConnectorItem): ConnectorInstall {
  const client = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const flow = useInstallFlow(item);
  const id = flow?.id;
  const context: RunContext = { client, listKey: queryKeys.capabilityConnectors(activeWorkspaceId) };
  return {
    state: flow?.state ?? IDLE,
    serverId: flow?.serverId ?? item.serverId,
    start: (options) => startInstall(item, options.enableChatConnectors, context),
    resume: (from) => resumeServer(item, from, context),
    submitManualCode: (code, state) => {
      if (id !== undefined && code.trim()) submitSignInCode(id, code.trim(), state.trim());
    },
    restartSignIn: () => {
      if (id !== undefined) restartSignIn(id);
    },
    cancel: () => {
      if (id !== undefined) cancelFlow(id);
    },
  };
}

/** A row's read of its install flow (R87): the state only. It reads no plan and starts or changes nothing. */
export function useConnectorInstallStatus(item: CapabilityConnectorItem): ConnectorInstallState {
  return useInstallFlow(item)?.state ?? IDLE;
}

export function __resetConnectorInstallForTests() {
  recovery = undefined;
  __resetConnectorInstallFlowsForTests();
}
