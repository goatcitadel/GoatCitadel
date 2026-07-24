import { randomBytes as nodeRandomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  createSessionControlClient,
  type SessionControlClient,
} from "@goatcitadel/mission-control-shared/api/session-control";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import type { SessionControlDetailResponse } from "@goatcitadel/contracts";
import {
  controlTokenFingerprint,
  createCompanionControlAuthorize,
  createFileSessionControlSecretStore,
  createIdempotencyKey,
  generateControlSecret,
  hashControlSecretSha256,
  type CompanionControlCredential,
  type SessionControlCliIo,
  type SessionControlSecretRef,
  type SessionControlSecretStore,
} from "./services/session-control-cli-runtime.js";

/**
 * HX-411 governed external session-control CLI. A deliberately thin command
 * layer over the shared, typed, no-store control client. It owns the operator UX:
 * generate a 256-bit control secret locally, submit only its SHA-256 in a signed
 * request, hold the secret in an owner-restricted local file between invocations,
 * and attach/heartbeat/reconnect/release while showing truthful controller/generation/
 * lease/reconnect state from the content-free control-status route.
 *
 * The control secret is NEVER accepted as a command argument, printed, logged, or
 * placed in a URL or request body — only its SHA-256 travels in a body and only
 * the plaintext travels in the shared client's frozen token header. The command
 * layer receives its collaborators by injection so tests can prove no secret
 * reaches argv or any emitted line deterministically.
 */

const SUPPORTED_ACTIONS = ["attach", "status", "heartbeat", "reconnect", "release", "help"] as const;
type SessionControlCliAction = (typeof SUPPORTED_ACTIONS)[number];

export interface SessionControlCliDeps {
  /** The shared typed control client (already bound to base URL, fetch, authorizer). */
  readonly client: SessionControlClient;
  /** Public, stable client-instance id this controller binds to. */
  readonly clientInstanceId: string;
  /** Injected randomness for the control secret and idempotency keys. */
  readonly randomBytes: (size: number) => Buffer;
  /** At-rest secret store keyed by session + client instance. */
  readonly secretStore: SessionControlSecretStore;
  readonly io: SessionControlCliIo;
}

interface ParsedCommand {
  readonly action: SessionControlCliAction;
  readonly sessionId?: string;
  readonly read: boolean;
}

/** Raised for CLI-usage / local precondition failures (never carries a secret). */
export class SessionControlCliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SessionControlCliError";
  }
}

/**
 * Run one session-control CLI command. Returns a process exit code. Never throws;
 * every failure is rendered to the injected error sink without any secret.
 */
export async function runSessionControlCli(argv: readonly string[], deps: SessionControlCliDeps): Promise<number> {
  let command: ParsedCommand;
  try {
    command = parseCommand(argv);
  } catch (error) {
    deps.io.err(formatCliError(error));
    printUsage(deps.io);
    return 2;
  }

  if (command.action === "help") {
    printUsage(deps.io);
    return 0;
  }

  const sessionId = command.sessionId;
  if (!sessionId) {
    deps.io.err("A --session <sessionId> is required.");
    printUsage(deps.io);
    return 2;
  }

  try {
    switch (command.action) {
      case "attach":
        return await commandAttach(deps, sessionId, command.read);
      case "status":
        return await commandStatus(deps, sessionId);
      case "heartbeat":
        return await commandHeartbeat(deps, sessionId);
      case "reconnect":
        return await commandReconnect(deps, sessionId);
      case "release":
        return await commandRelease(deps, sessionId);
    }
  } catch (error) {
    deps.io.err(formatCliError(error));
    return 1;
  }
}

