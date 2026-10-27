import { redactSecretText, type McpServerRecord } from "@goatcitadel/contracts";
import { fetchMcpServer } from "@goatcitadel/mission-control-shared/api/mcp-operations";
import { commitMcpConnection } from "../../../../features/native-routes/settings/mcp-connection-mutation";
import { describeRequestedScopes } from "../../../../features/native-routes/settings/mcp-oauth-binding";
import { readMcpOAuthFlow } from "../../../../features/native-routes/settings/mcp-oauth-flow-state";
import { commitMcpOAuth, type McpOAuthRefusal } from "../../../../features/native-routes/settings/mcp-oauth-mutation";
import {
  subscribeMcpOAuthReturn,
  type McpOAuthReturn,
} from "../../../../features/native-routes/settings/mcp-oauth-return";
import {
  checkMcpServerOutcome,
  readMcpServerAttempt,
} from "../../../../features/native-routes/settings/mcp-server-attempts";
import { commitMcpServerUpdate } from "../../../../features/native-routes/settings/mcp-server-mutation";
import {
  addChanged,
  failInstallFlow,
  isCurrent,
  patchRun,
  readInstallFlow,
  readRun,
  refreshConnector,
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
/** A Settings wrapper's refusal of a step; a sign-in refusal may name which one (I1). */
type WrapperRefusal = {
  status: keyof typeof WHAT_NEXT;
  message: string;
  refused?: McpOAuthRefusal;
  refusedHost?: string;
};

const NOT_GRANTED = "The app didn't grant access.";
const MANUAL_MISMATCH = "That doesn't match this sign-in. Paste the code and state from the sign-in page again.";
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
  uncertain: "Its last change couldn't be confirmed. Reload, then try again.",
};
/** Sign-in refusals the Gateway names before it changes anything (I1), in place of "Changed elsewhere." */
const SIGN_IN_REFUSED: Readonly<Record<McpOAuthRefusal, (host: string | undefined) => string>> = {
  not_allowed: (host) =>
    `Its sign-in site ${host ? `${host} ` : ""}isn't on your network allowlist. Add it in Settings, then sign in again.`,
  sign_in_site: () => "Its sign-in site couldn't be read. Try again in a moment, or set up its sign-in in Settings.",
  registration: () => "It wouldn't register GoatCitadel for sign-in. Set up its sign-in in Settings instead.",
  expired: () => "This sign-in request expired. Sign in again to get a new one.",
};
/** After a connect that failed once it was sent: what to check, by where the app runs. */
const CONNECT_NEXT = {
  device: "Check that it can run on this computer, then try again.",
  remote: "Try again in a moment, or check its setup in Settings.",
} as const;
/** After a settled sign-in step that didn't finish: a new sign-in replaces the old request. */
const SIGN_IN_AGAIN = "Sign in again.";

const ignore = () => undefined;

/**
 * The sign-in page's host without the scheme, the way "Signs in at <host>" names it (R85); a port other than the
 * default stays. The start check has already refused an address it can't read.
 */
function signInHostOf(authorizeUrl: string) {
  try {
    return new URL(authorizeUrl).host || "Unreadable sign-in address";
  } catch {
    return "Unreadable sign-in address";
  }
}

