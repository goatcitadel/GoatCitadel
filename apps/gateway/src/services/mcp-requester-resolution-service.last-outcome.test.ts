import { describe, expect, it } from "vitest";
import {
  MCP_REQUESTER_SCOPE_LAST_OUTCOME_REGISTRY_LIMIT,
  McpRequesterScopeLastOutcomeRecorder,
  classifyMcpRequesterScopeLastOutcome,
  deriveMcpRequesterScopeOutcomeClassFromInvocationResult,
  isMcpRequesterScopeLastOutcomeClass,
  type McpRequesterScopeLastOutcomeClass,
} from "./mcp-requester-resolution-service.js";

const ALL_CLASSES: McpRequesterScopeLastOutcomeClass[] = [
  "requester_context_missing",
  "requester_context_ambiguous",
  "requester_scope_mismatch",
  "capability_profile_missing",
  "capability_profile_invalid",
  "capability_profile_drift",
  "server_not_callable",
  "resolver_missing",
  "resolver_binding_drift",
  "resolver_timeout",
  "resolver_cancelled",
  "resolver_failed",
  "discovery_output_invalid",
  "discovery_output_too_large",
  "discovery_secret_detected",
  "schema_revalidation_required",
  "schema_revalidation_drift",
  "operation_denied",
  "resolved_connection_invalid",
  "resolved_destination_denied",
  "resolved_header_denied",
  "resolved_connection_expired",
  "connection_generation_revoked",
  "secret_guard_failed",
  "transport_pre_dispatch_failed",
  "transport_outcome_unknown",
  "resolved_ok",
];