async function commandAttach(deps: SessionControlCliDeps, sessionId: string, read: boolean): Promise<number> {
  const detail = await deps.client.getControl(sessionId);
  const expectedGeneration = detail.control.generation;
  // The secret exists only in this process and the secret store; only its hash is
  // ever transmitted, and the fingerprint printed below is derived from the hash.
  const secret = generateControlSecret(deps.randomBytes);
  const tokenHashSha256 = hashControlSecretSha256(secret);
  const capabilities = read ? (["send", "read"] as const) : (["send"] as const);
  const response = await deps.client.createExternalRequest(sessionId, {
    expectedGeneration,
    clientInstanceId: deps.clientInstanceId,
    tokenHashSha256,
    capabilities,
    idempotencyKey: createIdempotencyKey("request", deps.randomBytes),
  });
  deps.secretStore.save(secretRef(deps, sessionId), secret);

  deps.io.out(`Requested session control for ${sessionId}.`);
  deps.io.out(`  request id:         ${response.request.requestId}`);
  deps.io.out(`  requested caps:     ${capabilities.join(", ")}`);
  deps.io.out(`  token fingerprint:  ${controlTokenFingerprint(tokenHashSha256)}`);
  deps.io.out(`  current generation: ${expectedGeneration} (operator)`);
  deps.io.out(`Awaiting operator hand off; run "status" to observe generation ${expectedGeneration + 1}.`);
  return 0;
}

async function commandStatus(deps: SessionControlCliDeps, sessionId: string): Promise<number> {
  const detail = await deps.client.getControl(sessionId);
  renderControlDetail(deps, detail);
  return 0;
}

async function commandHeartbeat(deps: SessionControlCliDeps, sessionId: string): Promise<number> {
  const secret = requireStoredSecret(deps, sessionId);
  const generation = await requireOwnedExternalGeneration(deps, sessionId, "heartbeat");
  const response = await deps.client.heartbeat(
    sessionId,
    { expectedGeneration: generation, idempotencyKey: createIdempotencyKey("heartbeat", deps.randomBytes) },
    secret,
  );
  deps.io.out(`Heartbeat accepted at generation ${response.generation}.`);
  deps.io.out(`  lease renewed until   ${response.control.leaseExpiresAt}`);
  deps.io.out(`  reconnect deadline    ${response.control.reconnectExpiresAt}`);
  return 0;
}

async function commandReconnect(deps: SessionControlCliDeps, sessionId: string): Promise<number> {
  const oldSecret = requireStoredSecret(deps, sessionId);
  const generation = await requireOwnedExternalGeneration(deps, sessionId, "reconnect");
  // Generate the NEXT secret locally; the OLD secret authenticates the rotation
  // in the token header, while only the NEW secret's hash rides the body.
  const newSecret = generateControlSecret(deps.randomBytes);
  const newTokenHashSha256 = hashControlSecretSha256(newSecret);
  const response = await deps.client.reconnect(
    sessionId,
    {
      expectedGeneration: generation,
      newTokenHashSha256,
      idempotencyKey: createIdempotencyKey("reconnect", deps.randomBytes),
    },
    oldSecret,
  );
  // Only after the Gateway confirms the one-winner rotation do we promote the new
  // secret; a failed reconnect leaves the (now useless) old secret untouched.
  deps.secretStore.save(secretRef(deps, sessionId), newSecret);

  deps.io.out(`Reconnected: superseded generation ${response.supersededGeneration}.`);
  deps.io.out(`  new generation        ${response.control.generation}`);
  deps.io.out(`  new token fingerprint ${controlTokenFingerprint(newTokenHashSha256)}`);
  return 0;
}

async function commandRelease(deps: SessionControlCliDeps, sessionId: string): Promise<number> {
  const secret = requireStoredSecret(deps, sessionId);
  const generation = await requireOwnedExternalGeneration(deps, sessionId, "release");
  const response = await deps.client.release(
    sessionId,
    { expectedGeneration: generation, idempotencyKey: createIdempotencyKey("release", deps.randomBytes) },
    secret,
  );
  deps.secretStore.clear(secretRef(deps, sessionId));

  deps.io.out(`Released generation ${response.releasedGeneration}.`);
  deps.io.out(`  operator now owns generation ${response.control.generation}`);
  return 0;
}

