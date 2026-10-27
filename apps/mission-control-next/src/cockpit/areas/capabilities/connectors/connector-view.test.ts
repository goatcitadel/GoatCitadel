import type {
  CapabilityConnectorCategory,
  CapabilityConnectorItem,
  CapabilityConnectorKind,
  CapabilityConnectorReason,
  CapabilityConnectorState,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  approvalPostureInEffect,
  connectorAction,
  connectorCategoryLabel,
  connectorCategoryOptions,
  connectorKindLabel,
  connectorSearchSuggestion,
  describeConnection,
  filterConnectors,
  groupConnectors,
  LETTER_ICON_TONE_COUNT,
  letterIconTone,
  presentConnectorState,
} from "./connector-view";

function item(overrides: Partial<CapabilityConnectorItem> = {}): CapabilityConnectorItem {
  return {
    id: "mcp-template:example",
    name: "Example",
    description: "An example app.",
    kind: "mcp",
    source: "mcp_template",
    category: "automation",
    state: "available",
    reason: "not_installed",
    group: "available",
    auth: "none",
    runsOnThisDevice: false,
    networkHosts: [],
    chat: { available: true },
    hiddenInWorkspace: false,
    ...overrides,
  };
}

describe("groupConnectors", () => {
  it("groups in the fixed order and drops empty groups", () => {
    const items = [
      item({ id: "a", name: "Notion", group: "available" }),
      item({ id: "b", name: "Linear", state: "connected", reason: "ready", group: "connected" }),
      item({ id: "c", name: "Old app", state: "turned_off", reason: "turned_off", group: "turned_off" }),
      item({ id: "d", name: "Airtable", group: "available" }),
    ];
    const groups = groupConnectors(items);
    expect(groups.map((entry) => [entry.group, entry.label])).toEqual([
      ["connected", "Connected"],
      ["available", "Available"],
      ["turned_off", "Turned off"],
    ]);
    // The Gateway sorts the rows; the groups keep that order.
    expect(groups[1]?.items.map((entry) => entry.id)).toEqual(["a", "d"]);
  });

  it("labels the on-this-device group", () => {
    const groups = groupConnectors([item({ group: "on_this_device", runsOnThisDevice: true })]);
    expect(groups.map((entry) => entry.label)).toEqual(["On this device"]);
  });

  it("returns nothing for no items", () => {
    expect(groupConnectors([])).toEqual([]);
  });
});

describe("filterConnectors", () => {
  const items = [
    item({ id: "slack", name: "Slack", description: "Chat with your team", kind: "channel", category: "messaging" }),
    item({ id: "notion", name: "Notion", description: "Notes and wikis", category: "automation" }),
    item({ id: "gh", name: "GitHub", description: "Code hosting", category: "development" }),
    item({ id: "web", name: "Firecrawl", description: "Read web pages", kind: "built_in", category: "search" }),
  ];
  const ids = (found: readonly CapabilityConnectorItem[]) => found.map((entry) => entry.id);

  it("filters by query across name, description, category and kind", () => {
    expect(ids(filterConnectors(items, { query: "slack", categories: [] }))).toEqual(["slack"]);
    expect(ids(filterConnectors(items, { query: "WIKIS", categories: [] }))).toEqual(["notion"]);
    expect(ids(filterConnectors(items, { query: "development", categories: [] }))).toEqual(["gh"]);
    expect(ids(filterConnectors(items, { query: "built in", categories: [] }))).toEqual(["web"]);
    expect(ids(filterConnectors(items, { query: "channel", categories: [] }))).toEqual(["slack"]);
  });

  it("matches the category and kind as they are shown", () => {
    expect(ids(filterConnectors(items, { query: "messaging", categories: [] }))).toEqual(["slack"]);
    // "mcp" is the kind label of the two MCP rows.
    expect(ids(filterConnectors(items, { query: "mcp", categories: [] }))).toEqual(["notion", "gh"]);
  });

  it("ignores spaces around the query and shows everything for an empty one", () => {
    expect(ids(filterConnectors(items, { query: "  notion ", categories: [] }))).toEqual(["notion"]);
    expect(ids(filterConnectors(items, { query: "   ", categories: [] }))).toEqual(["slack", "notion", "gh", "web"]);
  });

  it("keeps only the chosen categories, and both filters must match", () => {
    expect(ids(filterConnectors(items, { query: "", categories: ["messaging", "search"] }))).toEqual(["slack", "web"]);
    expect(ids(filterConnectors(items, { query: "read", categories: ["messaging", "search"] }))).toEqual(["web"]);
    expect(filterConnectors(items, { query: "slack", categories: ["development"] })).toEqual([]);
  });
});

