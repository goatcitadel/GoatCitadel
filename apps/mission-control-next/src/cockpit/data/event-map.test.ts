import { describe, expect, it } from "vitest";
import type { RealtimeEvent, RealtimeEventType } from "@goatcitadel/contracts";
import { resolveRealtimeEvent } from "./event-map";
import { queryKeys, SETTINGS_READER_KEYS } from "./query-keys";

function event(eventType: string, source: string, extra: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    eventId: `e-${eventType}-${source}`,
    sequence: 1,
    eventType,
    source,
    timestamp: "2026-10-05T10:00:00.000Z",
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    payload: {},
    ...extra,
  };
}

describe("resolveRealtimeEvent", () => {
  it("never derives the removed catch-all surface topic", () => {
    const result = resolveRealtimeEvent(event("guidance_updated", "system"));
    expect(JSON.stringify(result)).not.toContain('"surface"');
    const unknown = resolveRealtimeEvent(event("dashboard_layout_shifted", "brand_new_owner"));
    expect(JSON.stringify(unknown)).not.toContain('"surface"');
  });

  it("refreshes only the health readers for llama.cpp status and lifecycle", () => {
    for (const type of ["llamacpp_refreshed", "llamacpp_started", "llamacpp_exited"]) {
      expect(resolveRealtimeEvent(event(type, "llamacpp"))).toEqual({
        kind: "mapped",
        effect: { keys: [queryKeys.healthAll()], refresh: ["llamaCpp"] },
      });
    }
  });

  it("reads the llama.cpp route signals that name their type in the payload", () => {
    expect(resolveRealtimeEvent(event("system", "llamacpp", { payload: { type: "llamacpp_refreshed" } }))).toEqual({
      kind: "mapped",
      effect: { keys: [queryKeys.healthAll()], refresh: ["llamaCpp"] },
    });
  });

  it("allowlists llama.cpp: an unknown future llamacpp_* type is unmapped, not a health refresh (T3-M1)", () => {
    expect(resolveRealtimeEvent(event("llamacpp_tokenizer_warmup", "llamacpp")).kind).toBe("unmapped");
    expect(resolveRealtimeEvent(event("llamacpp_stderr", "llamacpp")).kind).toBe("ignored");
    expect(resolveRealtimeEvent(event("llamacpp_stdout", "llamacpp")).kind).toBe("ignored");
  });

  it("ignores durable-history replays and high-frequency signals", () => {
    expect(resolveRealtimeEvent(event("chat_message", "chat", { eventAuthority: "durable_history" })).kind).toBe(
      "ignored",
    );
    expect(resolveRealtimeEvent(event("mobile_capability_heartbeat", "mobile")).kind).toBe("ignored");
    expect(resolveRealtimeEvent(event("proactive_tick_started", "chat")).kind).toBe("ignored");
    expect(resolveRealtimeEvent(event("proactive_no_action", "chat")).kind).toBe("ignored");
  });

  it("maps chat events to the chat readers and the chat refresh topic", () => {
    expect(resolveRealtimeEvent(event("chat_thread_updated", "chat"))).toEqual({
      kind: "mapped",
      effect: { keys: [["chat"]], refresh: ["chat"] },
    });
  });

  it("signals Chat for an approval tied to a conversation, so the rail status follows it", () => {
    expect(
      resolveRealtimeEvent(event("approval_created", "approvals", { links: { sessionId: "s-1", approvalId: "a-1" } })),
    ).toEqual({ kind: "mapped", effect: { keys: [["approvals"]], refresh: ["approvals", "chat"] } });
    expect(resolveRealtimeEvent(event("approval_resolved", "approvals", { links: { approvalId: "a-1" } }))).toEqual({
      kind: "mapped",
      effect: { keys: [["approvals"]], refresh: ["approvals"] },
    });
  });

  it("refreshes every settings reader when a runtime settings change plan moves", () => {
    for (const targetOwnerId of ["runtime_settings", "runtime_settings.llm_defaults"]) {
      const result = resolveRealtimeEvent(
        event("change_plan.completed", "evolution_control_plane", { payload: { targetOwnerId, planId: "p-1" } }),
      );
      expect(result.kind).toBe("mapped");
      const keys = result.kind === "mapped" ? result.effect.keys : [];
      for (const key of SETTINGS_READER_KEYS) expect(keys).toContainEqual(key);
      expect(keys).toContainEqual(queryKeys.inboxAll());
    }
    const other = resolveRealtimeEvent(
      event("change_plan.completed", "evolution_control_plane", { payload: { targetOwnerId: "runtime_settings_x" } }),
    );
    expect(other).toEqual({
      kind: "mapped",
      effect: { keys: [queryKeys.inboxAll(), ["change-plan"]], refresh: ["approvals"] },
    });
  });

  it("maps workspace lifecycle under system to the directory readers only", () => {
    expect(resolveRealtimeEvent(event("workspace_updated", "system"))).toEqual({
      kind: "mapped",
      effect: {
        keys: [
          queryKeys.directory(),
          ["settings", "workspaces"],
          ["settings", "workspace-citadels"],
          ["settings", "citadels"],
        ],
        refresh: ["system"],
      },
    });
  });

  it("maps owner signals that feed the Inbox to their owner and the Inbox", () => {
    const memory = resolveRealtimeEvent(event("system", "memory", { payload: { type: "memory_item_lifecycle" } }));
    expect(memory).toEqual({
      kind: "mapped",
      effect: {
        keys: [queryKeys.memory(), ["library", "resources", "memory"], queryKeys.inboxAll()],
        refresh: ["memory"],
      },
    });
  });

  it("does not refresh catalogs or grants for a tool call inside a turn", () => {
    expect(resolveRealtimeEvent(event("tool_invoked", "policy"))).toEqual({
      kind: "mapped",
      effect: { keys: [], refresh: ["tools"] },
    });
  });

  it("returns the keyword topics for an unknown source, without a default topic", () => {
    const result = resolveRealtimeEvent(event("brand_new_signal", "brand_new_owner", { links: { taskId: "t-1" } }));
    expect(result).toEqual({ kind: "unmapped", topics: ["tasks"] });
  });

  it("does not treat inherited object names as rules", () => {
    expect(resolveRealtimeEvent(event("toString", "constructor")).kind).toBe("unmapped");
    expect(resolveRealtimeEvent(event("constructor", "system")).kind).toBe("unmapped");
  });

  it("replay gaps refresh every owner", () => {
    const result = resolveRealtimeEvent(event("replay_gap", "gateway", { payload: { kind: "replay_gap" } }));
    expect(result.kind).toBe("mapped");
    if (result.kind === "mapped") expect(result.effect.keys).toContainEqual(["chat"]);
  });
});

/** Rule 3: every contract event type is mapped or explicitly ignored. Canonical source per type. */
const CONTRACT_EVENT_SOURCES = {
  session_event: "gateway",
  tool_invoked: "mcp",
  approval_created: "approvals",
  approval_resolved: "approvals",
  approval_explained: "approvals",
  auth_device_request_created: "auth",
  auth_device_request_resolved: "auth",
  task_created: "tasks",
  task_updated: "tasks",
  task_deleted: "tasks",
  activity_logged: "tasks",
  deliverable_added: "tasks",
  subagent_registered: "tasks",
  subagent_updated: "tasks",
  orchestration_event: "orchestration",
  remote_worker_changed: "remote_workers",
  remote_worker_assignment_changed: "remote_workers",
  system: "system",
} as const satisfies Record<RealtimeEventType, string>;

describe("contract event types", () => {
  it.each(Object.entries(CONTRACT_EVENT_SOURCES))("%s is mapped or ignored", (type, source) => {
    expect(resolveRealtimeEvent(event(type, source)).kind).not.toBe("unmapped");
  });
});