function renderControlDetail(deps: SessionControlCliDeps, detail: SessionControlDetailResponse): void {
  const control = detail.control;
  deps.io.out(`Session ${control.sessionId} (workspace ${control.workspaceId})`);
  deps.io.out(`  owner:       ${control.ownerKind}`);
  deps.io.out(`  generation:  ${control.generation}`);
  deps.io.out(`  lease state: ${control.leaseState}`);
  if (control.ownerKind === "external_companion") {
    const mine = control.boundExternalController.clientInstanceId === deps.clientInstanceId;
    deps.io.out(`  controller:  ${control.boundExternalController.clientInstanceId}${mine ? " (this client)" : ""}`);
    deps.io.out(`  capabilities:${control.capabilities.length ? ` ${control.capabilities.join(", ")}` : " none"}`);
    deps.io.out(`  token fp:    ${control.boundExternalController.tokenFingerprint}`);
    deps.io.out(`  last beat:   ${control.lastHeartbeatAt}`);
    deps.io.out(`  lease until: ${control.leaseExpiresAt}`);
    deps.io.out(`  reconnect by:${control.reconnectExpiresAt}`);
  } else {
    deps.io.out(`  pending requests: ${detail.pendingRequests.length}`);
  }
}

/**
 * Fetch the content-free status and assert this client instance is the current
 * external controller, returning the exact generation to bind. Fails closed
 * (never guessing) when the session is operator-owned or bound to another client.
 */
async function requireOwnedExternalGeneration(
  deps: SessionControlCliDeps,
  sessionId: string,
  operation: string,
): Promise<number> {
  const detail = await deps.client.getControl(sessionId);
  const control = detail.control;
  if (control.ownerKind !== "external_companion") {
    throw new SessionControlCliError(
      `Session ${sessionId} is operator-owned (generation ${control.generation}); cannot ${operation}.`,
    );
  }
  if (control.boundExternalController.clientInstanceId !== deps.clientInstanceId) {
    throw new SessionControlCliError(
      `Session ${sessionId} is controlled by a different client instance; cannot ${operation}.`,
    );
  }
  return control.generation;
}

function requireStoredSecret(deps: SessionControlCliDeps, sessionId: string): string {
  const secret = deps.secretStore.load(secretRef(deps, sessionId));
  if (!secret) {
    throw new SessionControlCliError(`No stored control secret for ${sessionId}; run "attach" first.`);
  }
  return secret;
}

function secretRef(deps: SessionControlCliDeps, sessionId: string): SessionControlSecretRef {
  return { sessionId, clientInstanceId: deps.clientInstanceId };
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const [rawAction, ...rest] = argv;
  const action = (rawAction ?? "help") as string;
  if (!SUPPORTED_ACTIONS.includes(action as SessionControlCliAction)) {
    throw new SessionControlCliError(`Unknown command "${action}".`);
  }
  let sessionId: string | undefined;
  let read = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--session") {
      sessionId = rest[index + 1];
      index += 1;
    } else if (token === "--read") {
      read = true;
    } else if (token?.startsWith("--session=")) {
      sessionId = token.slice("--session=".length);
    } else {
      throw new SessionControlCliError(`Unexpected argument "${token}".`);
    }
  }
  const trimmed = sessionId?.trim();
  return { action: action as SessionControlCliAction, sessionId: trimmed ? trimmed : undefined, read };
}

function formatCliError(error: unknown): string {
  if (error instanceof SessionControlCliError) {
    return error.message;
  }
  if (isApiRequestError(error)) {
    const controlCode = readSessionControlCode(error.body);
    const detail = controlCode ?? readErrorMessage(error.body) ?? `HTTP ${error.status ?? "error"}`;
    return `${error.method} ${error.path} failed: ${detail}`;
  }
  return (error as Error)?.message ?? "Session control command failed.";
}

function readSessionControlCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const errorField = (body as { error?: unknown }).error;
  if (errorField && typeof errorField === "object") {
    const details = (errorField as { details?: unknown }).details;
    const code =
      details && typeof details === "object"
        ? (details as { sessionControlCode?: unknown }).sessionControlCode
        : undefined;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function readErrorMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim() || undefined;
  if (!body || typeof body !== "object") return undefined;
  const errorField = (body as { error?: unknown }).error;
  if (typeof errorField === "string") return errorField.trim() || undefined;
  if (errorField && typeof errorField === "object") {
    const message = (errorField as { message?: unknown }).message;
    if (typeof message === "string") return message.trim() || undefined;
  }
  return undefined;
}

