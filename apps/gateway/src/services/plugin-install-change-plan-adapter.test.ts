import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, FeatureDisabledError, type ChangePlanRecord } from "@goatcitadel/contracts";
import { pluginToolGroupHolds } from "./capability-plugin-store.js";
import { builtinDefinitionRevision } from "./prompt-pack/builtin-definition.js";
import { preparePromptPackImport } from "./prompt-pack/prepare-import.js";
import {
  CHECKS_MD,
  FULL_MANIFEST,
  OPERATOR,
  PLUGIN_ID,
  TREE_SHA256,
  WORKSPACE_ID,
  fullViews,
  pluginInstallHarness,
  type PluginInstallFixture,
} from "./capability-plugin-install.test-support.js";
import { isAutoResumeOnApprovalPlan } from "./evolution-control-plane-approval-reconciliation.js";

const harnesses: Array<ReturnType<typeof pluginInstallHarness>> = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

const HOOK_REF = "keychain:goatcitadel:hook:00000000-0000-4000-8000-000000000001";

function harness(input: PluginInstallFixture = {}) {
  const created = pluginInstallHarness(input);
  harnesses.push(created);
  return created;
}

/** A plan made as the Capabilities route makes it: refs minted first, then the plan. */
async function planFor(h: ReturnType<typeof harness>, refs: Record<string, string> = { "tool-watch": HOOK_REF }) {
  for (const ref of Object.values(refs)) h.state.keychain.set(ref, "signing-secret");
  return await h.plans.create({
    actor: OPERATOR,
    request: h.pluginRequest(refs),
    idempotencyKey: "capabilities:plugin-install:key-1:inspection",
  });
}

