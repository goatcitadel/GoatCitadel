import { randomUUID } from "node:crypto";
import { redactSecretText, type ChannelProbeReport, type IntegrationConnection } from "@goatcitadel/contracts";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
import { isConnectionUrlRemoteSafe } from "./connection-url-helpers.js";
import { mapProbeStepsToChecks } from "./channel-probe-result.js";
import type { IntegrationDiagnosticsPort } from "./integration-diagnostics-service.js";

const READ_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 5_000 } as const;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Setup preflight for Matrix: allowlist, whoami, joined rooms and an optional m.notice send. */
export async function runConfiguredMatrixChecks(
  deps: IntegrationDiagnosticsPort,
  connection: IntegrationConnection,
  includeSandboxSend: boolean,
) {
  const config = connection.config;
  const homeserverUrl = deps.readConnectionConfigValue(config, "homeserverUrl");
  const token = deps.resolveConnectionSecret(config, "accessToken", "accessTokenEnv", connection.catalogId, connection);
  if (!homeserverUrl || !token) {
    return {
      checks: [
        {
          key: "matrix_input",
          status: "fail" as const,
          message: "Matrix requires a homeserver URL and an access token before probing.",
        },
      ],
    };
  }
  if (!isConnectionUrlRemoteSafe(homeserverUrl)) {
    return {
      checks: [
        {
          key: "matrix_network",
          status: "fail" as const,
          message:
            "The Matrix homeserver URL uses non-local plain HTTP; use https:// so the access token is not sent in cleartext.",
        },
      ],
    };
  }
  if (!deps.isConnectionUrlAllowlisted(homeserverUrl)) {
    return {
      checks: [
        {
          key: "matrix_network",
          status: "fail" as const,
          message: "The Matrix homeserver host is outside the network allowlist.",
        },
      ],
    };
  }
  return runMatrixLiveChecks({
    homeserverUrl,
    token,
    roomId: deps.readConnectionConfigValue(config, "defaultRoomId"),
    includeSandboxSend,
    fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
  });
}

export async function runMatrixLiveChecks(input: {
  homeserverUrl: string;
  token: string;
  roomId?: string;
  includeSandboxSend: boolean;
  fetcher: Fetcher;
}) {
  const api = `${input.homeserverUrl.replace(/\/+$/, "")}/_matrix/client/v3`;
  const headers = { Authorization: `Bearer ${input.token}` };
  const probe: ChannelProbeReport = {
    kind: "matrix_client",
    mode: "client_server_api",
    checkedAt: new Date().toISOString(),
    steps: [],
  };
  const scrub = (text: string) => redactSecretText(text.split(input.token).join("[redacted]")).value;

  try {
    const whoami = await input.fetcher(`${api}/account/whoami`, { method: "GET", headers });
    if (!whoami.ok) {
      const rejected = whoami.status === 401 || whoami.status === 403;
      probe.steps.push({
        key: "matrix_auth",
        label: "Access token",
        status: rejected ? "fail" : "warn",
        disposition: "blocking",
        message: rejected
          ? "Matrix token rejected: the homeserver refused the access token."
          : `Matrix homeserver returned HTTP ${whoami.status} for whoami.`,
        failureCategory: rejected ? "permission_mismatch" : "platform_unavailable",
      });
      return finish(probe);
    }
    const body = record(await readBoundedResponseJson(whoami, { ...READ_LIMITS, label: "Matrix whoami probe" }));
    const userId = typeof body.user_id === "string" ? body.user_id : "the bot account";
    probe.steps.push({
      key: "matrix_auth",
      label: "Access token",
      status: "pass",
      disposition: "blocking",
      message: scrub(`Authenticated as ${userId}.`),
    });
  } catch {
    probe.steps.push({
      key: "matrix_auth",
      label: "Access token",
      status: "warn",
      disposition: "blocking",
      message: "The Matrix homeserver could not be reached for the whoami check.",
      failureCategory: "platform_unavailable",
    });
    return finish(probe);
  }

  if (input.roomId) {
    await checkJoinedRoom(input, api, headers, probe);
  }

  if (!input.includeSandboxSend) {
    probe.steps.push({
      key: "matrix_sandbox_send",
      label: "Test send",
      status: "skipped",
      disposition: "deferred",
      message: "Run the explicit guided test to send a test message.",
    });
    return finish(probe);
  }
  if (!input.roomId) {
    probe.steps.push({
      key: "matrix_sandbox_send",
      label: "Test send",
      status: "skipped",
      disposition: "deferred",
      message: "Test message skipped because no default room is configured.",
    });
    return finish(probe);
  }
  await sandboxSend(input, api, headers, probe, input.roomId);
  return finish(probe);
}