describe("connectorCategoryOptions", () => {
  it("lists only the categories that have rows, in a fixed order", () => {
    const options = connectorCategoryOptions([
      item({ category: "search" }),
      item({ category: "development" }),
      item({ category: "search" }),
      item({ category: "messaging" }),
    ]);
    expect(options).toEqual([
      { id: "development", label: "Development" },
      { id: "messaging", label: "Messaging" },
      { id: "search", label: "Search" },
    ]);
  });
});

describe("labels", () => {
  it.each<[CapabilityConnectorKind, string]>([
    ["built_in", "Built in"],
    ["mcp", "MCP"],
    ["channel", "Channel"],
  ])("names the %s kind %s", (kind, label) => {
    expect(connectorKindLabel(kind)).toBe(label);
  });

  it("names every category in plain words", () => {
    const categories: CapabilityConnectorCategory[] = [
      "development",
      "browser",
      "automation",
      "research",
      "data",
      "creative",
      "orchestration",
      "other",
      "messaging",
      "search",
    ];
    for (const category of categories) {
      const label = connectorCategoryLabel(category);
      expect(label).toMatch(/^[A-Z][a-z]+$/);
    }
    expect(connectorCategoryLabel("automation")).toBe("Automation");
    expect(connectorCategoryLabel("messaging")).toBe("Messaging");
  });
});

