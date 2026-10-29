import type { IntegrationConnection } from "@goatcitadel/contracts";
import { isSlackSocketInboundEnabled } from "@goatcitadel/gateway-core";
import { BoundedResponseReadError, readBoundedResponseJson } from "../bounded-response-reader.js";
import type { ChannelSecretOwner } from "../channel-secret-resolution.js";
import {
  ChannelStreamAuthError,
  type ChannelStreamAdapter,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";

/**
 * Slack inbound over Socket Mode, so a connection needs no public web address.
 *
 * The app-level token asks `apps.connections.open` for a one-use `wss://` address, and the socket it opens delivers
 * `events_api` envelopes. Each envelope is acknowledged by sending back its `envelope_id`: an event only after it was
 * handled (at-least-once: Slack sends an unacknowledged one again, and the idempotency key dedupes it), a slash
 * command or interaction at once because GoatCitadel handles neither.
 *
 * Slack refreshes a socket every few hours and says so with a `disconnect` envelope. The adapter then opens the next
 * socket itself, inside `run`, because a `run` that ends (resolves or rejects) makes the runtime back off. A socket
 * that has been silent for an hour is replaced the same way. Anything else that ends a socket rejects `run`.
 *
 * The app-level token and the socket address (which carries a connection ticket) never reach an error or a
 * diagnostic: errors are fixed sentences, never a fetch error message, a URL, a response body or a socket event.
 */

/** A socket that has received no frame for this long is replaced; nothing else would notice a silently dead link. */
export const QUIET_RECONNECT_MS = 3_600_000;
/** How long Slack gets to answer `apps.connections.open`. */
export const OPEN_TIMEOUT_MS = 15_000;
const OPEN_MAX_BYTES = 64 * 1024;
const SLACK_ORIGIN = "https://slack.com/";
const OPEN_ENDPOINT = `${SLACK_ORIGIN}api/apps.connections.open`;
const SOCKET_HOST_SUFFIX = ".slack.com";

const NO_TOKEN = "Slack has no app-level token.";
const NOT_ALLOWED = "GoatCitadel isn't allowed to reach slack.com.";
const REJECTED_TOKEN = "Slack didn't accept the app-level token.";
const RATE_LIMITED = "Slack asked GoatCitadel to wait before connecting again.";
const CANT_OPEN = "Slack couldn't open a connection.";
const UNREACHABLE = "GoatCitadel couldn't reach Slack.";
const BAD_ADDRESS = "Slack returned an address GoatCitadel won't open.";
const LINK_DISABLED = "Slack turned Socket Mode off for this app.";
const CLOSED = "The connection to Slack closed.";

/** `apps.connections.open` errors that mean the app-level token itself is the problem. */
const TOKEN_REJECTIONS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "not_allowed_token_type",
  "missing_scope",
]);

/** The slice of the WebSocket API the adapter needs; the Node global satisfies it. */
export interface SlackSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}

export interface SlackSocketStreamAdapterDeps {
  /** Plain fetch with the request's own signal. */
  fetch: typeof fetch;
  resolveSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId: string | undefined,
    owner: ChannelSecretOwner,
  ): string | undefined;
  isUrlAllowlisted(urlValue: string): boolean;
  createWebSocket(url: string): SlackSocketLike;
  /** Handles one `events_api` payload; the envelope is acknowledged once this resolves. */
  processEvent(connectionId: string, payload: unknown): Promise<unknown>;
}

/** How one socket ended without failing: Slack asked for a new one, it went quiet, or the session was stopped. */
type SocketEnd = "refresh" | "quiet" | "aborted";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A failed call's body is never read: it is released unread so it cannot reach an error. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function readFrame(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const frame: unknown = JSON.parse(data);
    return isRecord(frame) ? frame : undefined;
  } catch {
    return undefined;
  }
}

/** A reply that is not JSON is Slack's doing; a reply that could not be read at all is the connection's. */
function describeReadFailure(error: unknown): string {
  const unreadable =
    error instanceof BoundedResponseReadError && (error.code === "body_parse" || error.code === "body_missing");
  return unreadable ? CANT_OPEN : UNREACHABLE;
}

/** Slack's socket addresses are `wss://` on a subdomain of slack.com; anything else is never opened. */
function checkSocketAddress(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error(BAD_ADDRESS);
  }
  if (url.protocol !== "wss:" || !url.hostname.endsWith(SOCKET_HOST_SUFFIX)) throw new Error(BAD_ADDRESS);
  return address;
}