describe("classifyMcpRequesterScopeLastOutcome (HX-415 operator diagnostics)", () => {
  it("derives every diagnostic class from the fixed reason-code table alone", () => {
    for (const outcomeClass of ALL_CLASSES) {
      const outcome = classifyMcpRequesterScopeLastOutcome({ serverId: "tenant-mcp", outcomeClass, atMs: 1_000 });
      expect(outcome.serverId).toBe("tenant-mcp");
      expect(outcome.outcomeClass).toBe(outcomeClass);
      expect(outcome.atMs).toBe(1_000);
      expect(["present", "absent"]).toContain(outcome.connectionGenerationClass);
      expect(["within_bounds", "expired", "absent"]).toContain(outcome.expiryClass);
      expect(["allowed", "denied", "not_evaluated"]).toContain(outcome.networkPolicyDecision);
      expect(typeof outcome.profileDrift).toBe("boolean");
      expect(Object.isFrozen(outcome)).toBe(true);
      // Exactly the seven documented secret-free fields — nothing can ride along.
      expect(Object.keys(outcome).sort()).toEqual([
        "atMs",
        "connectionGenerationClass",
        "expiryClass",
        "networkPolicyDecision",
        "outcomeClass",
        "profileDrift",
        "serverId",
      ]);
    }
  });

  it("classifies representative rows exactly as documented", () => {
    expect(classifyMcpRequesterScopeLastOutcome({ serverId: "s", outcomeClass: "resolved_ok", atMs: 5 })).toMatchObject(
      {
        connectionGenerationClass: "present",
        expiryClass: "within_bounds",
        networkPolicyDecision: "allowed",
        profileDrift: false,
      },
    );
    expect(
      classifyMcpRequesterScopeLastOutcome({ serverId: "s", outcomeClass: "requester_context_missing", atMs: 5 }),
    ).toMatchObject({
      connectionGenerationClass: "absent",
      expiryClass: "absent",
      networkPolicyDecision: "not_evaluated",
      profileDrift: false,
    });
    expect(
      classifyMcpRequesterScopeLastOutcome({ serverId: "s", outcomeClass: "resolved_destination_denied", atMs: 5 }),
    ).toMatchObject({
      connectionGenerationClass: "present",
      expiryClass: "within_bounds",
      networkPolicyDecision: "denied",
      profileDrift: false,
    });
    expect(
      classifyMcpRequesterScopeLastOutcome({ serverId: "s", outcomeClass: "resolved_connection_expired", atMs: 5 }),
    ).toMatchObject({
      connectionGenerationClass: "present",
      expiryClass: "expired",
      networkPolicyDecision: "not_evaluated",
      profileDrift: false,
    });
    for (const drifted of [
      "capability_profile_drift",
      "capability_profile_invalid",
      "resolver_binding_drift",
      "requester_scope_mismatch",
      "schema_revalidation_drift",
    ] as const) {
      expect(classifyMcpRequesterScopeLastOutcome({ serverId: "s", outcomeClass: drifted, atMs: 5 }).profileDrift).toBe(
        true,
      );
    }
    // Validation failures of the resolver output never claim a live connection.
    for (const invalid of ["resolved_connection_invalid", "resolved_header_denied", "secret_guard_failed"] as const) {
      expect(classifyMcpRequesterScopeLastOutcome({ serverId: "s", outcomeClass: invalid, atMs: 5 })).toMatchObject({
        connectionGenerationClass: "absent",
        networkPolicyDecision: "not_evaluated",
      });
    }
  });

  it("rejects malformed inputs fail-closed", () => {
    const good = { serverId: "tenant-mcp", outcomeClass: "resolved_ok" as const, atMs: 1 };
    expect(() => classifyMcpRequesterScopeLastOutcome({ ...good, serverId: "" })).toThrow(/context is invalid/);
    expect(() => classifyMcpRequesterScopeLastOutcome({ ...good, serverId: "has space" })).toThrow(
      /context is invalid/,
    );
    expect(() => classifyMcpRequesterScopeLastOutcome({ ...good, outcomeClass: "endpoint_leak" as never })).toThrow(
      /context is invalid/,
    );
    // Prototype-key smuggling can never become an outcome class.
    expect(() => classifyMcpRequesterScopeLastOutcome({ ...good, outcomeClass: "toString" as never })).toThrow(
      /context is invalid/,
    );
    expect(() => classifyMcpRequesterScopeLastOutcome({ ...good, atMs: -1 })).toThrow(/context is invalid/);
    expect(() => classifyMcpRequesterScopeLastOutcome({ ...good, atMs: 1.5 })).toThrow(/context is invalid/);
    expect(() => classifyMcpRequesterScopeLastOutcome({ ...good, extra: "field" } as never)).toThrow(
      /context is invalid/,
    );
  });

  it("exposes the membership check used by the result derivation", () => {
    for (const outcomeClass of ALL_CLASSES) expect(isMcpRequesterScopeLastOutcomeClass(outcomeClass)).toBe(true);
    expect(isMcpRequesterScopeLastOutcomeClass("resolved")).toBe(false);
    expect(isMcpRequesterScopeLastOutcomeClass("toString")).toBe(false);
    expect(isMcpRequesterScopeLastOutcomeClass(undefined)).toBe(false);
    expect(isMcpRequesterScopeLastOutcomeClass(7)).toBe(false);
  });
});

describe("deriveMcpRequesterScopeOutcomeClassFromInvocationResult", () => {
  it("maps success, coded failures, and phase catch-alls onto the taxonomy", () => {
    expect(deriveMcpRequesterScopeOutcomeClassFromInvocationResult({ ok: true })).toBe("resolved_ok");
    expect(
      deriveMcpRequesterScopeOutcomeClassFromInvocationResult({
        ok: false,
        output: { requesterScoped: true, reasonCode: "resolver_timeout" },
        failurePhase: "pre_dispatch",
      }),
    ).toBe("resolver_timeout");
    expect(deriveMcpRequesterScopeOutcomeClassFromInvocationResult({ ok: false, failurePhase: "post_dispatch" })).toBe(
      "transport_outcome_unknown",
    );
    expect(deriveMcpRequesterScopeOutcomeClassFromInvocationResult({ ok: false })).toBe(
      "transport_pre_dispatch_failed",
    );
  });

  it("never trusts a forged or non-taxonomy reason code", () => {
    expect(
      deriveMcpRequesterScopeOutcomeClassFromInvocationResult({
        ok: false,
        output: { requesterScoped: true, reasonCode: "https://leak.example.test/?token=oops" },
        failurePhase: "pre_dispatch",
      }),
    ).toBe("transport_pre_dispatch_failed");
    // `resolved_ok` is recorder vocabulary, never a failure code from a result.
    expect(
      deriveMcpRequesterScopeOutcomeClassFromInvocationResult({
        ok: false,
        output: { requesterScoped: true, reasonCode: "resolved_ok" },
      }),
    ).toBe("transport_pre_dispatch_failed");
    // A non-requester-scoped output shape is ignored entirely.
    expect(
      deriveMcpRequesterScopeOutcomeClassFromInvocationResult({
        ok: false,
        output: { reasonCode: "resolver_timeout" },
      }),
    ).toBe("transport_pre_dispatch_failed");
    expect(
      deriveMcpRequesterScopeOutcomeClassFromInvocationResult({
        ok: false,
        output: undefined,
        failurePhase: undefined,
      }),
    ).toBe("transport_pre_dispatch_failed");
  });
});