describe("installing a plugin through one Change Plan", () => {
  it("installs every non-skill piece in order from one confirmation when the setting is on", async () => {
    const h = harness({ allowlist: ["api.openai.com"] });
    const plan = await planFor(h);
    expect(plan).toMatchObject({
      kind: "plugin_install",
      scope: "capability",
      risk: "danger",
      status: "awaiting_confirmation",
      title: "Install Meeting tools",
      target: { ownerId: "capability_plugins", resourceId: `plugin:${PLUGIN_ID}` },
      requiredAction: { kind: "confirmation" },
    });
    expect(plan.target.expectedHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(h.state.order).toEqual([]);

    const settled = await h.confirm(plan);

    expect(settled.status, settled.result?.summary).toBe("completed");
    // One settings write for the hosts, then the connector and its approval setting, then the hook and the pack.
    expect(h.state.order).toEqual(["settings", "connector", "connector_approval", "hook", "prompt_pack"]);
    expect(h.state.settings.networkAllowlist).toEqual(["api.openai.com", "mcp.issues.test"]);
    const [server] = h.state.servers;
    expect(server).toMatchObject({
      label: "Issues",
      enabled: false,
      pluginOwner: { pluginId: PLUGIN_ID, name: "Meeting tools", installPlanId: plan.planId },
      policy: { approvalPosture: "reads_free" },
    });
    expect(h.state.hooks).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        label: "After a tool call",
        trigger: "tool.call.after",
        mode: "observe",
        enabled: true,
        dataScope: "metadata",
        action: { type: "webhook", webhook: { url: "https://hooks.example.com/goat", secretRef: HOOK_REF } },
      },
    ]);
    const prepared = preparePromptPackImport({
      content: CHECKS_MD,
      packId: `plugin-${PLUGIN_ID}-checks`,
      sourceLabel: "Plugin Meeting tools",
      name: "Meeting checks",
    });
    expect(h.state.packs).toEqual([
      {
        packId: `plugin-${PLUGIN_ID}-checks`,
        name: "Meeting checks",
        sourceLabel: "Plugin Meeting tools",
        content: CHECKS_MD,
        revision: builtinDefinitionRevision(`plugin-${PLUGIN_ID}-checks`, prepared.write),
      },
    ]);
    // The record lists every piece with what it became; the skill is listed with its check and left for its own steps.
    expect(await h.store.get(PLUGIN_ID)).toMatchObject({
      pluginId: PLUGIN_ID,
      name: "Meeting tools",
      trust: "built_in",
      workspaceId: WORKSPACE_ID,
      installPlanId: plan.planId,
      snapshotTreeSha256: TREE_SHA256,
      manifestSha256: h.manifestSha256,
      state: "installed",
      pieces: [
        { pieceId: "meeting-notes", kind: "skill", owned: true, skillSnapshotId: "snapshot-skill-1" },
        { pieceId: "issues", kind: "connector", owned: true, ref: server!.serverId },
        { pieceId: "no-browser", kind: "tool_group_off", owned: true, ref: "browser" },
        { pieceId: "tool-watch", kind: "hook", owned: true, ref: "hook-1" },
        { pieceId: "checks", kind: "prompt_pack", owned: true, ref: `plugin-${PLUGIN_ID}-checks` },
      ],
    });
    expect(h.createApproval).not.toHaveBeenCalled();
    expect(h.state.deletedSecrets).toEqual([]);
  });

  it("says plainly what it will do and what it did", async () => {
    const h = harness();
    const plan = await planFor(h);
    expect(plan.summary).toBe(
      [
        "Allow mcp.issues.test.",
        "Save Issues, switched off, set to Reading is free.",
        "Turn Browser off in every chat while Meeting tools is installed.",
        "Add a hook that sends event details, never message text, to hooks.example.com: After a tool call.",
        "Add the prompt pack Meeting checks to Library › Prompt packs.",
        "List the skill meeting-notes, which is added in its own steps after this.",
      ].join(" "),
    );
    expect(plan.requiredAction).toMatchObject({ kind: "confirmation", confirmationText: plan.summary });
    // The uninstall never takes a host off an allowlist, so a plan that adds one says the hosts stay (F1).
    expect(plan.impact).toBe(
      [
        "Any tool can reach an allowed host, not only this plugin's connectors.",
        "Uninstalling the plugin removes the pieces this install adds, and keeps what was already there.",
        "Hosts it allowed stay in your allowlist.",
      ].join(" "),
    );

    const settled = await h.confirm(plan);
    expect(settled.result?.summary).toBe(
      [
        "Installed Meeting tools.",
        "Allowed mcp.issues.test.",
        "Saved Issues, switched off, set to Reading is free.",
        "Turned Browser off in every chat.",
        "Added a hook that sends event details to hooks.example.com.",
        "Added the prompt pack Meeting checks to Library › Prompt packs.",
        "The skill meeting-notes still needs its own steps.",
      ].join(" "),
    );
    for (const text of [plan.summary, plan.impact, plan.title, settled.result?.summary ?? ""]) {
      expect(text).not.toMatch(/posture|gateway|revision|evidence|owner|snapshot|canonical|durable|replay/iu);
    }
  });

  it("waits for one approval when the setting is off, then applies", async () => {
    const h = harness({ skip: false });
    const plan = await planFor(h);

    const waiting = await h.confirm(plan);

    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.requiredAction).toMatchObject({
      kind: "approval",
      approvalId: "approval-plugin-install",
      risk: "danger",
    });
    expect(h.state.order).toEqual([]);
    expect(isAutoResumeOnApprovalPlan(waiting)).toBe(true);

    h.approve();
    expect(await h.plans.reconcileApproval("approval-plugin-install")).toBe(1);

    const applied = await h.plans.get(OPERATOR, plan.planId);
    expect(applied.status).toBe("completed");
    expect((await h.store.get(PLUGIN_ID))?.state).toBe("installed");
    expect(h.createApproval).toHaveBeenCalledOnce();
  });

  it("always asks on remote_hardened", async () => {
    const h = harness({ profile: "remote_hardened", skip: true });
    const plan = await planFor(h);
    expect(plan.summary).toContain("Save Issues, switched off. On this install every action it takes asks you first.");

    const waiting = await h.confirm(plan);

    expect(waiting.status).toBe("awaiting_approval");
    expect(h.createApproval).toHaveBeenCalledOnce();
    expect(h.state.order).toEqual([]);
  });

  // A model's `change.request` arrives as a Chat plan with its session and turn.
  it("can't be created from Chat", async () => {
    const h = harness();
    const chat = { ...OPERATOR, surface: "chat" as const, sessionId: "session-1", turnId: "turn-1" };

    await expect(
      h.plans.create({ actor: chat, request: h.pluginRequest({ "tool-watch": HOOK_REF }) }),
    ).rejects.toMatchObject({
      httpStatus: 403,
      message: "Plugins are installed from Capabilities.",
      details: { diagnosticCode: "plugin_install_untrusted_origin" },
    });
    expect(await h.sync.list({ workspaceId: WORKSPACE_ID })).toEqual([]);
  });

  it.each([
    ["a Chat turn", { ...OPERATOR, surface: "chat" as const, sessionId: "session-1", turnId: "turn-1" }],
    ["Settings", { ...OPERATOR, surface: "settings" as const }],
    ["the system", { ...OPERATOR, surface: "system" as const }],
    ["Capabilities with Chat linkage", { ...OPERATOR, sessionId: "session-1" }],
  ])("refuses an install plan that starts from %s", async (_label, actor) => {
    const h = harness();

    await expect(h.plans.create({ actor, request: h.pluginRequest({ "tool-watch": HOOK_REF }) })).rejects.toMatchObject(
      {
        httpStatus: 403,
        details: { diagnosticCode: "plugin_install_untrusted_origin" },
      },
    );
    expect(h.state.order).toEqual([]);
    expect(await h.store.get(PLUGIN_ID)).toBeUndefined();
  });

  it("keeps an already saved connector and doesn't own it", async () => {
    const saved = {
      serverId: "saved-issues",
      label: "issues",
      transport: "http" as const,
      url: "https://mcp.issues.test/mcp",
      authType: "oauth2" as const,
      enabled: true,
      category: "data" as const,
      trustTier: "restricted" as const,
      costTier: "unknown" as const,
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "basic" as const,
        allowedToolPatterns: [],
        blockedToolPatterns: [],
      },
      status: "connected" as const,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const views = fullViews().map((view) =>
      view.pieceId === "issues" ? { ...view, check: { status: "already_there" as const }, hosts: undefined } : view,
    );
    const h = harness({ servers: [saved], views });
    const plan = await planFor(h);
    expect(plan.summary).toContain("Keep Issues, which is already saved.");

    const settled = await h.confirm(plan);

    expect(settled.status).toBe("completed");
    expect(h.sources.createConnector).not.toHaveBeenCalled();
    expect(h.sources.setConnectorApproval).not.toHaveBeenCalled();
    expect(h.state.servers).toEqual([saved]);
    // Its hosts aren't added either: only a connector the install saves needs them.
    expect(h.state.settings.networkAllowlist).toEqual([]);
    expect((await h.store.get(PLUGIN_ID))?.pieces.find((piece) => piece.pieceId === "issues")).toEqual({
      pieceId: "issues",
      kind: "connector",
      owned: false,
    });
    expect(settled.result?.summary).toContain("Kept Issues, which was already saved.");
  });

  it("keeps a connector saved after the check, and a group the operator switched off since, without owning either", async () => {
    const h = harness();
    const plan = await planFor(h);
    h.state.servers = [
      {
        serverId: "late-issues",
        label: "Issues",
        transport: "http",
        authType: "none",
        enabled: false,
        category: "data",
        trustTier: "restricted",
        costTier: "unknown",
        policy: {
          requireFirstToolApproval: true,
          redactionMode: "basic",
          allowedToolPatterns: [],
          blockedToolPatterns: [],
        },
        status: "disconnected",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    h.state.operatorOff = ["browser"];

    const settled = await h.confirm(plan);

    expect(settled.status).toBe("completed");
    expect(h.sources.createConnector).not.toHaveBeenCalled();
    const pieces = (await h.store.get(PLUGIN_ID))?.pieces ?? [];
    expect(pieces.filter((piece) => piece.kind === "connector" || piece.kind === "tool_group_off")).toEqual([
      { pieceId: "issues", kind: "connector", owned: false },
      { pieceId: "no-browser", kind: "tool_group_off", owned: false },
    ]);
  });

  it("keeps a connector another install saves while this one saves it, and never saves it twice", async () => {
    const h = harness();
    const plan = await planFor(h);
    const winner = {
      serverId: "winner-issues",
      label: "Issues",
      transport: "http" as const,
      authType: "none" as const,
      enabled: false,
      category: "data" as const,
      trustTier: "restricted" as const,
      costTier: "unknown" as const,
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "basic" as const,
        allowedToolPatterns: [],
        blockedToolPatterns: [],
      },
      status: "disconnected" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // The other install's save lands after this install's last read of the saved list, before its own write reads it.
    const save = h.sources.createConnector.getMockImplementation()!;
    h.sources.createConnector.mockImplementationOnce(async (...args) => {
      h.state.servers = [winner, ...h.state.servers];
      return await save(...args);
    });

    const settled = await h.confirm(plan);

    expect(settled.status).toBe("completed");
    expect(h.sources.createConnector).toHaveBeenCalledOnce();
    expect(h.sources.setConnectorApproval).not.toHaveBeenCalled();
    expect(h.state.servers).toEqual([winner]);
    expect((await h.store.get(PLUGIN_ID))?.pieces.find((piece) => piece.pieceId === "issues")).toEqual({
      pieceId: "issues",
      kind: "connector",
      owned: false,
    });
    expect(settled.result?.summary).toContain("Kept Issues, which was already saved.");
  });

  it("asks for everything when the piece says so", async () => {
    const manifest = {
      ...FULL_MANIFEST,
      pieces: FULL_MANIFEST.pieces.map((piece) =>
        piece.kind === "connector" ? { ...piece, asksFirst: "everything" } : piece,
      ),
    };
    const h = harness({ manifest });
    const plan = await planFor(h);
    expect(plan.summary).toContain("Save Issues, switched off, and everything it does asks you first.");

    await h.confirm(plan);

    expect(h.state.servers[0]?.policy.approvalPosture).toBe("everything_asks");
  });

  describe("the hooks allowlist", () => {
    it("is left alone while it is empty, since an empty list already allows every public https host", async () => {
      const h = harness({ hookAllowlist: [] });
      await h.confirm(await planFor(h));
      expect(h.sources.updateSettings).toHaveBeenCalledOnce();
      expect(h.sources.updateSettings.mock.calls[0]![0]).not.toHaveProperty("hookNetworkAllowlist");
      expect(h.state.settings.hookAllowlist).toEqual([]);
    });

    it("gains the hook's host when it lists others, and is left alone when it already covers it", async () => {
      const restricted = harness({ hookAllowlist: ["alerts.example.org"] });
      const plan = await planFor(restricted);
      expect(plan.summary).toContain("Allow hooks.example.com for hooks.");
      await restricted.confirm(plan);
      expect(restricted.state.settings.hookAllowlist).toEqual(["alerts.example.org", "hooks.example.com"]);

      const covered = harness({ hookAllowlist: ["*.example.com"], allowlist: ["mcp.issues.test"] });
      const coveredPlan = await planFor(covered);
      // Nothing is allowed, so the plan doesn't speak of hosts staying.
      expect(coveredPlan.impact).toBe(
        "Uninstalling the plugin removes the pieces this install adds, and keeps what was already there.",
      );
      await covered.confirm(coveredPlan);
      expect(covered.sources.updateSettings).not.toHaveBeenCalled();
      expect(covered.state.settings.hookAllowlist).toEqual(["*.example.com"]);
    });

    it("adds no host the plan didn't list, when the hooks list was restricted after the plan was made (F4)", async () => {
      // Empty at the plan, so it lists no host for hooks.
      const h = harness();
      const plan = await planFor(h);
      expect(plan.summary).not.toContain("for hooks");
      // The operator restricts hooks to one host before approving.
      h.state.settings.hookAllowlist = ["internal.corp"];

      const settled = await h.confirm(plan);

      expect(settled.status).toBe("failed");
      expect(settled.result).toMatchObject({
        summary: "This plugin changed since it was checked. Check it again.",
        failureCode: "plugin_install_changed",
      });
      expect(h.state.order).toEqual([]);
      expect(h.state.settings.hookAllowlist).toEqual(["internal.corp"]);
      expect(await h.store.get(PLUGIN_ID)).toBeUndefined();
      expect(h.state.deletedSecrets).toEqual([HOOK_REF]);
    });

    it("makes its additive write again when another settings save lands first (F13)", async () => {
      const h = harness();
      const plan = await planFor(h);
      const write = h.sources.updateSettings.getMockImplementation()!;
      // A Settings save lands just before this install's write, so its revision is stale.
      h.sources.updateSettings.mockImplementationOnce(async (update) => {
        h.state.settings = {
          ...h.state.settings,
          revision: h.state.settings.revision + 1,
          networkAllowlist: ["api.openai.com"],
        };
        return await write(update);
      });

      const settled = await h.confirm(plan);

      expect(settled.status, settled.result?.summary).toBe("completed");
      expect(h.state.order.filter((item) => item === "settings")).toHaveLength(2);
      // Made again on the newer settings, keeping what the other save wrote.
      expect(h.state.settings.networkAllowlist).toEqual(["api.openai.com", "mcp.issues.test"]);
    });

    it("stops at its hosts when the write made again would add a host the plan didn't list (F13 with F4)", async () => {
      const h = harness();
      const plan = await planFor(h);
      const write = h.sources.updateSettings.getMockImplementation()!;
      // The other save restricts hooks, so the retried lists would need the hook's host, which the plan never named.
      h.sources.updateSettings.mockImplementationOnce(async (update) => {
        h.state.settings = {
          ...h.state.settings,
          revision: h.state.settings.revision + 1,
          hookAllowlist: ["internal.corp"],
        };
        return await write(update);
      });

      const settled = await h.confirm(plan);

      expect(settled.status).toBe("manual_required");
      expect(settled.result).toMatchObject({
        failureCode: "plugin_install_hosts_failed",
        summary:
          "Couldn't allow the hosts it needs. Uninstall Meeting tools to remove what it added, then install it again.",
      });
      expect(h.state.settings.hookAllowlist).toEqual(["internal.corp"]);
      expect(h.state.settings.networkAllowlist).toEqual([]);
    });

    it("says another settings save is under way, and leaves nothing installed, when the conflict outlasts two writes made again (Q1)", async () => {
      const h = harness();
      const plan = await planFor(h);
      h.sources.updateSettings.mockImplementation(async () => {
        h.state.order.push("settings");
        throw new ConflictError({ code: "STATE_CONFLICT", message: "Settings changed after this client loaded them." });
      });

      const settled = await h.confirm(plan);

      expect(settled.status).toBe("failed");
      expect(settled.result).toMatchObject({
        summary: "GoatCitadel is saving another settings change. Install the plugin again in a moment.",
        failureCode: "plugin_install_settings_busy",
      });
      expect(settled.result?.summary).not.toContain("changed since it was checked");
      expect(h.state.order).toEqual(["settings", "settings", "settings"]);
      // Only the record had been written, so it goes too: installing again is safe.
      expect(await h.store.get(PLUGIN_ID)).toBeUndefined();
      expect(h.state.deletedSecrets).toEqual([HOOK_REF]);
    });

    it("says another settings save is under way, and writes nothing, when the settings can't be read at apply (Q1)", async () => {
      const h = harness();
      const plan = await planFor(h);
      // The settings owner refuses reads while a settings change it queued is being saved.
      h.sources.readSettings.mockRejectedValueOnce(
        new ConflictError({
          code: "STATE_CONFLICT",
          message: "Settings are temporarily unavailable while runtime owners reconcile a config generation.",
        }),
      );

      const settled = await h.confirm(plan);

      expect(settled.status).toBe("failed");
      expect(settled.result).toMatchObject({
        summary: "GoatCitadel is saving another settings change. Install the plugin again in a moment.",
        failureCode: "plugin_install_settings_busy",
      });
      expect(h.state.order).toEqual([]);
      expect(await h.store.get(PLUGIN_ID)).toBeUndefined();
    });

    it("reads the settings again inside the write it makes again, so a read refused meanwhile is tried once more (Q1)", async () => {
      const h = harness();
      const plan = await planFor(h);
      const write = h.sources.updateSettings.getMockImplementation()!;
      h.sources.updateSettings.mockImplementationOnce(async (update) => {
        // Another save lands first, and the next read of the settings is refused while it is being saved.
        h.state.settings = { ...h.state.settings, revision: h.state.settings.revision + 1 };
        h.sources.readSettings.mockRejectedValueOnce(
          new ConflictError({ code: "STATE_CONFLICT", message: "Settings are temporarily unavailable." }),
        );
        return await write(update);
      });

      const settled = await h.confirm(plan);

      expect(settled.status, settled.result?.summary).toBe("completed");
      expect(h.state.settings.networkAllowlist).toEqual(["mcp.issues.test"]);
    });

    it("is refused before any plan when the hosts it would allow don't fit in the text the operator approves (Q2)", async () => {
      const hooks = Array.from({ length: 30 }, (_unused, index) => ({
        kind: "hook",
        id: `watch-${index}`,
        trigger: "tool.call.after",
        url: `https://h${index}-${"x".repeat(56)}.example.com/goat`,
      }));
      const views = hooks.map((hook) => ({
        pieceId: hook.id,
        kind: "hook" as const,
        label: "After a tool call",
        asksFirst: "Sends event details.",
        check: { status: "ready" as const },
        hosts: [new URL(hook.url).hostname],
        needsSecret: true,
      }));
      const h = harness({
        manifest: { ...FULL_MANIFEST, pieces: hooks },
        views,
        hookAllowlist: ["alerts.example.org"],
      });
      const refs = Object.fromEntries(
        hooks.map((hook, index) => [hook.id, `${HOOK_REF.slice(0, -2)}${String(index).padStart(2, "0")}`]),
      );

      await expect(planFor(h, refs)).rejects.toMatchObject({
        message: "This plugin asks to allow more hosts than one approval can list, so GoatCitadel can't install it.",
      });
      expect(await h.sync.list({ workspaceId: WORKSPACE_ID })).toEqual([]);
      expect(h.state.order).toEqual([]);
    });
  });

  describe("a piece the check found already there", () => {
    const savedIssues = {
      serverId: "saved-issues",
      label: "Issues",
      transport: "http" as const,
      url: "https://mcp.issues.test/mcp",
      authType: "oauth2" as const,
      enabled: true,
      category: "data" as const,
      trustTier: "restricted" as const,
      costTier: "unknown" as const,
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "basic" as const,
        allowedToolPatterns: [],
        blockedToolPatterns: [],
      },
      status: "connected" as const,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const keptView = (pieceId: string) =>
      fullViews().map((view) =>
        view.pieceId === pieceId ? { ...view, check: { status: "already_there" as const }, hosts: undefined } : view,
      );

    it("stops the install when a connector it would keep was deleted since the check (F3)", async () => {
      const h = harness({ servers: [savedIssues], views: keptView("issues") });
      const plan = await planFor(h);
      expect(plan.summary).toContain("Keep Issues, which is already saved.");
      h.state.servers = [];

      const settled = await h.confirm(plan);

      expect(settled.status).toBe("failed");
      expect(settled.result).toMatchObject({ failureCode: "plugin_install_changed" });
      expect(h.state.order).toEqual([]);
      expect(await h.store.get(PLUGIN_ID)).toBeUndefined();
      // Deleted before the plan is made, it can't be made either.
      await expect(planFor(harness({ views: keptView("issues") }))).rejects.toMatchObject({
        httpStatus: 409,
        message: "This plugin changed since it was checked. Check it again.",
      });
    });

    it("stops the install when a group it would keep off was switched back on since the check (F3)", async () => {
      const h = harness({ views: keptView("no-browser"), operatorOff: ["browser"] });
      const plan = await planFor(h);
      expect(plan.summary).toContain("Browser is already off, and stays your own switch.");
      h.state.operatorOff = [];

      const settled = await h.confirm(plan);

      expect(settled.status).toBe("failed");
      expect(settled.result).toMatchObject({ failureCode: "plugin_install_changed" });
      expect(h.state.order).toEqual([]);
      expect(pluginToolGroupHolds(await h.store.list())).toEqual([]);
      await expect(planFor(harness({ views: keptView("no-browser") }))).rejects.toMatchObject({ httpStatus: 409 });
    });
  });

  it("takes control and bidi characters out of the labels it shows (F5)", async () => {
    const views = fullViews().map((view) =>
      view.pieceId === "checks" ? { ...view, label: "Meeting \u202Echecks\u0000" } : view,
    );
    const h = harness({ views });
    const plan = await planFor(h);

    expect(plan.summary).toContain("Add the prompt pack Meeting checks to Library › Prompt packs.");
    for (const text of [plan.summary, plan.title, plan.impact]) {
      expect(text).not.toMatch(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u);
    }
  });

  it("keeps the secret of a hook its owner saved before failing, so the hook can still sign (F10)", async () => {
    const h = harness();
    const plan = await planFor(h);
    // The hooks owner commits the hook, then its audit line fails.
    h.sources.createHook.mockImplementationOnce(async (hook) => {
      h.state.order.push("hook");
      h.state.hooks.push(structuredClone(hook));
      throw new Error("The audit line couldn't be written.");
    });

    const settled = await h.confirm(plan);

    expect(settled.status).toBe("manual_required");
    expect(settled.result?.failureCode).toBe("plugin_install_hooks_failed");
    expect(h.state.hooks).toHaveLength(1);
    expect(h.state.deletedSecrets).toEqual([]);
    expect(h.state.keychain.get(HOOK_REF)).toBe("signing-secret");
  });

  it("deletes the secrets of an install that stopped before its record, and says installing again is safe (F11)", async () => {
    const h = harness();
    const plan = await planFor(h);

    // As if the Gateway stopped while the plan applied, before the record was written.
    const reconciled = await h.adapter.reconcile({ origin: plan.origin, actions: undefined as never }, plan);

    expect(reconciled).toMatchObject({
      effectObserved: false,
      status: "manual_required",
      result: {
        summary: "The install stopped before it finished. Nothing was installed, so installing it again is safe.",
        failureCode: "plugin_install_interrupted",
      },
    });
    expect(h.state.deletedSecrets).toEqual([HOOK_REF]);
    expect(h.state.keychain.has(HOOK_REF)).toBe(false);

    // One whose record was written keeps them: its hooks may hold them, and its uninstall removes them.
    const stopped = harness();
    const stoppedPlan = await planFor(stopped);
    stopped.state.failAt = "prompt_pack";
    const manual = await stopped.confirm(stoppedPlan);
    const again = await stopped.adapter.reconcile({ origin: manual.origin, actions: undefined as never }, manual);
    expect(again).toMatchObject({
      result: {
        summary:
          "The install stopped before it finished. Uninstall Meeting tools to remove what it added, then install it again.",
      },
    });
    expect(stopped.state.deletedSecrets).toEqual([]);
  });

  it("gives two prompt packs that share a name a name each", async () => {
    const manifest = {
      ...FULL_MANIFEST,
      pieces: [
        { kind: "prompt_pack", id: "checks", path: "prompt-packs/checks.md" },
        { kind: "prompt_pack", id: "more-checks", path: "prompt-packs/more.md" },
      ],
    };
    const views = ["checks", "more-checks"].map((pieceId) => ({
      pieceId,
      kind: "prompt_pack" as const,
      label: `Meeting checks · ${pieceId}`,
      asksFirst: "Adds 1 test.",
      check: { status: "ready" as const },
    }));
    const h = harness({ manifest, views, files: { "prompt-packs/more.md": CHECKS_MD } });

    const settled = await h.confirm(await h.plans.create({ actor: OPERATOR, request: h.pluginRequest() }));

    expect(settled.status, settled.result?.summary).toBe("completed");
    expect(h.state.packs.map((pack) => [pack.packId, pack.name])).toEqual([
      [`plugin-${PLUGIN_ID}-checks`, "Meeting checks · checks"],
      [`plugin-${PLUGIN_ID}-more-checks`, "Meeting checks · more-checks"],
    ]);
  });

  it("records what was added when a step fails", async () => {
    const h = harness();
    const plan = await planFor(h);
    h.state.failAt = "prompt_pack";

    const settled = await h.confirm(plan);

    expect(settled.status).toBe("manual_required");
    expect(settled.result).toMatchObject({ failureCode: "plugin_install_prompt_packs_failed" });
    expect(settled.result?.summary).toBe(
      [
        "Allowed mcp.issues.test.",
        "Saved Issues, switched off, set to Reading is free.",
        "Turned Browser off in every chat.",
        "Added a hook that sends event details to hooks.example.com.",
        "Couldn't add the prompt pack Meeting checks.",
        "Uninstall Meeting tools to remove what it added, then install it again.",
      ].join(" "),
    );
    // The owner's own words go to the technical details only, redacted.
    expect(settled.result?.failureDetail).toContain("The prompt_pack owner failed");
    expect(settled.result?.failureDetail).not.toContain("sk-test-0123456789abcdef");
    const record = await h.store.get(PLUGIN_ID);
    expect(record?.state).toBe("installing");
    expect(record?.pieces).toEqual([
      { pieceId: "meeting-notes", kind: "skill", owned: true, skillSnapshotId: "snapshot-skill-1" },
      { pieceId: "issues", kind: "connector", owned: true, ref: "server-1" },
      { pieceId: "no-browser", kind: "tool_group_off", owned: true, ref: "browser" },
      { pieceId: "tool-watch", kind: "hook", owned: true, ref: "hook-1" },
      { pieceId: "checks", kind: "prompt_pack", owned: true },
    ]);
    // The hook holds its secret now, so it stays for the hook's own removal.
    expect(h.state.deletedSecrets).toEqual([]);
    // A group the record lists as held is in force while the record still reads "installing" (Task 15's rule).
    expect(pluginToolGroupHolds(await h.store.list())).toEqual([
      { groupId: "browser", pluginId: PLUGIN_ID, pluginName: "Meeting tools" },
    ]);
  });

  it("stops at its prompt pack, by name, when typed run variables were switched off after the check", async () => {
    const h = harness();
    const plan = await planFor(h);
    // The prompt-pack owner checks the flag before it writes anything (PromptPackService.importPromptPack).
    h.sources.importPromptPack.mockRejectedValueOnce(new FeatureDisabledError("typedRunVariablesV1Enabled"));

    const settled = await h.confirm(plan);

    expect(settled.status).toBe("manual_required");
    expect(settled.result).toMatchObject({
      failureCode: "plugin_install_prompt_packs_failed",
      failureDetail: "Feature flag typedRunVariablesV1Enabled is disabled.",
    });
    expect(settled.result?.summary).toContain("Couldn't add the prompt pack Meeting checks.");
    expect(h.state.packs).toEqual([]);
    expect((await h.store.get(PLUGIN_ID))?.pieces.find((piece) => piece.kind === "prompt_pack")).toEqual({
      pieceId: "checks",
      kind: "prompt_pack",
      owned: true,
    });
  });

  it("deletes the secrets no hook holds when a step before the hooks fails", async () => {
    const h = harness();
    const plan = await planFor(h);
    h.state.failAt = "connector";

    const settled = await h.confirm(plan);

    expect(settled.status).toBe("manual_required");
    expect(settled.result?.failureCode).toBe("plugin_install_connectors_failed");
    expect(settled.result?.summary).toBe(
      "Allowed mcp.issues.test. Couldn't save Issues. Uninstall Meeting tools to remove what it added, then install it again.",
    );
    expect(h.state.deletedSecrets).toEqual([HOOK_REF]);
    expect((await h.store.get(PLUGIN_ID))?.pieces.find((piece) => piece.pieceId === "issues")).toEqual({
      pieceId: "issues",
      kind: "connector",
      owned: true,
    });
  });

  it("refuses an expired or changed inspection", async () => {
    // Changed bytes on disk between the plan and apply: nothing is written, the secrets go, and the plan says why.
    const changed = harness();
    const plan = await planFor(changed);
    changed.state.tampered = true;
    const settled = await changed.confirm(plan);
    expect(settled.status).toBe("failed");
    expect(settled.result).toMatchObject({
      summary: "This plugin changed since it was checked. Check it again.",
      failureCode: "plugin_install_changed",
    });
    expect(changed.state.order).toEqual([]);
    expect(await changed.store.get(PLUGIN_ID)).toBeUndefined();
    expect(changed.state.deletedSecrets).toEqual([HOOK_REF]);

    // An inspection that ran out of time can't make a plan.
    const expired = harness();
    expired.state.inspection = { ...expired.state.inspection, expiresAt: new Date(Date.now() - 1).toISOString() };
    await expect(planFor(expired)).rejects.toMatchObject({
      httpStatus: 404,
      message: "That plugin check wasn't found, or it ran out of time. Check the plugin again.",
    });

    // A plan whose manifest no longer matches what was checked can't be made either.
    const edited = harness();
    edited.state.manifestText = edited.state.manifestText.replace("Meeting tools", "Meeting tools 2");
    await expect(planFor(edited)).rejects.toMatchObject({
      httpStatus: 409,
      message: "This plugin changed since it was checked. Check it again.",
    });
  });

  it("refuses a plugin that was installed between the plan and apply", async () => {
    const h = harness();
    const plan = await planFor(h);
    await h.store.update(PLUGIN_ID, () => ({
      pluginId: PLUGIN_ID,
      name: "Meeting tools",
      description: "Elsewhere.",
      version: "1.0.0",
      trust: "built_in",
      sourceKind: "built_in",
      sourceDisplay: "Ships with GoatCitadel",
      pin: { kind: "content", treeSha256: TREE_SHA256 },
      manifestSha256: h.manifestSha256,
      snapshotTreeSha256: TREE_SHA256,
      workspaceId: WORKSPACE_ID,
      installPlanId: "another-plan",
      state: "installed",
      installedAt: new Date().toISOString(),
      pieces: [],
    }));

    const settled = await h.confirm(plan);

    expect(settled.status).toBe("failed");
    expect(settled.result?.summary).toBe("Meeting tools is already installed.");
    expect(h.state.order).toEqual([]);
    expect((await h.store.get(PLUGIN_ID))?.installPlanId).toBe("another-plan");
  });

  // R59 and #572: the approval is the operator's last word on their own click, so approving applies the plan.
  it("applies a Capabilities plugin install or uninstall once approved, but nothing tied to a chat", () => {
    const plan = (kind: "plugin_install" | "plugin_uninstall", origin: Partial<ChangePlanRecord["origin"]> = {}) =>
      ({
        kind,
        request:
          kind === "plugin_install"
            ? harness().pluginRequest()
            : { kind, pluginId: PLUGIN_ID, installPlanId: "plan-install-1" },
        origin: { surface: "capabilities", workspaceId: WORKSPACE_ID, actorId: "operator-1", ...origin },
        evidenceRefs: [],
      }) as unknown as ChangePlanRecord;

    expect(isAutoResumeOnApprovalPlan(plan("plugin_install"))).toBe(true);
    expect(isAutoResumeOnApprovalPlan(plan("plugin_uninstall"))).toBe(true);
    expect(isAutoResumeOnApprovalPlan(plan("plugin_install", { sessionId: "session-1" }))).toBe(false);
    expect(isAutoResumeOnApprovalPlan(plan("plugin_install", { turnId: "turn-1" }))).toBe(false);
    expect(isAutoResumeOnApprovalPlan(plan("plugin_install", { surface: "chat" }))).toBe(false);
  });

  it("never deletes a live hook's secret when a finished install plan is cancelled", async () => {
    const h = harness();
    const settled = await h.confirm(await planFor(h));
    expect(settled.status).toBe("completed");

    // A finished plan has no pending action, so the nonce never stops a cancel: the control plane refuses it later.
    await expect(h.plans.cancel(OPERATOR, settled.planId, settled.revision, "x".repeat(16))).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(h.state.deletedSecrets).toEqual([]);
    expect(h.state.keychain.get(HOOK_REF)).toBe("signing-secret");

    // A plan that stopped after its hook was added keeps that hook's secret as well.
    const stopped = harness();
    const plan = await planFor(stopped);
    stopped.state.failAt = "prompt_pack";
    const manual = await stopped.confirm(plan);
    expect(manual.status).toBe("manual_required");
    await expect(stopped.plans.cancel(OPERATOR, manual.planId, manual.revision, "x".repeat(16))).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(stopped.state.deletedSecrets).toEqual([]);
    expect(stopped.state.keychain.get(HOOK_REF)).toBe("signing-secret");
  });

  it("never deletes a secret its install's record shows a hook holding, whatever the plan says", async () => {
    const h = harness();
    const settled = await h.confirm(await planFor(h));
    expect((await h.store.get(PLUGIN_ID))?.pieces.find((piece) => piece.kind === "hook")?.ref).toBe("hook-1");

    // As if a plan that had applied still read as waiting: the record's hook keeps its secret.
    await h.adapter.discard(
      { origin: settled.origin, actions: undefined as never },
      {
        ...settled,
        status: "awaiting_approval",
      },
    );

    expect(h.state.deletedSecrets).toEqual([]);
    expect(h.state.keychain.get(HOOK_REF)).toBe("signing-secret");
  });

  it("keeps the secrets, and says so, when the record can't be read to tell which a hook holds", async () => {
    const h = harness();
    const plan = await planFor(h);
    h.sources.readPlugin.mockRejectedValueOnce(new Error("The saved plugin records can't be read."));

    const cancelled = await h.plans.cancel(OPERATOR, plan.planId, plan.revision);

    expect(cancelled.status).toBe("cancelled");
    expect(h.state.deletedSecrets).toEqual([]);
    expect(h.sources.reportSecretsKept).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "The saved plugin records can't be read." }),
    );
  });

  it("keeps no staging step, so the operator's own confirmation reaches the approval skip", () => {
    const { adapter } = harness();
    expect("stage" in adapter).toBe(false);
    expect(adapter.rollbackRefusal).toBe("Uninstall the plugin instead.");
  });

  it("reports what an interrupted install holds, and never writes", async () => {
    const h = harness();
    const plan = await planFor(h);
    const settled = await h.confirm(plan);
    const finished = await h.adapter.reconcile({ origin: plan.origin, actions: undefined as never }, settled);
    expect(finished).toMatchObject({ effectObserved: true, status: "completed" });

    const other = harness();
    const stopped = await other.adapter.reconcile({ origin: plan.origin, actions: undefined as never }, plan);
    expect(stopped).toMatchObject({
      effectObserved: false,
      status: "manual_required",
      result: { failureCode: "plugin_install_interrupted" },
    });
    expect(other.state.order).toEqual([]);
  });
});
