import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import type {
  SessionControlClient,
  SessionControlDetailResponse,
} from "@goatcitadel/mission-control-shared/api/session-control";

import { runSessionControlCli, secretDirLocationWarning, type SessionControlCliDeps } from "./session-control-cli.js";
import {
  controlTokenFingerprint,
  createFileSessionControlSecretStore,
  hashControlSecretSha256,
  type SessionControlSecretRef,
  type SessionControlSecretStore,
} from "./services/session-control-cli-runtime.js";

const CLIENT_INSTANCE = "cli-01";
const LEASE_UNTIL = "2026-07-21T00:01:00.000Z";
const RECONNECT_BY = "2026-07-21T00:05:00.000Z";
const LAST_BEAT = "2026-07-21T00:00:00.000Z";

// Deterministic randomness: each call fills a buffer with an incrementing byte
// starting at `start`, so the generated control secret is a known, distinctive
// string every test can search for across argv and every emitted line.
function seededRandomBytes(start = 0xa0): (size: number) => Buffer {
  let value = start;
  return (size: number) => {
    const buffer = Buffer.alloc(size, value & 0xff);
    value += 1;
    return buffer;
  };
}

function expectedSecretForByte(byte: number): string {
  return Buffer.alloc(32, byte).toString("hex");
}

function operatorControl(sessionId: string, generation = 1): SessionControlDetailResponse {
  return {
    control: {
      workspaceId: "ws-1",
      sessionId,
      generation,
      ownerKind: "operator",
      leaseState: "operator_active",
      capabilities: [],
      lastEventId: "evt-1",
      lastEventReasonCode: "session_initialized",
      updatedAt: LAST_BEAT,
    },
    pendingRequests: [],
  } as unknown as SessionControlDetailResponse;
}

function externalControl(
  sessionId: string,
  generation: number,
  clientInstanceId: string,
  tokenFingerprint = "deadbeef",
): SessionControlDetailResponse {
  return {
    control: {
      workspaceId: "ws-1",
      sessionId,
      generation,
      ownerKind: "external_companion",
      leaseState: "external_live",
      capabilities: ["send"],
      boundExternalController: {
        companionSessionId: "cs-1",
        clientInstanceId,
        principalPurpose: "session_control_client",
        tokenFingerprint,
      },
      lastHeartbeatAt: LAST_BEAT,
      leaseExpiresAt: LEASE_UNTIL,
      reconnectExpiresAt: RECONNECT_BY,
      lastEventId: "evt-2",
      lastEventReasonCode: "handoff",
      updatedAt: LAST_BEAT,
    },
    pendingRequests: [],
  } as unknown as SessionControlDetailResponse;
}

function makeFakeClient(control: SessionControlDetailResponse) {
  return {
    getControl: vi.fn(async () => control),
    createExternalRequest: vi.fn(async () => ({ request: { requestId: "req-1" } })),
    heartbeat: vi.fn(async (_sessionId: string, input: { expectedGeneration: number }) => ({
      generation: input.expectedGeneration,
      control: { generation: input.expectedGeneration, leaseExpiresAt: LEASE_UNTIL, reconnectExpiresAt: RECONNECT_BY },
    })),
    reconnect: vi.fn(async (_sessionId: string, input: { expectedGeneration: number }) => ({
      supersededGeneration: input.expectedGeneration,
      control: { generation: input.expectedGeneration + 1 },
    })),
    release: vi.fn(async (_sessionId: string, input: { expectedGeneration: number }) => ({
      releasedGeneration: input.expectedGeneration,
      control: { generation: input.expectedGeneration + 1 },
    })),
    openEventStream: vi.fn(),
  };
}

function makeMemoryStore(initial: Record<string, string> = {}): {
  store: SessionControlSecretStore;
  snapshot: () => Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  const key = (ref: SessionControlSecretRef): string => `${ref.sessionId}::${ref.clientInstanceId}`;
  return {
    store: {
      save: (ref, secret) => void map.set(key(ref), secret),
      load: (ref) => map.get(key(ref)),
      clear: (ref) => void map.delete(key(ref)),
    },
    snapshot: () => Object.fromEntries(map.entries()),
  };
}