function printUsage(io: SessionControlCliIo): void {
  io.out(`Usage: goatcitadel-session-control <command> --session <sessionId>

Commands:
  attach --session <id> [--read]   Generate a control secret, request control, and await hand off.
  status --session <id>            Show the current controller, generation, and lease state.
  heartbeat --session <id>         Renew the live lease for the controlled session.
  reconnect --session <id>         Rotate the controller generation from N to N+1.
  release --session <id>           Return control to a new operator generation.
  help                             Show this message.

The control secret is generated locally and held in an owner-restricted local file
(POSIX mode 0600, or a Windows owner-only ACL) under your home directory by default.
It is never accepted as an argument, printed, or logged.`);
}

// ---------------------------------------------------------------------------
// Production entry: build the real collaborators from the environment (never
// from argv) and run. The companion credential and control secret directory are
// read from files/env; neither the companion key nor the control secret is ever
// echoed.
// ---------------------------------------------------------------------------

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8787";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let deps: SessionControlCliDeps;
  try {
    deps = buildProductionDeps();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  return runSessionControlCli(argv, deps);
}

function buildProductionDeps(): SessionControlCliDeps {
  const baseUrl = process.env.GOATCITADEL_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
  const clientInstanceId = process.env.GOATCITADEL_SESSION_CONTROL_CLIENT_INSTANCE?.trim();
  if (!clientInstanceId) {
    throw new SessionControlCliError(
      "GOATCITADEL_SESSION_CONTROL_CLIENT_INSTANCE must be set to a stable client-instance id.",
    );
  }
  const companion = loadCompanionControlCredentialFromEnv();
  const client = createSessionControlClient({
    baseUrl,
    clientInstanceId,
    authorize: createCompanionControlAuthorize({ companion, now: Date.now, randomBytes: nodeRandomBytes }),
  });
  return {
    client,
    clientInstanceId,
    randomBytes: nodeRandomBytes,
    secretStore: createFileSessionControlSecretStore(resolveSecretDir()),
    io: {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    },
  };
}

function loadCompanionControlCredentialFromEnv(): CompanionControlCredential {
  const file = process.env.GOATCITADEL_SESSION_CONTROL_COMPANION_FILE?.trim();
  if (!file) {
    throw new SessionControlCliError(
      "GOATCITADEL_SESSION_CONTROL_COMPANION_FILE must point to the companion credential JSON.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new SessionControlCliError(`Failed to read companion credential file: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SessionControlCliError("Companion credential file is malformed.");
  }
  const accessToken = (parsed as { accessToken?: unknown }).accessToken;
  const signingPrivateKeyPem = (parsed as { signingPrivateKeyPem?: unknown }).signingPrivateKeyPem;
  const companionSessionId = (parsed as { companionSessionId?: unknown }).companionSessionId;
  if (typeof accessToken !== "string" || typeof signingPrivateKeyPem !== "string") {
    throw new SessionControlCliError(
      "Companion credential file must contain accessToken and signingPrivateKeyPem strings.",
    );
  }
  return {
    accessToken,
    signingPrivateKeyPem,
    companionSessionId: typeof companionSessionId === "string" ? companionSessionId : undefined,
  };
}

function resolveSecretDir(warn: (line: string) => void = emitStderrLine): string {
  const override = process.env.GOATCITADEL_SESSION_CONTROL_SECRET_DIR?.trim();
  if (override) {
    const warning = secretDirLocationWarning(override, os.homedir());
    if (warning) warn(warning);
    return override;
  }
  return path.join(os.homedir(), ".goatcitadel", "session-control-secrets");
}

function emitStderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Warn (by returning a message) when a secret-directory override sits outside the
 * user's home directory, where the plaintext secret may not be owner-protected.
 * Pure and platform-aware (case-insensitive containment on Windows) so it is
 * deterministically testable. Returns `undefined` when the override is safely
 * inside the home directory.
 */
export function secretDirLocationWarning(dir: string, homeDir: string): string | undefined {
  if (isWithinDir(dir, homeDir)) return undefined;
  return (
    `[session-control] warning: GOATCITADEL_SESSION_CONTROL_SECRET_DIR (${path.resolve(dir)}) is outside your ` +
    `home directory (${path.resolve(homeDir)}); the stored control secret may not be owner-protected there. ` +
    `Prefer a path under your home directory.`
  );
}

function isWithinDir(candidate: string, parent: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(parent), normalize(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const invokedAsScript = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