describe("McpRequesterScopeLastOutcomeRecorder", () => {
  it("round-trips frozen copies per server and misses as undefined", () => {
    const recorder = new McpRequesterScopeLastOutcomeRecorder();
    recorder.recordLastOutcome({ serverId: "tenant-mcp", outcomeClass: "resolver_failed", atMs: 10 });
    const first = recorder.loadLastOutcome("tenant-mcp");
    expect(first).toMatchObject({
      serverId: "tenant-mcp",
      outcomeClass: "resolver_failed",
      atMs: 10,
      connectionGenerationClass: "absent",
      expiryClass: "absent",
      networkPolicyDecision: "not_evaluated",
      profileDrift: false,
    });
    expect(Object.isFrozen(first)).toBe(true);
    const second = recorder.loadLastOutcome("tenant-mcp");
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(recorder.loadLastOutcome("other")).toBeUndefined();
    expect(recorder.loadLastOutcome("not a canonical id")).toBeUndefined();
  });

  it("replaces the same server in place and keeps only the newest outcome", () => {
    const recorder = new McpRequesterScopeLastOutcomeRecorder();
    recorder.recordLastOutcome({ serverId: "tenant-mcp", outcomeClass: "resolver_failed", atMs: 10 });
    recorder.recordLastOutcome({ serverId: "tenant-mcp", outcomeClass: "resolved_ok", atMs: 20 });
    expect(recorder.loadLastOutcome("tenant-mcp")).toMatchObject({
      outcomeClass: "resolved_ok",
      atMs: 20,
      connectionGenerationClass: "present",
    });
  });

  it("evicts oldest-first at the documented cap", () => {
    const recorder = new McpRequesterScopeLastOutcomeRecorder();
    for (let index = 0; index < MCP_REQUESTER_SCOPE_LAST_OUTCOME_REGISTRY_LIMIT; index += 1) {
      recorder.recordLastOutcome({ serverId: `server-${index}`, outcomeClass: "resolved_ok", atMs: index });
    }
    // Touch server-0 so it becomes newest; server-1 is then the eviction victim.
    recorder.recordLastOutcome({ serverId: "server-0", outcomeClass: "resolver_failed", atMs: 999 });
    recorder.recordLastOutcome({ serverId: "overflow", outcomeClass: "resolved_ok", atMs: 1_000 });
    expect(recorder.loadLastOutcome("server-1")).toBeUndefined();
    expect(recorder.loadLastOutcome("server-0")).toMatchObject({ outcomeClass: "resolver_failed" });
    expect(recorder.loadLastOutcome("overflow")).toMatchObject({ outcomeClass: "resolved_ok" });
  });

  it("rejects malformed records fail-closed without storing anything", () => {
    const recorder = new McpRequesterScopeLastOutcomeRecorder();
    expect(() => recorder.recordLastOutcome({ serverId: "bad id", outcomeClass: "resolved_ok", atMs: 1 })).toThrow(
      /context is invalid/,
    );
    expect(() =>
      recorder.recordLastOutcome({ serverId: "tenant-mcp", outcomeClass: "https://x" as never, atMs: 1 }),
    ).toThrow(/context is invalid/);
    expect(recorder.loadLastOutcome("tenant-mcp")).toBeUndefined();
  });
});