describe("presentConnectorState", () => {
  it.each<[CapabilityConnectorState, CapabilityConnectorReason, string, string, string]>([
    ["connected", "ready", "Connected", "done", "Ready to use"],
    ["needs_sign_in", "sign_in_needed", "Needs sign-in", "waiting", "Sign in to finish setup"],
    ["sign_in_expired", "sign_in_expired", "Sign-in expired", "waiting", "Sign in again to keep using it"],
    ["broken", "error", "Not working", "failed", "Stopped working; open it to see why"],
    ["available", "not_installed", "Available", "neutral", "Not installed"],
    ["turned_off", "turned_off", "Turned off", "neutral", "Switched off"],
  ])("shows %s with %s as %s (%s tone): %s", (state, reason, label, tone, line) => {
    expect(presentConnectorState(item({ state, reason }))).toEqual({ label, tone, reason: line });
  });

  it.each<[CapabilityConnectorReason, string]>([
    ["ready", "Ready to use"],
    ["not_connected", "Not connected yet"],
    ["sign_in_needed", "Sign in to finish setup"],
    ["sign_in_expired", "Sign in again to keep using it"],
    ["error", "Stopped working; open it to see why"],
    ["turned_off", "Switched off"],
    ["not_installed", "Not installed"],
    ["needs_api_key", "Needs an API key"],
    ["missing_sign_in_setup", "Sign-in isn't set up for this app yet"],
  ])("explains the %s reason as %s", (reason, line) => {
    expect(presentConnectorState(item({ reason })).reason).toBe(line);
  });

  it("says not available in Chat on a connected MCP row", () => {
    const shown = presentConnectorState(
      item({
        kind: "mcp",
        state: "connected",
        reason: "ready",
        chat: { available: false, blockedBy: "mcp_in_chat_off" },
      }),
    );
    expect(shown.reason).toBe("Connected · not available in Chat");
    // Green would say the AI can use it, so the badge asks for a look instead.
    expect(shown.label).toBe("Connected");
    expect(shown.tone).toBe("waiting");
  });

  it("leaves rows that are not connected alone when Chat can't reach MCP", () => {
    const shown = presentConnectorState(
      item({ state: "available", reason: "not_installed", chat: { available: false, blockedBy: "mcp_in_chat_off" } }),
    );
    expect(shown).toEqual({ label: "Available", tone: "neutral", reason: "Not installed" });
  });

  it("says hidden in this workspace", () => {
    const shown = presentConnectorState(item({ state: "connected", reason: "ready", hiddenInWorkspace: true }));
    expect(shown.label).toBe("Hidden in this workspace");
    expect(shown.tone).toBe("neutral");
  });

  it("keeps the state word on a hidden row that is not connected", () => {
    // A hidden row that is broken must not read as merely hidden: the problem is still there when it is unhidden.
    const broken = presentConnectorState(item({ state: "broken", reason: "error", hiddenInWorkspace: true }));
    expect(broken.label).toBe("Not working · hidden in this workspace");
    expect(broken.tone).toBe("failed");
    expect(broken.reason).toBe("The AI can't use it in this workspace");
    expect(
      presentConnectorState(item({ state: "sign_in_expired", reason: "sign_in_expired", hiddenInWorkspace: true })),
    ).toMatchObject({ label: "Sign-in expired · hidden in this workspace", tone: "waiting" });
    expect(
      presentConnectorState(item({ state: "needs_sign_in", reason: "sign_in_needed", hiddenInWorkspace: true })),
    ).toMatchObject({ label: "Needs sign-in · hidden in this workspace", tone: "waiting" });
    expect(
      presentConnectorState(item({ state: "turned_off", reason: "turned_off", hiddenInWorkspace: true })),
    ).toMatchObject({ label: "Turned off · hidden in this workspace", tone: "neutral" });
    expect(presentConnectorState(item({ state: "available", hiddenInWorkspace: true }))).toMatchObject({
      label: "Available · hidden in this workspace",
      tone: "neutral",
    });
  });

  it("keeps the plain hidden label and a neutral tone on a connected row", () => {
    const hidden = presentConnectorState(
      item({ state: "connected", reason: "ready", hiddenInWorkspace: true, chat: { available: false } }),
    );
    expect(hidden).toEqual({
      label: "Hidden in this workspace",
      tone: "neutral",
      reason: "The AI can't use it in this workspace",
    });
  });

  it("points the panel, not the row, at Technical details for a broken connector", () => {
    const broken = item({ state: "broken", reason: "error", lastError: "spawn ENOENT" });
    // The row's line sends the reader to the panel; the panel itself must not send them back to it.
    expect(presentConnectorState(broken).reason).toBe("Stopped working; open it to see why");
    expect(presentConnectorState(broken, "row").reason).toBe("Stopped working; open it to see why");
    expect(presentConnectorState(broken, "panel", { technicalDetailsShown: true }).reason).toBe(
      "Stopped working. The last error is under Technical details.",
    );
  });

  it("points at Technical details only when they are shown and hold an error", () => {
    const broken = item({ state: "broken", reason: "error", lastError: "spawn ENOENT" });
    const noError = item({ state: "broken", reason: "error" });
    // Hidden by the operator's preference: the pointer would lead nowhere.
    expect(presentConnectorState(broken, "panel").reason).toBe("Stopped working.");
    expect(presentConnectorState(broken, "panel", { technicalDetailsShown: false }).reason).toBe("Stopped working.");
    // Shown, but there is no error row to find.
    expect(presentConnectorState(noError, "panel", { technicalDetailsShown: true }).reason).toBe("Stopped working.");
  });

  it("words every other reason the same in the panel as on the row", () => {
    const reasons: CapabilityConnectorReason[] = [
      "ready",
      "not_connected",
      "sign_in_needed",
      "sign_in_expired",
      "turned_off",
      "not_installed",
      "needs_api_key",
      "missing_sign_in_setup",
    ];
    for (const reason of reasons) {
      expect(presentConnectorState(item({ reason }), "panel")).toEqual(presentConnectorState(item({ reason }), "row"));
    }
  });

  it("gives a hidden row's own reason line instead of the state's", () => {
    // "Ready to use" beside "Hidden in this workspace" would say the AI can use it.
    const hidden = presentConnectorState(item({ state: "connected", reason: "ready", hiddenInWorkspace: true }));
    expect(hidden.reason).toBe("The AI can't use it in this workspace");
    const blockedInChat = presentConnectorState(
      item({
        state: "connected",
        reason: "ready",
        hiddenInWorkspace: true,
        chat: { available: false, blockedBy: "mcp_in_chat_off" },
      }),
    );
    expect(blockedInChat.reason).toBe("The AI can't use it in this workspace");
    const off = presentConnectorState(item({ state: "turned_off", reason: "turned_off", hiddenInWorkspace: true }));
    expect(off.reason).toBe("The AI can't use it in this workspace");
  });
});