function makeHarness(options: {
  control: SessionControlDetailResponse;
  storeSeed?: Record<string, string>;
  randomStart?: number;
}) {
  const client = makeFakeClient(options.control);
  const memory = makeMemoryStore(options.storeSeed);
  const out: string[] = [];
  const err: string[] = [];
  const deps: SessionControlCliDeps = {
    client: client as unknown as SessionControlClient,
    clientInstanceId: CLIENT_INSTANCE,
    randomBytes: seededRandomBytes(options.randomStart ?? 0xa0),
    secretStore: memory.store,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
  };
  return { client, memory, out, err, deps };
}

function assertNoSecretLeak(lines: string[], argv: readonly string[], secrets: string[]): void {
  for (const secret of secrets) {
    for (const line of lines) {
      expect(line).not.toContain(secret);
    }
    expect(argv).not.toContain(secret);
    expect(argv.join(" ")).not.toContain(secret);
  }
}

describe("session-control CLI: attach", () => {
  it("generates a secret locally, submits only its SHA-256, and stores the secret off argv/logs", async () => {
    const { client, memory, out, err, deps } = makeHarness({ control: operatorControl("sess-1", 1) });
    const argv = ["attach", "--session", "sess-1"];
    const code = await runSessionControlCli(argv, deps);

    expect(code).toBe(0);
    const secret = expectedSecretForByte(0xa0);
    const hash = hashControlSecretSha256(secret);

    // Exactly the token hash — never the plaintext — is sent to the request route.
    expect(client.createExternalRequest).toHaveBeenCalledTimes(1);
    const [, input] = client.createExternalRequest.mock.calls[0] as [string, Record<string, unknown>];
    expect(input.tokenHashSha256).toBe(hash);
    expect(input.capabilities).toEqual(["send"]);
    expect(input.expectedGeneration).toBe(1);
    expect(input.clientInstanceId).toBe(CLIENT_INSTANCE);
    expect(JSON.stringify(input)).not.toContain(secret);

    // The secret is retained locally for later protocol operations.
    expect(memory.snapshot()).toEqual({ [`sess-1::${CLIENT_INSTANCE}`]: secret });

    // The printed correlation is the fingerprint (hash-derived), not the secret.
    expect(out.join("\n")).toContain(controlTokenFingerprint(hash));
    assertNoSecretLeak([...out, ...err], argv, [secret]);
  });

  it("requests {send, read} when --read is passed", async () => {
    const { client, deps } = makeHarness({ control: operatorControl("sess-1", 1) });
    await runSessionControlCli(["attach", "--session", "sess-1", "--read"], deps);
    const [, input] = client.createExternalRequest.mock.calls[0] as [string, Record<string, unknown>];
    expect(input.capabilities).toEqual(["send", "read"]);
  });
});

describe("session-control CLI: status", () => {
  it("renders operator ownership truthfully without touching the secret store", async () => {
    const { out, deps } = makeHarness({ control: operatorControl("sess-1", 3) });
    const code = await runSessionControlCli(["status", "--session", "sess-1"], deps);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("owner:       operator");
    expect(text).toContain("generation:  3");
    expect(text).toContain("lease state: operator_active");
  });

  it("renders the external controller, generation, and lease truthfully", async () => {
    const { out, deps } = makeHarness({ control: externalControl("sess-1", 4, CLIENT_INSTANCE) });
    await runSessionControlCli(["status", "--session", "sess-1"], deps);
    const text = out.join("\n");
    expect(text).toContain("owner:       external_companion");
    expect(text).toContain("generation:  4");
    expect(text).toContain("lease state: external_live");
    expect(text).toContain("(this client)");
    expect(text).toContain(LEASE_UNTIL);
  });
});

