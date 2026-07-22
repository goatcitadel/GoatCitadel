import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChatTurnCapabilityProfileRecord } from "@goatcitadel/contracts";
import {
  MCP_REQUESTER_COMPOSITION_STATIC_GENERATIONS,
  buildMcpRequesterScopedTurnContextFromCapabilityProfile,
  createMcpRequesterScopedTurnContext,
  readMcpRequesterScopedTurnContext,
  type McpRequesterScopedToolCallTurnContext,
} from "./mcp-requester-resolution-service.js";

function validContextInput(): McpRequesterScopedToolCallTurnContext {
  return {
    profileId: "chat-capability-profile-turn-1",
    finalProfileSha256: "a".repeat(64),
    turnId: "turn-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    actorId: "operator-1",
    actorSource: "token",
    baseCallableCatalogSha256: "b".repeat(64),
    finalCallableCatalogSha256: "c".repeat(64),
    callableCatalogSnapshotId: "chat-cap-snap-1",
    globalNetworkPolicyGeneration: 1,
    authConnectionGeneration: 1,
    turnGeneration: 1,
    preparationGeneration: 1,
  };
}

function profileRecord(overrides: {
  authActorId?: string | undefined;
  authActorSource?: string | undefined;
}): Pick<ChatTurnCapabilityProfileRecord, "profileId" | "identity" | "catalog" | "hashes"> {
  return {
    profileId: "chat-capability-profile-turn-1",
    identity: {
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      citadelId: "citadel-1",
      ...(overrides.authActorId === undefined ? {} : { authActorId: overrides.authActorId }),
      ...(overrides.authActorSource === undefined ? {} : { authActorSource: overrides.authActorSource as "token" }),
    },
    catalog: {
      snapshotId: "chat-cap-snap-1",
      inspectableHash: "d".repeat(64),
      callableHash: "e".repeat(64),
      inspectableCount: 1,
      callableCount: 1,
    },
    hashes: {
      identityHash: "1".repeat(64),
      sourceHash: "2".repeat(64),
      catalogHash: "3".repeat(64),
      selectionHash: "4".repeat(64),
      governanceHash: "5".repeat(64),
      profileHash: "f".repeat(64),
    },
  };
}