describe("describeConnection", () => {
  it("says an on-device program runs here, with its command and the network warning", () => {
    expect(
      describeConnection(item({ runsOnThisDevice: true, command: "npx -y context7-mcp@1.2.3", auth: "none" })),
    ).toEqual({
      lines: ["Runs on this computer"],
      command: "npx -y context7-mcp@1.2.3",
      warning: "This program's own internet access isn't limited by GoatCitadel's allowed sites.",
    });
  });

  it("adds the key it needs to an on-device program", () => {
    expect(describeConnection(item({ runsOnThisDevice: true, command: "run-it", auth: "api_key" })).lines).toEqual([
      "Runs on this computer",
      "Needs an API key",
    ]);
  });

  it("still warns about the network when the command is missing", () => {
    const shown = describeConnection(item({ runsOnThisDevice: true }));
    expect(shown.command).toBeUndefined();
    expect(shown.warning).toContain("isn't limited by GoatCitadel's allowed sites");
  });

  it.each<[CapabilityConnectorState, CapabilityConnectorReason]>([
    ["connected", "ready"],
    ["turned_off", "turned_off"],
    ["broken", "error"],
  ])("sends a %s web search row to the web search settings, not to a key it may not need", (state, reason) => {
    // Self-hosted Firecrawl works without a key, so "Needs an API key" would be wrong for a row that already works.
    const shown = describeConnection(item({ source: "web_search", kind: "built_in", auth: "api_key", state, reason }));
    expect(shown.lines).toEqual(["Uses your web search settings"]);
    expect(shown.command).toBeUndefined();
    expect(shown.warning).toBeUndefined();
  });

  it("says a web search row that is only available needs an API key", () => {
    const available = item({
      source: "web_search",
      kind: "built_in",
      auth: "api_key",
      state: "available",
      reason: "needs_api_key",
    });
    expect(describeConnection(available).lines).toEqual(["Needs an API key"]);
  });

  it("still says a connected saved server with a key needs one", () => {
    const saved = item({ source: "mcp_server", auth: "api_key", state: "connected", reason: "ready" });
    expect(describeConnection(saved).lines).toEqual(["Needs an API key"]);
  });

  it.each<[Partial<CapabilityConnectorItem>, string[]]>([
    [{ auth: "api_key" }, ["Needs an API key"]],
    [{ auth: "bot_token" }, ["Needs a bot token"]],
    [{ auth: "oauth", networkHosts: ["mcp.linear.app"] }, ["Signs in at mcp.linear.app"]],
    [{ auth: "oauth", networkHosts: [] }, ["Signs in with your account"]],
    [{ auth: "google" }, ["Signs in with your Google account"]],
    [{ auth: "none", networkHosts: ["mcp.example.com"] }, ["Connects to mcp.example.com"]],
    [{ auth: "none", networkHosts: [] }, ["Needs no sign-in"]],
  ])("describes how %j connects", (overrides, lines) => {
    const shown = describeConnection(item(overrides));
    expect(shown.lines).toEqual(lines);
    expect(shown.command).toBeUndefined();
    expect(shown.warning).toBeUndefined();
  });
});