function failStep(id: number, step: ServerStep, result: WrapperRefusal) {
  const next = result.refused ? SIGN_IN_REFUSED[result.refused](result.refusedHost) : WHAT_NEXT[result.status];
  failInstallFlow(id, step, `${STEP_FAILED[step](runName(id))} ${next}`, result.message);
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

/**
 * Settles a server write the wrapper couldn't confirm (I2), from the Gateway's record of that attempt, and reads the
 * list again. True once the server is free for the next change; until then every write to it stays locked.
 */
async function settleUnconfirmed(id: number, serverId: string): Promise<boolean> {
  if (readMcpServerAttempt(serverId).phase !== "uncertain") return true;
  // A check that throws settles nothing: the flow then says the change couldn't be confirmed.
  const checked = await checkMcpServerOutcome(serverId, () => fetchMcpServer(serverId)).then(
    () => true,
    () => false,
  );
  refreshConnector(readRun(id), serverId);
  return checked && readMcpServerAttempt(serverId).phase !== "uncertain";
}

/**
 * A refused step. One that couldn't be confirmed, or one locked behind an earlier unconfirmed write, is settled
 * first. Settled, a locked step runs again once (`after.retry`: the operator's own press), and a step that was sent is
 * read back (`after.settled`), never sent again on its own. Anything else fails with words for its cause.
 */
async function refusedStep(
  id: number,
  token: number,
  serverId: string,
  step: ServerStep,
  result: WrapperRefusal,
  after: { retry?: () => Promise<void>; settled: () => Promise<void> },
): Promise<void> {
  const lockedBehindUnconfirmed = result.status === "locked" && readMcpServerAttempt(serverId).phase === "uncertain";
  if (result.status !== "uncertain" && !lockedBehindUnconfirmed) return failStep(id, step, result);
  const free = await settleUnconfirmed(id, serverId);
  if (!isCurrent(id, token)) return;
  if (!free) return failStep(id, step, { ...result, status: "uncertain" });
  if (lockedBehindUnconfirmed && after.retry) return after.retry();
  await after.settled();
}

/** Starts the reviewed sign-in and waits for the provider's return, which Settings hands on to this tab. */
export async function startSignIn(id: number, token: number, serverId: string, retried = false): Promise<void> {
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
  if (result.status !== "saved") {
    // A start that may have gone through left no sign-in request here to finish, so a new one is needed.
    return refusedStep(id, token, serverId, "sign_in", result, {
      retry: retried ? undefined : () => startSignIn(id, token, serverId, true),
      settled: async () => failInstallFlow(id, "sign_in", `${STEP_FAILED.sign_in(runName(id))} ${SIGN_IN_AGAIN}`),
    });
  }
  const pending = readMcpOAuthFlow(serverId);
  if (!pending) return failInstallFlow(id, "sign_in", `${STEP_FAILED.sign_in(runName(id))} Try again.`);
  const stop = subscribeMcpOAuthReturn((returned) => receiveSignIn(id, returned));
  patchRun(id, { signIn: { state: pending.state, server: result.server, stop }, enabled: result.server.enabled });
  updateInstallFlow(id, {
    state: {
      phase: "signing_in",
      authorizeUrl: pending.authorizeUrl,
      signInHost: signInHostOf(pending.authorizeUrl),
      scopes: describeRequestedScopes(pending.authorizeUrl),
      startedAt: Date.now(),
    },
  });
}

/**
 * A code pasted from the provider's page. Unlike a return, which may belong to another tab's sign-in, a state that
 * doesn't match was typed here, so the flow says so and keeps waiting (R82).
 */
export function submitSignInCode(id: number, code: string, state: string) {
  const run = readRun(id);
  const current = readInstallFlow(id)?.state;
  if (!run?.signIn || current?.phase !== "signing_in") return;
  if (state !== run.signIn.state) {
    updateInstallFlow(id, { state: { ...current, manualError: MANUAL_MISMATCH } });
    return;
  }
  receiveSignIn(id, { state, code });
}

/** A provider return. One for another sign-in request is dropped without a word. */
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
  const { serverId } = reviewed;
  if (result.status !== "saved") {
    // The code is spent once sent, so a settled completion is read back rather than sent again.
    return refusedStep(id, token, serverId, "finish_sign_in", result, {
      settled: async () => {
        const record = await readServer(id, token, serverId, "finish_sign_in");
        if (!record) return;
        if (record.authState?.readiness !== "ready") {
          return failInstallFlow(id, "finish_sign_in", `${STEP_FAILED.finish_sign_in(runName(id))} ${SIGN_IN_AGAIN}`);
        }
        addChanged(id, "Signed in.");
        await switchOn(id, token, serverId);
      },
    });
  }
  addChanged(id, "Signed in.");
  await switchOn(id, token, serverId);
}

/** Sign-in must come first: an OAuth server can't be switched on until it is signed in. */
export async function switchOn(id: number, token: number, serverId: string, retried = false): Promise<void> {
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
    if (result.status !== "saved") {
      return refusedStep(id, token, serverId, "switch_on", result, {
        retry: retried ? undefined : () => switchOn(id, token, serverId, true),
        settled: () => switchOnSettled(id, token, serverId),
      });
    }
    addChanged(id, "Switched on.");
    patchRun(id, { enabled: true });
  }
  await connectServer(id, token, serverId);
}

/** A switch-on that was sent and is settled now: it goes on to connect only once the server reads switched on. */
async function switchOnSettled(id: number, token: number, serverId: string) {
  const record = await readServer(id, token, serverId, "switch_on");
  if (!record) return;
  if (!record.enabled) return failInstallFlow(id, "switch_on", `${STEP_FAILED.switch_on(runName(id))} Try again.`);
  await connectServer(id, token, serverId);
}

/** Switching on disconnects the server and moves its versions (R55), so the record is read again first. */
export async function connectServer(id: number, token: number, serverId: string, retried = false): Promise<void> {
  updateInstallFlow(id, { state: WORKING.connect });
  const record = await readServer(id, token, serverId, "connect");
  if (!record) return;
  const result = await commitMcpConnection({
    reviewed: record,
    action: "connect",
    isCurrent: () => isCurrent(id, token),
  });
  if (!isCurrent(id, token)) return;
  if (result.status !== "saved") {
    return refusedStep(id, token, serverId, "connect", result, {
      retry: retried ? undefined : () => connectServer(id, token, serverId, true),
      settled: () => connectSettled(id, token, serverId, result.message),
    });
  }
  settleInstallFlow(id, { phase: "done", serverId });
}

/**
 * A connect that was sent and is settled now: done if it connected after all. Otherwise it fails with the server's
 * own last error, redacted, in `detail` only, and what to check next by where the app runs.
 */
async function connectSettled(id: number, token: number, serverId: string, wrapperText: string) {
  const record = await readServer(id, token, serverId, "connect");
  if (!record) return;
  if (record.status === "connected") return settleInstallFlow(id, { phase: "done", serverId });
  const lastError = record.lastError?.trim() ? redactSecretText(record.lastError).value : undefined;
  const next = record.transport === "stdio" ? CONNECT_NEXT.device : CONNECT_NEXT.remote;
  failInstallFlow(id, "connect", `${STEP_FAILED.connect(runName(id))} ${next}`, lastError ?? wrapperText);
}
