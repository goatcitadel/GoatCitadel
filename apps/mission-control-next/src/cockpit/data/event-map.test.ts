import { describe, expect, it } from "vitest";
import type { RealtimeEvent, RealtimeEventType } from "@goatcitadel/contracts";
import { deriveRealtimeRefresh } from "@goatcitadel/mission-control-shared/state/realtime-derived";
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

  describe("Messaging overview", () => {
    const messagingKey = queryKeys.chatMessaging("default");
    const refreshesMessaging = (candidate: RealtimeEvent) => {
      const result = resolveRealtimeEvent(candidate);
      return (
        result.kind === "mapped" &&
        result.effect.keys.some(
          (prefix) => prefix.length <= messagingKey.length && prefix.every((part, i) => part === messagingKey[i]),
        )
      );
    };

    it("is keyed by workspace under the chat topic", () => {
      expect(messagingKey).toEqual(["chat", "messaging", "default"]);
    });

    // The Gateway publishes a connection change as a "system" event from the integrations source and names the
    // real signal in payload.type, as in integration-channel-service.ts.
    it.each(["integration_connection_created", "integration_connection_updated", "integration_connection_deleted"])(
      "refreshes when a connection changes (%s), so a channel's status and the channel list follow Settings",
      (type) => {
        expect(refreshesMessaging(event("system", "integrations", { payload: { type } }))).toBe(true);
      },
    );

    it("refreshes when a message arrives from a channel, which changes a conversation's time and new-message count", () => {
      expect(refreshesMessaging(event("system", "channels", { payload: { type: "channel_message_ingested" } }))).toBe(
        true,
      );
    });

    it("refreshes when a conversation updates", () => {
      expect(refreshesMessaging(event("chat_thread_updated", "chat"))).toBe(true);
    });

    it("leaves other owners alone", () => {
      expect(refreshesMessaging(event("system", "memory", { payload: { type: "memory_item_lifecycle" } }))).toBe(false);
      expect(refreshesMessaging(event("system", "hooks", { payload: { type: "hook_updated" } }))).toBe(false);
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

  it("refreshes the Capabilities connector list for MCP, integration and channel events", () => {
    const prefix = ["mcp", "capability-connectors"];
    for (const [type, source] of [
      ["mcp_server_updated", "mcp"],
      ["integration_connection_updated", "integrations"],
      ["channel_updated", "channels"],
    ] as const) {
      const result = resolveRealtimeEvent(event(type, source));
      expect(result.kind).toBe("mapped");
      const keys = result.kind === "mapped" ? result.effect.keys : [];
      expect(keys).toContainEqual(prefix);
    }
    // The prefix covers the per-workspace key, so a change refreshes whichever workspace is open.
    expect(queryKeys.capabilityConnectors("ws-1").slice(0, 2)).toEqual(prefix);
    // An MCP event also refreshes what a connector panel reads about a saved server: its tools and its record.
    const mcpEvent = resolveRealtimeEvent(event("mcp_server_updated", "mcp"));
    const mcpKeys = mcpEvent.kind === "mapped" ? mcpEvent.effect.keys : [];
    for (const key of [queryKeys.capabilityConnectorTools("s-1"), queryKeys.capabilityConnectorServer("s-1")]) {
      expect(mcpKeys).toContainEqual(key.slice(0, 2));
    }
    // A tool call changes no connector.
    const call = resolveRealtimeEvent(event("tool_invoked", "mcp"));
    expect(call).toEqual({ kind: "mapped", effect: { keys: [], refresh: ["mcp"] } });
  });

  it("refreshes the connector list when a runtime settings change plan moves, for web search and Chat access", () => {
    // Firecrawl and Brave state, and whether Chat can reach MCP, are read from the settings.
    expect(SETTINGS_READER_KEYS).toContainEqual(["mcp", "capability-connectors"]);
  });

  it("refreshes the tool list when tool rules change, and no tool or policy event re-reads the call counts", () => {
    const prefix = ["tools", "capability-tools"];
    // The prefix covers the per-workspace key, so a change refreshes whichever workspace is open.
    expect(queryKeys.capabilityTools("ws-1").slice(0, 2)).toEqual(prefix);
    expect(queryKeys.capabilityToolUsage().slice(0, 2)).toEqual(["tools", "capability-tool-usage"]);
    // A grant, a profile or a Citadel Ward change comes from the tools and policy owners.
    for (const source of ["tools", "policy"]) {
      const result = resolveRealtimeEvent(event("tool_grant_updated", source));
      expect(result.kind).toBe("mapped");
      const keys = result.kind === "mapped" ? result.effect.keys : [];
      expect(keys).toContainEqual(prefix);
      // These events name the list's prefix, not the counts' key and not the whole `tools` topic.
      expect(keys).not.toContainEqual(queryKeys.capabilityToolUsage());
      expect(keys).not.toContainEqual(["tools"]);
    }
    // A replay gap is the one event that re-reads the whole `tools` topic, counts included.
    const gap = resolveRealtimeEvent(event("replay_gap", "gateway", { payload: { kind: "replay_gap" } }));
    expect(gap.kind === "mapped" ? gap.effect.keys : []).toContainEqual(["tools"]);
    // A tool call inside a turn changes no rule, so it refreshes nothing.
    expect(resolveRealtimeEvent(event("tool_invoked", "tools"))).toEqual({
      kind: "mapped",
      effect: { keys: [], refresh: ["tools"] },
    });
  });

  it("refreshes the tool list when a runtime settings change plan moves, because a switch saves through Settings", () => {
    // A group's switch is a Settings change plan, so its settling re-reads the list that shows the switch.
    expect(SETTINGS_READER_KEYS).toContainEqual(["tools", "capability-tools"]);
    const result = resolveRealtimeEvent(
      event("change_plan.completed", "evolution_control_plane", {
        payload: { targetOwnerId: "runtime_settings", planId: "p-1" },
      }),
    );
    const keys = result.kind === "mapped" ? result.effect.keys : [];
    expect(keys).toContainEqual(["tools", "capability-tools"]);
    // Other change plans leave the list alone.
    const other = resolveRealtimeEvent(
      event("change_plan.completed", "evolution_control_plane", { payload: { targetOwnerId: "workspace_config" } }),
    );
    const otherKeys = other.kind === "mapped" ? other.effect.keys : [];
    expect(otherKeys).not.toContainEqual(["tools", "capability-tools"]);
  });

  it("refreshes the skill list and details when a skill change applies, and no event re-reads the use counts", () => {
    const listPrefix = ["skills", "capability-skills"];
    const detailPrefix = ["skills", "capability-skill-detail"];
    // The prefixes cover the per-workspace list and the per-skill details, so a change refreshes whichever is open.
    expect(queryKeys.capabilitySkills("ws-1").slice(0, 2)).toEqual(listPrefix);
    expect(queryKeys.capabilitySkillDetail("ws-1", "s-1").slice(0, 2)).toEqual(detailPrefix);
    expect(queryKeys.capabilitySkillUsage().slice(0, 2)).toEqual(["skills", "capability-skill-usage"]);
    // The Gateway publishes both skill events with source `skills`: a switch asking for approval, and a change applying.
    for (const type of ["skill_mutation_approval_requested", "skill_state_mutation_applied"]) {
      const result = resolveRealtimeEvent(event(type, "skills"));
      expect(result.kind).toBe("mapped");
      const keys = result.kind === "mapped" ? result.effect.keys : [];
      expect(keys).toContainEqual(listPrefix);
      expect(keys).toContainEqual(detailPrefix);
      // These events name the prefixes, not the use counts' key and not the whole `skills` topic.
      expect(keys).not.toContainEqual(queryKeys.capabilitySkillUsage());
      expect(keys).not.toContainEqual(["skills"]);
    }
    // The curator and capability owners move candidates and proposals, which the list's waiting count reads.
    for (const source of ["curator", "capabilities"]) {
      const result = resolveRealtimeEvent(event("capability_updated", source));
      const keys = result.kind === "mapped" ? result.effect.keys : [];
      expect(keys).toContainEqual(listPrefix);
      expect(keys).toContainEqual(detailPrefix);
      expect(keys).not.toContainEqual(queryKeys.capabilitySkillUsage());
    }
    // A replay gap is the one event that re-reads the whole `skills` topic, use counts included.
    const gap = resolveRealtimeEvent(event("replay_gap", "gateway", { payload: { kind: "replay_gap" } }));
    expect(gap.kind === "mapped" ? gap.effect.keys : []).toContainEqual(["skills"]);
  });

  it("refreshes Discover and the installs when a skill change applies, because both sit under the skills topic", () => {
    const discoverPrefix = ["skills", "capability-skill-discover"];
    const installsPrefix = ["skills", "capability-skill-installs"];
    // Each workspace's and each search term's read shares its prefix, so one event refreshes whichever is open.
    expect(queryKeys.capabilitySkillDiscover("ws-1", "pdf").slice(0, 2)).toEqual(discoverPrefix);
    expect(queryKeys.capabilitySkillInstalls("ws-1").slice(0, 2)).toEqual(installsPrefix);
    for (const type of ["skill_mutation_approval_requested", "skill_state_mutation_applied"]) {
      const result = resolveRealtimeEvent(event(type, "skills"));
      const keys = result.kind === "mapped" ? result.effect.keys : [];
      expect(keys).toContainEqual(discoverPrefix);
      expect(keys).toContainEqual(installsPrefix);
      // Not the whole topic: the use counts keep their own key.
      expect(keys).not.toContainEqual(["skills"]);
    }
    // A replay gap re-reads the whole `skills` topic, so it reaches both too.
    const gap = resolveRealtimeEvent(event("replay_gap", "gateway", { payload: { kind: "replay_gap" } }));
    expect(gap.kind === "mapped" ? gap.effect.keys : []).toContainEqual(["skills"]);
  });

  it("refreshes the Inbox when a skill change asks for approval or applies, because it waits in every workspace's Inbox", () => {
    // A skill approval publishes no `approvals` event when it is made, only the `skills` one.
    for (const type of ["skill_mutation_approval_requested", "skill_state_mutation_applied"]) {
      const result = resolveRealtimeEvent(event(type, "skills"));
      const keys = result.kind === "mapped" ? result.effect.keys : [];
      expect(keys).toContainEqual(queryKeys.inboxAll());
    }
  });

  it("leaves the approvals rule alone: a resolved approval re-reads only the approval queries", () => {
    // A declined skill approval publishes no skills event, so the switch hook's own poll covers that case.
    expect(resolveRealtimeEvent(event("approval_resolved", "approvals", { links: { approvalId: "a-1" } }))).toEqual({
      kind: "mapped",
      effect: { keys: [["approvals"]], refresh: ["approvals"] },
    });
  });

  it("refreshes the skill list when a runtime settings change plan moves, because the skip setting decides the switch", () => {
    // `operatorApprovalSkip` is read from the settings, so its change re-reads the list that carries it.
    expect(SETTINGS_READER_KEYS).toContainEqual(["skills", "capability-skills"]);
    const result = resolveRealtimeEvent(
      event("change_plan.completed", "evolution_control_plane", {
        payload: { targetOwnerId: "runtime_settings", planId: "p-1" },
      }),
    );
    const keys = result.kind === "mapped" ? result.effect.keys : [];
    expect(keys).toContainEqual(["skills", "capability-skills"]);
    // Other change plans leave the list alone.
    const other = resolveRealtimeEvent(
      event("change_plan.completed", "evolution_control_plane", { payload: { targetOwnerId: "workspace_config" } }),
    );
    const otherKeys = other.kind === "mapped" ? other.effect.keys : [];
    expect(otherKeys).not.toContainEqual(["skills", "capability-skills"]);
  });

  it("refreshes the installs list when the skip setting changes", () => {
    // The installs response carries `operatorApprovalSkip`, which decides whether an install step asks the operator.
    expect(SETTINGS_READER_KEYS).toContainEqual(["skills", "capability-skill-installs"]);
    const result = resolveRealtimeEvent(
      event("change_plan.completed", "evolution_control_plane", {
        payload: { targetOwnerId: "runtime_settings", planId: "p-1" },
      }),
    );
    const keys = result.kind === "mapped" ? result.effect.keys : [];
    expect(keys).toContainEqual(["skills", "capability-skill-installs"]);
    const other = resolveRealtimeEvent(
      event("change_plan.completed", "evolution_control_plane", { payload: { targetOwnerId: "workspace_config" } }),
    );
    const otherKeys = other.kind === "mapped" ? other.effect.keys : [];
    expect(otherKeys).not.toContainEqual(["skills", "capability-skill-installs"]);
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

  it("refreshes the saved-board list and detail readers when a board changes elsewhere", () => {
    expect(
      resolveRealtimeEvent(event("ops_saved_board_changed", "ops_saved_boards", { eventClass: "operational_signal" })),
    ).toEqual({
      kind: "mapped",
      effect: {
        keys: [
          ["surface", "saved-boards"],
          ["surface", "saved-board"],
        ],
        refresh: ["dashboard"],
      },
    });
  });

  it("maps no add-on events", () => {
    for (const type of ["addon_installed", "addon_updated", "addon_enabled", "addon_launched", "addon_uninstalled"]) {
      expect(resolveRealtimeEvent(event(type, "system")).kind).toBe("unmapped");
    }
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

  it("replay gaps refresh every owner the shared stream does, keys and topics", () => {
    const gap = event("replay_gap", "gateway", { payload: { kind: "replay_gap" } });
    const result = resolveRealtimeEvent(gap);
    expect(result.kind).toBe("mapped");
    const effect = result.kind === "mapped" ? result.effect : { keys: [], refresh: [] };
    // "surface" was the removed catch-all; its cockpit readers (boards) refresh under "dashboard".
    const shared = deriveRealtimeRefresh(gap).topics.filter((topic) => topic !== "surface");
    for (const topic of [...shared, "dashboard" as const]) {
      expect(effect.refresh, topic).toContain(topic);
      expect(effect.keys, topic).toContainEqual([topic]);
    }
    expect(effect.refresh).not.toContain("surface");
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