async function checkJoinedRoom(
  input: { roomId?: string; fetcher: Fetcher },
  api: string,
  headers: Record<string, string>,
  probe: ChannelProbeReport,
): Promise<void> {
  try {
    const joined = await input.fetcher(`${api}/joined_rooms`, { method: "GET", headers });
    if (!joined.ok) {
      probe.steps.push({
        key: "matrix_room",
        label: "Room membership",
        status: "warn",
        disposition: "advisory",
        message: `Matrix returned HTTP ${joined.status} when listing joined rooms.`,
        failureCategory: "platform_unavailable",
      });
      return;
    }
    const body = record(await readBoundedResponseJson(joined, { ...READ_LIMITS, label: "Matrix joined_rooms probe" }));
    const rooms = Array.isArray(body.joined_rooms) ? body.joined_rooms : [];
    if (!rooms.includes(input.roomId)) {
      probe.steps.push({
        key: "matrix_room",
        label: "Room membership",
        status: "warn",
        disposition: "advisory",
        message: "The bot has not joined the default room. Invite the bot account to the room and accept the invite.",
        failureCategory: "destination_mismatch",
      });
    } else {
      probe.steps.push({
        key: "matrix_room",
        label: "Room membership",
        status: "pass",
        disposition: "advisory",
        message: "The bot is joined to the default room.",
      });
    }
  } catch {
    probe.steps.push({
      key: "matrix_room",
      label: "Room membership",
      status: "warn",
      disposition: "advisory",
      message: "Joined rooms could not be listed.",
      failureCategory: "platform_unavailable",
    });
  }
}

async function sandboxSend(
  input: { fetcher: Fetcher },
  api: string,
  headers: Record<string, string>,
  probe: ChannelProbeReport,
  roomId: string,
): Promise<void> {
  try {
    const response = await input.fetcher(
      `${api}/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(randomUUID())}`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "m.notice", body: "GoatCitadel channel setup verification." }),
      },
    );
    if (!response.ok) {
      probe.steps.push({
        key: "matrix_sandbox_send",
        label: "Test send",
        status: response.status >= 500 ? "warn" : "fail",
        disposition: "blocking",
        message: `Matrix rejected the test message (HTTP ${response.status}). Verify the bot is joined and may post.`,
        failureCategory:
          response.status === 401 || response.status === 403 ? "permission_mismatch" : "destination_mismatch",
      });
      return;
    }
    const body = record(await readBoundedResponseJson(response, { ...READ_LIMITS, label: "Matrix send probe" }));
    probe.steps.push({
      key: "matrix_sandbox_send",
      label: "Test send",
      status: "pass",
      disposition: "blocking",
      ...(typeof body.event_id === "string" ? { providerMessageId: body.event_id } : {}),
      message: "The room accepted the test message. Check that it arrived.",
    });
  } catch {
    probe.steps.push({
      key: "matrix_sandbox_send",
      label: "Test send",
      status: "warn",
      disposition: "blocking",
      message: "Matrix send outcome is uncertain. Inspect the room before running another send.",
      failureCategory: "platform_unavailable",
    });
  }
}

function finish(probe: ChannelProbeReport) {
  return { checks: mapProbeStepsToChecks(probe.steps), probe };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