describe("connectorSearchSuggestion", () => {
  const connected = { state: "connected", reason: "ready", group: "connected" } as const;

  it("names the category of the first connected row", () => {
    expect(
      connectorSearchSuggestion([
        item({ category: "data" }),
        item({ ...connected, category: "messaging" }),
        item({ ...connected, category: "development" }),
      ]),
    ).toBe("Messaging");
  });

  it('skips connected rows in the Search category, since "Search" is no hint in a search box', () => {
    expect(
      connectorSearchSuggestion([
        item({ ...connected, category: "search" }),
        item({ ...connected, category: "search" }),
        item({ ...connected, category: "development" }),
      ]),
    ).toBe("Development");
  });

  it("falls back to automation when nothing else is connected", () => {
    expect(connectorSearchSuggestion([])).toBe("automation");
    expect(connectorSearchSuggestion([item({ category: "development" })])).toBe("automation");
    expect(connectorSearchSuggestion([item({ ...connected, category: "search" })])).toBe("automation");
  });
});

describe("connectorAction", () => {
  it.each<[CapabilityConnectorState, CapabilityConnectorReason, string, string]>([
    ["available", "not_installed", "install", "Install"],
    ["available", "needs_api_key", "set_up", "Set up"],
    ["available", "missing_sign_in_setup", "set_up", "Set up"],
    ["needs_sign_in", "sign_in_needed", "connect", "Connect"],
    ["broken", "error", "try_again", "Try again"],
    ["sign_in_expired", "sign_in_expired", "reconnect", "Reconnect"],
    ["turned_off", "turned_off", "turn_back_on", "Turn back on"],
    ["connected", "ready", "manage", "Manage"],
  ])("offers an action for %s (%s): %s", (state, reason, kind, label) => {
    expect(connectorAction(item({ state, reason }))).toEqual({ kind, label });
  });

  it.each<[string, Partial<CapabilityConnectorItem>]>([
    ["a service from the catalog", { id: "integration:automation.notion", source: "integration", kind: "built_in" }],
    ["a web search key", { id: "web-search:search.brave", source: "web_search", reason: "needs_api_key" }],
  ])("keeps Set up for %s that has no install", (_label, overrides) => {
    expect(connectorAction(item({ reason: "not_installed", ...overrides }))).toEqual({
      kind: "set_up",
      label: "Set up",
    });
  });

  it("asks a saved server that still needs its sign-in to connect", () => {
    const saved = item({ id: "mcp-server:linear", source: "mcp_server", serverId: "linear" });
    expect(connectorAction({ ...saved, state: "needs_sign_in", reason: "sign_in_needed" })).toEqual({
      kind: "connect",
      label: "Connect",
    });
  });
});

describe("letterIconTone", () => {
  it("gives the same name the same tone", () => {
    expect(letterIconTone("Slack")).toBe(letterIconTone("Slack"));
    expect(letterIconTone("Slack")).toBe(letterIconTone("slack"));
  });

  it("stays inside the tone list and uses more than one tone", () => {
    const names = ["Slack", "Notion", "GitHub", "Linear", "Airtable", "Firecrawl", "Gmail", "Discord", "Telegram"];
    const tones = names.map(letterIconTone);
    for (const tone of tones) {
      expect(Number.isInteger(tone)).toBe(true);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(LETTER_ICON_TONE_COUNT);
    }
    expect(new Set(tones).size).toBeGreaterThan(1);
  });
});

describe("approvalPostureInEffect", () => {
  const saved = (overrides: Partial<CapabilityConnectorItem> = {}) =>
    item({ id: "mcp-server:pay", source: "mcp_server", serverId: "pay", ...overrides });

  it.each([
    ["a saved setting", saved({ approvalPosture: "nothing_asks" }), true, "nothing_asks"],
    ["no saved setting", saved(), true, undefined],
    ["an install that never relaxes approvals", saved({ approvalPosture: "reads_free" }), false, undefined],
    [
      "a server whose tools are listed per chat",
      saved({ approvalPosture: "reads_free", requesterScoped: true }),
      true,
      undefined,
    ],
    [
      "a money connector's Nothing asks",
      saved({ approvalPosture: "nothing_asks", movesMoney: true }),
      true,
      "reads_free",
    ],
    [
      "a money connector's Reading is free",
      saved({ approvalPosture: "reads_free", movesMoney: true }),
      true,
      "reads_free",
    ],
  ] as const)("decides calls the way the Gateway does for %s", (_label, entry, reliefAvailable, posture) => {
    expect(approvalPostureInEffect(entry, reliefAvailable)).toBe(posture);
  });
});