describe("McpRequesterScopedTurnContextHandle (HX-415 slice 7d)", () => {
  it("round-trips a validated context through the brand-checked reader", () => {
    const input = validContextInput();
    const handle = createMcpRequesterScopedTurnContext(input);
    expect(Object.isFrozen(handle)).toBe(true);
    const read = readMcpRequesterScopedTurnContext(handle);
    expect(read).toEqual(input);
    // Fresh copy per read: mutating one read never affects the stored value.
    (read as { actorId: string }).actorId = "mutated";
    expect(readMcpRequesterScopedTurnContext(handle)).toEqual(input);
  });

  it("is non-serializable: toJSON and JSON.stringify both throw", () => {
    const handle = createMcpRequesterScopedTurnContext(validContextInput());
    expect(() => handle.toJSON()).toThrowError(expect.objectContaining({ code: "requester_context_ambiguous" }));
    expect(() => JSON.stringify(handle)).toThrowError(expect.objectContaining({ code: "requester_context_ambiguous" }));
  });

  it("rejects forged plain objects, prototype tricks, and null at the reader", () => {
    const forged = { ...validContextInput(), toJSON: () => undefined };
    expect(readMcpRequesterScopedTurnContext(forged)).toBeUndefined();
    expect(readMcpRequesterScopedTurnContext(undefined)).toBeUndefined();
    expect(readMcpRequesterScopedTurnContext(null)).toBeUndefined();
    expect(readMcpRequesterScopedTurnContext("context")).toBeUndefined();
    const reparented = Object.create(
      Object.getPrototypeOf(createMcpRequesterScopedTurnContext(validContextInput())) as object,
    ) as unknown;
    expect(readMcpRequesterScopedTurnContext(reparented)).toBeUndefined();
  });

  it("fails closed on malformed construction input", () => {
    const expectRejected = (mutate: (input: Record<string, unknown>) => void): void => {
      const input = validContextInput() as unknown as Record<string, unknown>;
      mutate(input);
      expect(() => createMcpRequesterScopedTurnContext(input as never)).toThrowError(
        expect.objectContaining({ code: "requester_context_ambiguous" }),
      );
    };
    expectRejected((input) => delete input.profileId);
    expectRejected((input) => {
      input.extra = true;
    });
    expectRejected((input) => {
      input.finalProfileSha256 = "NOT-A-SHA";
    });
    expectRejected((input) => {
      input.actorSource = "none";
    });
    expectRejected((input) => {
      input.actorSource = "sse";
    });
    expectRejected((input) => {
      input.actorId = "with space";
    });
    expectRejected((input) => {
      input.turnGeneration = 0;
    });
    expectRejected((input) => {
      input.preparationGeneration = 1.5;
    });
  });

  it("builds the context from a frozen capability-profile record with the documented composition generations", () => {
    const handle = buildMcpRequesterScopedTurnContextFromCapabilityProfile(
      profileRecord({ authActorId: "operator-1", authActorSource: "token" }),
    );
    expect(handle).toBeDefined();
    const read = readMcpRequesterScopedTurnContext(handle);
    expect(read).toEqual({
      profileId: "chat-capability-profile-turn-1",
      finalProfileSha256: "f".repeat(64),
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      actorSource: "token",
      baseCallableCatalogSha256: "e".repeat(64),
      finalCallableCatalogSha256: "e".repeat(64),
      callableCatalogSnapshotId: "chat-cap-snap-1",
      ...MCP_REQUESTER_COMPOSITION_STATIC_GENERATIONS,
    });
  });

  it("returns undefined for profiles without a requester-scope actor (none/sse/a2a_peer/missing)", () => {
    for (const identity of [
      { authActorId: undefined, authActorSource: undefined },
      { authActorId: "operator-1", authActorSource: "none" },
      { authActorId: "operator-1", authActorSource: "sse" },
      { authActorId: "operator-1", authActorSource: "a2a_peer" },
      { authActorId: undefined, authActorSource: "token" },
    ]) {
      expect(buildMcpRequesterScopedTurnContextFromCapabilityProfile(profileRecord(identity))).toBeUndefined();
    }
  });

  it("returns undefined instead of throwing for a malformed profile record", () => {
    const malformed = profileRecord({ authActorId: "operator-1", authActorSource: "token" });
    (malformed.hashes as { profileHash: string }).profileHash = "NOT-A-SHA";
    expect(buildMcpRequesterScopedTurnContextFromCapabilityProfile(malformed)).toBeUndefined();
  });

  it("keeps turn-context construction scoped to the runner, the gateway composition, and the definition site", () => {
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    const inventory = listProductionTypeScriptSources(sourceRoot).map((filePath) => ({
      relativePath: relative(sourceRoot, filePath).replaceAll("\\", "/"),
      content: readFileSync(filePath, "utf8"),
    }));
    expect(inventory.length).toBeGreaterThan(0);
    expect(() => assertTurnContextConstructionScoped(inventory)).not.toThrow();
    // The guard itself must fail when a disallowed production file gains a call.
    expect(() =>
      assertTurnContextConstructionScoped([
        ...inventory,
        {
          relativePath: "routes/mcp.ts",
          content: "createMcpRequesterScopedTurnContext({} as never);",
        },
      ]),
    ).toThrow(/routes\/mcp\.ts/u);
    expect(() =>
      assertTurnContextConstructionScoped([
        ...inventory,
        {
          relativePath: "services/gateway-service.ts",
          content: "buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile);",
        },
      ]),
    ).not.toThrow();
  });
});

const TURN_CONTEXT_DEFINITION_SITE = "services/mcp-requester-resolution-service.ts";
const TURN_CONTEXT_ALLOWED_CALL_SITES = new Set(["services/chat-turn-agent-runner.ts", "services/gateway-service.ts"]);

function assertTurnContextConstructionScoped(
  inventory: ReadonlyArray<{ relativePath: string; content: string }>,
): void {
  for (const callToken of [
    "createMcpRequesterScopedTurnContext(",
    "buildMcpRequesterScopedTurnContextFromCapabilityProfile(",
  ]) {
    for (const file of inventory) {
      if (file.relativePath === TURN_CONTEXT_DEFINITION_SITE) continue;
      if (!file.content.includes(callToken)) continue;
      if (!TURN_CONTEXT_ALLOWED_CALL_SITES.has(file.relativePath)) {
        throw new Error(`Requester turn-context construction leaked into ${file.relativePath} via ${callToken})`);
      }
    }
  }
}

function listProductionTypeScriptSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return listProductionTypeScriptSources(fullPath);
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".vitest.ts") ||
      entry.name.endsWith(".d.ts")
    ) {
      return [];
    }
    return [fullPath];
  });
}
