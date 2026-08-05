import { describe, expect, it } from "vitest";
import type { CitadelWard } from "@goatcitadel/contracts";
import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import {
  buildA2AOutboundWardAction,
  buildIntegrationWardAction,
  resolveWardEffectForExternalAction,
} from "./citadel-ward-gate.js";

function ward(actionPattern: string, effect: CitadelWard["effect"]): CitadelWard {
  return { actionPattern, effect } as CitadelWard;
}

describe("ward action name builders", () => {
  it("builds integration action names from catalog + action ids", () => {
    expect(buildIntegrationWardAction("automation.gmail", "write")).toBe("integration.automation.gmail.write");
    expect(buildIntegrationWardAction("productivity.trello", "write")).toBe("integration.productivity.trello.write");
  });

  it("builds a2a outbound names with normalized method segments", () => {
    expect(buildA2AOutboundWardAction("jsonrpc", "message/send")).toBe("a2a.outbound.jsonrpc.message.send");
    expect(buildA2AOutboundWardAction("grpc", "tasks/get")).toBe("a2a.outbound.grpc.tasks.get");
    expect(buildA2AOutboundWardAction("jsonrpc")).toBe("a2a.outbound.jsonrpc");
    expect(buildA2AOutboundWardAction("push")).toBe("a2a.outbound.push");
  });
});

describe("resolveWardEffectForExternalAction", () => {
  it("resolves the workspace's citadel and returns a matching ward effect", async () => {
    const result = await resolveWardEffectForExternalAction({
      storage: {
        workspaces: { find: (id) => (id === "ws-1" ? { citadelId: "citadel-ops" } : undefined) },
        citadels: {
          listWards: (citadelId) =>
            citadelId === "citadel-ops" ? [ward("integration.automation.gmail.*", "require_dry_run")] : [],
        },
      },
      workspaceId: "ws-1",
      action: "integration.automation.gmail.write",
    });
    expect(result).toEqual({ effect: "require_dry_run", citadelId: "citadel-ops" });
  });

  it("falls back to the personal citadel when unbound or unresolvable", async () => {
    const listWards = (citadelId: string) => (citadelId === DEFAULT_CITADEL_ID ? [ward("a2a.outbound.*", "deny")] : []);

    expect(
      await resolveWardEffectForExternalAction({
        storage: { citadels: { listWards } },
        action: "a2a.outbound.jsonrpc.message.send",
      }),
    ).toEqual({ effect: "deny", citadelId: DEFAULT_CITADEL_ID });

    expect(
      await resolveWardEffectForExternalAction({
        storage: { workspaces: { find: () => undefined }, citadels: { listWards } },
        workspaceId: "ws-unknown",
        action: "a2a.outbound.push",
      }),
    ).toEqual({ effect: "deny", citadelId: DEFAULT_CITADEL_ID });
  });

  it("collapses allow and no-match to undefined, and inherits deny-wins precedence", async () => {
    const storage = {
      citadels: {
        listWards: () => [ward("integration.*", "allow"), ward("integration.automation.gmail.*", "deny")],
      },
    };
    expect(
      (await resolveWardEffectForExternalAction({ storage, action: "integration.automation.gmail.write" })).effect,
    ).toBe("deny");
    expect(
      (await resolveWardEffectForExternalAction({ storage, action: "integration.productivity.trello.write" })).effect,
    ).toBeUndefined();
    expect(
      (
        await resolveWardEffectForExternalAction({
          storage: { citadels: { listWards: () => [] } },
          action: "integration.automation.gmail.write",
        })
      ).effect,
    ).toBeUndefined();
  });

  it("imposes nothing when the host has no ward storage members", async () => {
    expect(
      await resolveWardEffectForExternalAction({ storage: {}, action: "integration.automation.gmail.write" }),
    ).toEqual({
      effect: undefined,
      citadelId: DEFAULT_CITADEL_ID,
    });
  });
});