describe("session-control CLI: heartbeat", () => {
  it("presents the stored secret to the client token param, binds the observed generation, and never logs it", async () => {
    const secret = "stored-secret-HEARTBEAT-should-never-leak";
    const { client, out, err, deps } = makeHarness({
      control: externalControl("sess-1", 5, CLIENT_INSTANCE),
      storeSeed: { [`sess-1::${CLIENT_INSTANCE}`]: secret },
    });
    const argv = ["heartbeat", "--session", "sess-1"];
    const code = await runSessionControlCli(argv, deps);

    expect(code).toBe(0);
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
    const [sessionId, input, presentedSecret] = client.heartbeat.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(sessionId).toBe("sess-1");
    expect(input.expectedGeneration).toBe(5);
    // The secret is routed ONLY to the token-carrying client parameter, never the body.
    expect(presentedSecret).toBe(secret);
    expect(JSON.stringify(input)).not.toContain(secret);
    assertNoSecretLeak([...out, ...err], argv, [secret]);
  });

  it("fails closed without a stored secret and does not call the client", async () => {
    const { client, err, deps } = makeHarness({ control: externalControl("sess-1", 5, CLIENT_INSTANCE) });
    const code = await runSessionControlCli(["heartbeat", "--session", "sess-1"], deps);
    expect(code).toBe(1);
    expect(client.heartbeat).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain('run "attach" first');
  });
});

describe("session-control CLI: reconnect", () => {
  it("authenticates the OLD secret + generation, sends only the NEW token hash, and rotates the stored secret", async () => {
    const oldSecret = "OLD-secret-reconnect-DO-NOT-LEAK-1111";
    const { client, memory, out, err, deps } = makeHarness({
      control: externalControl("sess-1", 6, CLIENT_INSTANCE),
      storeSeed: { [`sess-1::${CLIENT_INSTANCE}`]: oldSecret },
      randomStart: 0xb0,
    });
    const argv = ["reconnect", "--session", "sess-1"];
    const code = await runSessionControlCli(argv, deps);

    expect(code).toBe(0);
    const newSecret = expectedSecretForByte(0xb0);
    const newHash = hashControlSecretSha256(newSecret);

    expect(client.reconnect).toHaveBeenCalledTimes(1);
    const [, input, presentedSecret] = client.reconnect.mock.calls[0] as [string, Record<string, unknown>, string];
    // Reconnect authenticates the OLD generation and OLD token…
    expect(input.expectedGeneration).toBe(6);
    expect(presentedSecret).toBe(oldSecret);
    // …while the body carries ONLY the new secret's hash.
    expect(input.newTokenHashSha256).toBe(newHash);
    expect(JSON.stringify(input)).not.toContain(newSecret);
    expect(JSON.stringify(input)).not.toContain(oldSecret);

    // The store is rotated to the new secret only after the server confirms.
    expect(memory.snapshot()).toEqual({ [`sess-1::${CLIENT_INSTANCE}`]: newSecret });
    expect(out.join("\n")).toContain(controlTokenFingerprint(newHash));
    assertNoSecretLeak([...out, ...err], argv, [oldSecret, newSecret]);
  });
});

describe("session-control CLI: release", () => {
  it("releases with the stored secret + generation, clears the store, and returns to operator", async () => {
    const secret = "release-secret-DO-NOT-LEAK-2222";
    const { client, memory, out, err, deps } = makeHarness({
      control: externalControl("sess-1", 7, CLIENT_INSTANCE),
      storeSeed: { [`sess-1::${CLIENT_INSTANCE}`]: secret },
    });
    const argv = ["release", "--session", "sess-1"];
    const code = await runSessionControlCli(argv, deps);

    expect(code).toBe(0);
    const [, input, presentedSecret] = client.release.mock.calls[0] as [string, Record<string, unknown>, string];
    expect(input.expectedGeneration).toBe(7);
    expect(presentedSecret).toBe(secret);
    expect(memory.snapshot()).toEqual({});
    assertNoSecretLeak([...out, ...err], argv, [secret]);
  });
});

