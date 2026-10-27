import type { McpServerRecord } from "@goatcitadel/contracts";
import { fetchMcpServer } from "@goatcitadel/mission-control-shared/api/mcp-operations";
import { commitMcpConnection } from "../../../../features/native-routes/settings/mcp-connection-mutation";
import {
  describeAuthorizeHost,
  describeRequestedScopes,
} from "../../../../features/native-routes/settings/mcp-oauth-binding";
import { readMcpOAuthFlow } from "../../../../features/native-routes/settings/mcp-oauth-flow-state";
import { commitMcpOAuth } from "../../../../features/native-routes/settings/mcp-oauth-mutation";
import {
  subscribeMcpOAuthReturn,
  type McpOAuthReturn,
} from "../../../../features/native-routes/settings/mcp-oauth-return";
import { commitMcpServerUpdate } from "../../../../features/native-routes/settings/mcp-server-mutation";
import {
  addChanged,
  failInstallFlow,
  isCurrent,
  patchRun,
  readRun,
  runName,
  settleInstallFlow,
  technicalText,
  updateInstallFlow,
  WORKING,
} from "./connector-install-store";
import { CONNECTOR_CONFLICT_MESSAGE } from "./use-connector-enabled";

// The steps that run on a saved server: sign in, switch on, connect. Each goes through the Settings wrapper for that
// write (R67), which checks the reviewed record, reads the saved result back and holds the server's shared lock.

type ServerStep = "sign_in" | "finish_sign_in" | "switch_on" | "connect";

const NOT_GRANTED = "The app didn't grant access.";
const STEP_FAILED: Readonly<Record<ServerStep, (name: string) => string>> = {
  sign_in: (name) => `Couldn't start signing in to ${name}.`,
  finish_sign_in: (name) => `Couldn't finish signing in to ${name}.`,
  switch_on: (name) => `Couldn't switch ${name} on.`,
  connect: (name) => `Couldn't connect ${name}.`,
};
/** What to do after a Settings wrapper refused a step; its own message goes to `detail`. */
const WHAT_NEXT: Readonly<Record<"cancelled" | "conflict" | "unavailable" | "locked" | "uncertain", string>> = {
  cancelled: "Reload and try again.",
  conflict: CONNECTOR_CONFLICT_MESSAGE,
  unavailable: "Try again in a moment.",
  locked: "Another change to it is still running. Try again in a moment.",
  uncertain: "It may have gone through. Reload to check.",
};

const ignore = () => undefined;

function failStep(id: number, step: ServerStep, result: { status: keyof typeof WHAT_NEXT; message: string }) {
  failInstallFlow(id, step, `${STEP_FAILED[step](runName(id))} ${WHAT_NEXT[result.status]}`, result.message);
}

async function readServer(id: number, token: number, serverId: string, step: ServerStep) {
  try {
    const record = await fetchMcpServer(serverId);
    if (!isCurrent(id, token)) return undefined;
    patchRun(id, { enabled: record.enabled });
    return record;
  } catch (error) {
    if (isCurrent(id, token)) {
      failInstallFlow(id, step, `${STEP_FAILED[step](runName(id))} Try again in a moment.`, technicalText(error));
    }
    return undefined;
  }
}

/** Starts the reviewed sign-in and waits for the provider's return, which Settings hands on to this tab. */
export async function startSignIn(id: number, token: number, serverId: string) {
  updateInstallFlow(id, { state: WORKING.sign_in });
  const record = await readServer(id, token, serverId, "sign_in");
  if (!record) return;
  const result = await commitMcpOAuth({
    reviewed: record,
    action: "start",
    isCurrent: () => isCurrent(id, token),
    onDispatch: ignore,
  });
  if (!isCurrent(id, token)) return;
  if (result.status !== "saved") return failStep(id, "sign_in", result);
  const pending = readMcpOAuthFlow(serverId);
  if (!pending) return failInstallFlow(id, "sign_in", `${STEP_FAILED.sign_in(runName(id))} Try again.`);
  const stop = subscribeMcpOAuthReturn((returned) => receiveSignIn(id, returned));
  patchRun(id, { signIn: { state: pending.state, server: result.server, stop }, enabled: result.server.enabled });
  updateInstallFlow(id, {
    state: {
      phase: "signing_in",
      authorizeUrl: pending.authorizeUrl,
      signInHost: describeAuthorizeHost(pending.authorizeUrl),
      scopes: describeRequestedScopes(pending.authorizeUrl),
    },
  });
}

/** A provider return (or a pasted code). One for another sign-in request is dropped without a word. */
export function receiveSignIn(id: number, returned: McpOAuthReturn) {
  const run = readRun(id);
  if (!run?.signIn || returned.state !== run.signIn.state) return;
  const { server } = run.signIn;
  run.signIn.stop();
  patchRun(id, { signIn: undefined });
  if (!returned.code) return failInstallFlow(id, "sign_in", NOT_GRANTED, returned.error);
  void finishSignIn(id, run.token, server, returned.code, returned.state);
}

async function finishSignIn(id: number, token: number, reviewed: McpServerRecord, code: string, state: string) {
  updateInstallFlow(id, { state: WORKING.finish_sign_in });
  const result = await commitMcpOAuth({
    reviewed,
    action: "complete",
    code,
    state,
    isCurrent: () => isCurrent(id, token),
    onDispatch: ignore,
  });
  if (!isCurrent(id, token)) return;
  if (result.status !== "saved") return failStep(id, "finish_sign_in", result);
  addChanged(id, "Signed in.");
  await switchOn(id, token, reviewed.serverId);
}

/** Sign-in must come first: an OAuth server can't be switched on until it is signed in. */
export async function switchOn(id: number, token: number, serverId: string) {
  updateInstallFlow(id, { state: WORKING.switch_on });
  const record = await readServer(id, token, serverId, "switch_on");
  if (!record) return;
  if (!record.enabled) {
    const result = await commitMcpServerUpdate({
      reviewed: record,
      input: { expectedRevision: record.revision ?? "", enabled: true },
      isCurrent: () => isCurrent(id, token),
    });
    if (!isCurrent(id, token)) return;
    if (result.status !== "saved") return failStep(id, "switch_on", result);
    addChanged(id, "Switched on.");
    patchRun(id, { enabled: true });
  }
  await connectServer(id, token, serverId);
}

/** Switching on disconnects the server and moves its versions (R55), so the record is read again first. */
export async function connectServer(id: number, token: number, serverId: string) {
  updateInstallFlow(id, { state: WORKING.connect });
  const record = await readServer(id, token, serverId, "connect");
  if (!record) return;
  const result = await commitMcpConnection({
    reviewed: record,
    action: "connect",
    isCurrent: () => isCurrent(id, token),
  });
  if (!isCurrent(id, token)) return;
  if (result.status !== "saved") return failStep(id, "connect", result);
  settleInstallFlow(id, { phase: "done", serverId });
}