export function createSlackSocketStreamAdapter(deps: SlackSocketStreamAdapterDeps): ChannelStreamAdapter {
  /** Returns the socket address, or undefined when the session was stopped while Slack was being asked. */
  async function openAddress(token: string, signal: AbortSignal): Promise<string | undefined> {
    let response: Response;
    try {
      response = await deps.fetch(OPEN_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(OPEN_TIMEOUT_MS)]),
        // A redirect could carry the token to another host; surface it as an error instead.
        redirect: "error",
      });
    } catch {
      // The fetch error can quote the request, which holds the token.
      if (signal.aborted) return undefined;
      throw new Error(UNREACHABLE);
    }
    if (!response.ok) {
      discardBody(response);
      throw new Error(response.status === 429 ? RATE_LIMITED : CANT_OPEN);
    }
    let body: unknown;
    let readFailure: string | undefined;
    try {
      body = await readBoundedResponseJson(response, {
        maxBytes: OPEN_MAX_BYTES,
        timeoutMs: OPEN_TIMEOUT_MS,
        label: "Slack apps.connections.open",
      });
    } catch (error) {
      if (signal.aborted) return undefined;
      readFailure = describeReadFailure(error);
    }
    if (readFailure) throw new Error(readFailure);
    if (!isRecord(body)) throw new Error(CANT_OPEN);
    if (body.ok !== true) {
      const code = typeof body.error === "string" ? body.error : "";
      if (TOKEN_REJECTIONS.has(code)) throw new ChannelStreamAuthError(REJECTED_TOKEN);
      throw new Error(code === "ratelimited" ? RATE_LIMITED : CANT_OPEN);
    }
    if (typeof body.url !== "string") throw new Error(CANT_OPEN);
    return checkSocketAddress(body.url);
  }

  /** Serves one socket until Slack refreshes it, it goes quiet or the session stops; rejects when it fails. */
  function serve(ctx: ChannelStreamRunContext, address: string): Promise<SocketEnd> {
    return new Promise<SocketEnd>((resolve, reject) => {
      if (ctx.signal.aborted) {
        resolve("aborted");
        return;
      }
      let socket: SlackSocketLike;
      try {
        socket = deps.createWebSocket(address);
      } catch {
        reject(new Error(UNREACHABLE));
        return;
      }
      const connectionId = ctx.connection.connectionId;
      let ended = false;
      let ending = false;
      // Envelopes are handled one at a time, in arrival order. The chain never rejects: a failure ends the socket.
      let chain: Promise<void> = Promise.resolve();
      let quietTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (outcome: SocketEnd | Error) => {
        if (ended) return;
        ended = true;
        clearTimeout(quietTimer);
        ctx.signal.removeEventListener("abort", onAbort);
        try {
          socket.close();
        } catch {
          // already closed
        }
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };
      // Slack ended the socket: let the envelope being handled finish (and be acknowledged) before it closes.
      const finishAfterDrain = (outcome: SocketEnd | Error) => {
        if (ended || ending) return;
        ending = true;
        // The chain never rejects and `finish` does not throw; if either ever did, the run still ends, with a fixed
        // sentence (rejecting an already settled run is a no-op, and nothing from the failure is kept).
        void chain.then(() => finish(outcome)).catch(() => reject(new Error(CLOSED)));
      };
      const onAbort = () => finish("aborted");
      const armQuietTimer = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish("quiet"), QUIET_RECONNECT_MS);
      };
      const acknowledge = (envelopeId: string) => {
        if (ended) return;
        try {
          socket.send(JSON.stringify({ envelope_id: envelopeId }));
        } catch {
          finish(new Error(CLOSED));
        }
      };
      const handleEnvelope = (envelopeId: string, payload: unknown) => {
        chain = chain
          .then(async () => {
            if (ended) return;
            await ctx.handle(() => deps.processEvent(connectionId, payload));
            acknowledge(envelopeId);
          })
          // An envelope that was not handled stays unacknowledged, so Slack sends it again after the reconnect.
          .catch((error: unknown) => finish(error instanceof Error ? error : new Error(CLOSED)));
      };
      const handleDisconnect = (reason: unknown) => {
        if (reason === "link_disabled") finishAfterDrain(new Error(LINK_DISABLED));
        else if (reason === "refresh_requested" || reason === "warning") finishAfterDrain("refresh");
        else finishAfterDrain(new Error(CLOSED));
      };

      ctx.signal.addEventListener("abort", onAbort, { once: true });
      armQuietTimer();
      socket.addEventListener("message", (event) => {
        if (ended || ending) return;
        // Any frame proves the socket is alive.
        ctx.touch();
        armQuietTimer();
        const frame = readFrame(event.data);
        if (!frame) return;
        if (frame.type === "hello") {
          ctx.markReady();
          return;
        }
        if (frame.type === "disconnect") {
          handleDisconnect(frame.reason);
          return;
        }
        const envelopeId = typeof frame.envelope_id === "string" ? frame.envelope_id : "";
        if (envelopeId.length === 0) return;
        if (frame.type === "events_api") handleEnvelope(envelopeId, frame.payload);
        else acknowledge(envelopeId);
      });
      // A socket event can quote the address, so neither its data nor its message is read.
      socket.addEventListener("close", () => finishAfterDrain(new Error(CLOSED)));
      socket.addEventListener("error", () => finishAfterDrain(new Error(CLOSED)));
    });
  }

  return {
    channelKey: "slack",
    // No idle watchdog: a quiet workspace is normal, and the quiet timer replaces a socket that went silent.
    isInboundEnabled(connection: IntegrationConnection): boolean {
      return isSlackSocketInboundEnabled(connection.config);
    },
    async run(ctx: ChannelStreamRunContext): Promise<void> {
      const token = deps.resolveSecret(
        ctx.connection.config,
        "appToken",
        "appTokenEnv",
        ctx.connection.catalogId,
        ctx.connection,
      );
      if (!token) throw new ChannelStreamAuthError(NO_TOKEN);
      if (!deps.isUrlAllowlisted(SLACK_ORIGIN)) throw new Error(NOT_ALLOWED);
      while (!ctx.signal.aborted) {
        const address = await openAddress(token, ctx.signal);
        if (address === undefined) return;
        if ((await serve(ctx, address)) === "aborted") return;
      }
    },
  };
}