describe("session-control CLI: ownership guard + errors", () => {
  it("refuses a protocol op when the session is operator-owned", async () => {
    const { client, err, deps } = makeHarness({
      control: operatorControl("sess-1", 1),
      storeSeed: { [`sess-1::${CLIENT_INSTANCE}`]: "some-secret" },
    });
    const code = await runSessionControlCli(["reconnect", "--session", "sess-1"], deps);
    expect(code).toBe(1);
    expect(client.reconnect).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("operator-owned");
  });

  it("refuses a protocol op when another client instance owns the session", async () => {
    const { client, err, deps } = makeHarness({
      control: externalControl("sess-1", 4, "other-client"),
      storeSeed: { [`sess-1::${CLIENT_INSTANCE}`]: "some-secret" },
    });
    const code = await runSessionControlCli(["heartbeat", "--session", "sess-1"], deps);
    expect(code).toBe(1);
    expect(client.heartbeat).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("different client instance");
  });

  it("maps a typed control conflict to a readable message without leaking the secret", async () => {
    const secret = "conflict-secret-DO-NOT-LEAK-3333";
    const { client, err, deps } = makeHarness({
      control: externalControl("sess-1", 5, CLIENT_INSTANCE),
      storeSeed: { [`sess-1::${CLIENT_INSTANCE}`]: secret },
    });
    client.heartbeat.mockRejectedValueOnce(
      new ApiRequestError("API error 409", {
        kind: "http",
        method: "POST",
        path: "/api/v1/chat/sessions/sess-1/control/heartbeat",
        status: 409,
        body: { error: { code: "STATE_CONFLICT", details: { sessionControlCode: "SESSION_CONTROL_STALE" } } },
      }),
    );
    const code = await runSessionControlCli(["heartbeat", "--session", "sess-1"], deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("SESSION_CONTROL_STALE");
    expect(err.join("\n")).not.toContain(secret);
  });

  it("returns a usage code for an unknown command and a missing --session", async () => {
    const unknown = makeHarness({ control: operatorControl("sess-1") });
    expect(await runSessionControlCli(["frobnicate"], unknown.deps)).toBe(2);

    const missing = makeHarness({ control: operatorControl("sess-1") });
    expect(await runSessionControlCli(["status"], missing.deps)).toBe(2);
    expect(missing.err.join("\n")).toContain("--session");
  });
});

describe("session-control CLI: at-rest secret protection", () => {
  it("invokes the injected owner-only protector with the written secret file path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sc-secret-store-"));
    try {
      const protectedPaths: string[] = [];
      const store = createFileSessionControlSecretStore(dir, (filePath) => protectedPaths.push(filePath));
      const ref: SessionControlSecretRef = { sessionId: "sess-x", clientInstanceId: "cli-x" };

      store.save(ref, "at-rest-secret-value");

      // The injectable ACL/permission step ran against the actual secret file…
      expect(protectedPaths).toHaveLength(1);
      const protectedPath = protectedPaths[0] as string;
      expect(protectedPath.startsWith(dir)).toBe(true);
      // …after the plaintext was written, and the store round-trips it.
      expect(readFileSync(protectedPath, "utf8")).toBe("at-rest-secret-value");
      expect(store.load(ref)).toBe("at-rest-secret-value");
      store.clear(ref);
      expect(store.load(ref)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns only when the secret-dir override is outside the home directory", () => {
    const home = process.platform === "win32" ? "C:\\Users\\sc-test-home" : "/home/sc-test-home";
    const inside = path.join(home, ".goatcitadel", "session-control-secrets");
    const outside = process.platform === "win32" ? "C:\\Windows\\Temp\\sc-shared" : "/tmp/sc-shared";

    expect(secretDirLocationWarning(inside, home)).toBeUndefined();
    const warning = secretDirLocationWarning(outside, home);
    expect(warning).toBeDefined();
    expect(warning).toContain("outside your home directory");
    expect(warning).toContain("may not be owner-protected");
  });
});
