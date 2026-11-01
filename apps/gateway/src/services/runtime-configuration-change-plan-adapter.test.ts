import { describe, expect, it, vi } from "vitest";
import {
  PUBLIC_WEB_ADDRESS_HAS_EXTRA,
  PUBLIC_WEB_ADDRESS_HAS_LOGIN,
  PUBLIC_WEB_ADDRESS_NOT_HTTPS,
  PUBLIC_WEB_ADDRESS_NOT_PUBLIC,
  PUBLIC_WEB_ADDRESS_NOT_URL,
  PUBLIC_WEB_ADDRESS_TOO_LONG,
  ValidationError,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import { RuntimeConfigurationChangePlanAdapter } from "./runtime-configuration-change-plan-adapter.js";

const context = {
  origin: { surface: "settings", workspaceId: "default", actorId: "operator-1" },
  actions: {
    confirmation: (input: Record<string, unknown>) => ({
      kind: "confirmation",
      actionId: "action-1",
      actionNonce: "nonce-1",
      purpose: "apply",
      ...input,
    }),
    secureInput: (input: Record<string, unknown>) => ({
      kind: "secure_input",
      actionId: "secure-1",
      actionNonce: "secure-nonce-123456",
      ...input,
    }),
  },
} as any;

const authCredentialDeps = {
  hasTemporaryAuthCredential: vi.fn(async () => false),
  consumeTemporaryAuthCredential: vi.fn(async () => "temporary-credential"),
  discardTemporaryAuthCredential: vi.fn(),
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    revision: 7,
    toolApprovalMode: "approve_risky",
    budgetMode: "balanced",
    features: {
      evolutionControlPlaneV1Enabled: true,
      improvementLocalObservationV1Enabled: false,
      improvementModelEvaluationV1Enabled: false,
      productSourceEvolutionV1Enabled: false,
    },
    ...overrides,
  } as any;
}

describe("RuntimeConfigurationChangePlanAdapter", () => {
  it("requires a fresh external catalog and preserves the prior Chat default if runtime verification fails", async () => {
    let current = settings({
      llm: { activeProviderId: "openai", activeModel: "current", defaultThinkingLevel: "standard" },
      llamaCpp: { managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1" },
    });
    const updateSettings = vi.fn(async (input) => {
      current = settings({
        ...current,
        revision: current.revision + 1,
        llamaCpp: { ...current.llamaCpp, ...input.llamaCpp },
        llm: { ...current.llm, ...input.llm },
      });
      return current;
    });
    const previewLlamaModels = vi.fn(async () => ({
      source: "error_fallback" as const,
      items: [{ id: "template-alias" }],
    }));
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: async () => current,
      updateSettings,
      previewLlamaModels,
      refreshLlamaRuntime: async () => ({ healthy: false }) as any,
    });
    const request = {
      kind: "runtime_configuration" as const,
      change: {
        operation: "llama_cpp_setup" as const,
        managementMode: "external" as const,
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-model",
      },
    };
    await expect(adapter.prepare(context, request)).rejects.toThrow("did not freshly advertise");
    expect(updateSettings).not.toHaveBeenCalled();
    previewLlamaModels.mockResolvedValue({ source: "live", items: [{ id: "local-model" }] });
    const prepared = await adapter.prepare(context, request);
    await expect(
      adapter.apply(context, { request, target: prepared.target, origin: context.origin } as ChangePlanRecord),
    ).rejects.toThrow("previous Chat default was retained");
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(current.llm).toMatchObject({ activeProviderId: "openai", activeModel: "current" });
  });

  it("applies managed setup only after revalidating the opaque file selection", async () => {
    let current = settings({
      llm: { activeProviderId: "openai", activeModel: "current", defaultThinkingLevel: "standard" },
      llamaCpp: { managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1" },
    });
    const updateSettings = vi.fn(async (input) => {
      current = settings({
        ...current,
        revision: current.revision + 1,
        llamaCpp: { ...current.llamaCpp, ...input.llamaCpp },
        llm: { ...current.llm, ...input.llm },
      });
      return current;
    });
    const resolveManagedSelection = vi.fn(
      async () =>
        ({
          modelId: "file.gguf",
          alias: "file",
          command: "C:/llama/llama-server.exe",
          modelPath: "C:/models/file.gguf",
        }) as any,
    );
    const discardManagedSelection = vi.fn();
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: async () => current,
      updateSettings,
      resolveManagedSelection,
      discardManagedSelection,
      previewLlamaModels: async () => ({ source: "live", items: [{ id: "file" }] }),
      refreshLlamaRuntime: async () => ({ healthy: true, leaseDiagnostics: { ownership: "owned" } }) as any,
    });
    const request = {
      kind: "runtime_configuration" as const,
      change: {
        operation: "llama_cpp_setup" as const,
        managementMode: "managed" as const,
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "file",
        selectionId: "selection-1",
        autoStart: true,
      },
    };
    const prepared = await adapter.prepare(context, request);
    const plan = { request, target: prepared.target, origin: context.origin } as ChangePlanRecord;
    resolveManagedSelection.mockRejectedValueOnce(new Error("GGUF missing"));
    await expect(adapter.apply(context, plan)).rejects.toThrow("GGUF missing");
    expect(updateSettings).not.toHaveBeenCalled();
    const applied = await adapter.apply(context, plan);
    expect(applied.status).toBe("verifying");
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 7,
      llamaCpp: { managementMode: "managed", autoStart: true, modelPath: "C:/models/file.gguf" },
    });
    expect(updateSettings.mock.calls[1]?.[0]).toEqual({
      expectedRevision: 8,
      llm: { activeProviderId: "llamacpp", activeModel: "file", defaultThinkingLevel: "off" },
    });
    const receiver = resolveManagedSelection.mock.contexts[0];
    expect(receiver).toMatchObject({ resolveManagedSelection, updateSettings, discardManagedSelection });
    expect(resolveManagedSelection.mock.contexts.every((current) => current === receiver)).toBe(true);
    expect(updateSettings.mock.contexts.every((current) => current === receiver)).toBe(true);
    expect(discardManagedSelection.mock.contexts).toEqual([receiver]);
    expect(current.llm).toMatchObject({
      activeProviderId: "llamacpp",
      activeModel: "file",
      defaultThinkingLevel: "off",
    });
    expect(discardManagedSelection).toHaveBeenCalledWith("selection-1");
    expect((await adapter.verify(context, plan)).status).toBe("completed");
  });

  it("rejects a persisted named tool profile plan after retirement", async () => {
    const updateSettings = vi.fn();
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: async () => settings(),
      updateSettings,
    });
    const request = {
      kind: "runtime_configuration",
      change: { operation: "default_tool_profile", profileId: "danger" },
    } as never;

    await expect(adapter.prepare(context, request)).rejects.toThrow("Named tool profile changes are retired");
    await expect(adapter.apply(context, { request } as ChangePlanRecord)).rejects.toThrow(
      "Named tool profile changes are retired",
    );
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("applies reviewed pack flags together at one revision and keeps protected flags dangerous", async () => {
    let current = settings();
    const updateSettings = vi.fn(async (input) => {
      current = settings({ revision: 8, features: { ...current.features, ...input.features } });
      return current;
    });
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: async () => current,
      updateSettings,
    });
    const request = {
      kind: "runtime_configuration",
      change: {
        operation: "feature_flags",
        flags: {
          memoryLifecycleAdminV1Enabled: true,
          memoryMaintenanceV1Enabled: true,
        },
      },
    } as const;
    const prepared = await adapter.prepare(context, request);
    const plan = { request, target: prepared.target } as ChangePlanRecord;
    await adapter.apply(context, plan);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ expectedRevision: 7, features: request.change.flags });
    expect((await adapter.verify(context, plan)).status).toBe("completed");
    expect(
      (
        await adapter.prepare(context, {
          kind: "runtime_configuration",
          change: { operation: "feature_flags", flags: { productSourceEvolutionV1Enabled: true } },
        })
      ).risk,
    ).toBe("danger");
  });
  it("maps only registered typed operations to the settings owner", async () => {
    const updateSettings = vi.fn(async (input) => settings({ revision: 8, budgetMode: input.budgetMode }));
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => settings()),
      updateSettings,
    });
    const prepared = await adapter.prepare(context, {
      kind: "runtime_configuration",
      change: { operation: "budget_mode", mode: "power" },
    });
    expect(prepared.target).toEqual({
      ownerId: "runtime_settings",
      resourceId: "budget_mode",
      expectedRevision: 7,
    });

    const outcome = await adapter.apply(context, {
      request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "power" } },
      target: prepared.target,
    } as ChangePlanRecord);

    expect(updateSettings).toHaveBeenCalledWith({ expectedRevision: 7, budgetMode: "power" });
    expect(outcome.status).toBe("verifying");
  });

  it("fails closed when the settings revision changed after preparation", async () => {
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => settings({ revision: 8 })),
      updateSettings: vi.fn(),
    });
    await expect(
      adapter.apply(context, {
        request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "power" } },
        target: { ownerId: "runtime_settings", resourceId: "budget_mode", expectedRevision: 7 },
      } as ChangePlanRecord),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("classifies enabling source evolution as danger", async () => {
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => settings()),
      updateSettings: vi.fn(),
    });
    const prepared = await adapter.prepare(context, {
      kind: "runtime_configuration",
      change: { operation: "feature_flag", flag: "productSourceEvolutionV1Enabled", enabled: true },
    });
    expect(prepared.risk).toBe("danger");
  });

  it("classifies turning on the Settings approval skip as danger and turning it off as caution", async () => {
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => settings()),
      updateSettings: vi.fn(),
    });
    const prepare = (enabled: boolean) =>
      adapter.prepare(context, {
        kind: "runtime_configuration",
        change: { operation: "feature_flag", flag: "settingsApprovalSkipEnabled", enabled },
      });
    const on = await prepare(true);
    expect(on.risk).toBe("danger");
    expect(on.title).toBe("Turn on Apply my Settings and Capabilities changes without asking first");
    expect((await prepare(false)).risk).toBe("caution");
  });

  it("names a Settings switch in plain words and says how to undo it, not by its flag key (#496)", async () => {
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => settings()),
      updateSettings: vi.fn(async () => settings({ revision: 8 })),
    });
    const request = {
      kind: "runtime_configuration" as const,
      change: { operation: "feature_flag" as const, flag: "claudeCliWarmContinuationEnabled" as const, enabled: true },
    };
    const prepared = await adapter.prepare(context, request);
    expect(prepared.title).toBe("Turn on Claude Code CLI: reuse one process between tool steps");
    expect(prepared.summary).toMatch(/keeps that turn's Claude Code process running/);
    expect(prepared.impact).toMatch(/turn it off again the same way/i);
    // The impact reaches the approval's explanation, so a named switch never shows its key there either.
    expect(`${prepared.title} ${prepared.summary} ${prepared.impact}`).not.toContain(
      "claudeCliWarmContinuationEnabled",
    );
    const applied = await adapter.apply(context, { request, target: prepared.target } as ChangePlanRecord);
    expect(applied.result?.summary).toBe("Claude Code CLI: reuse one process between tool steps is now on.");
  });

  it("maps a typed memory group without exposing arbitrary setting keys", async () => {
    const current = settings({
      memory: {
        enabled: false,
        qmd: {
          enabled: false,
          applyToChat: false,
          applyToOrchestration: false,
          maxContextTokens: 4_096,
          minPromptChars: 80,
          cacheTtlSeconds: 300,
        },
      },
    });
    const updateSettings = vi.fn(async () => settings({ revision: 8 }));
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => current),
      updateSettings,
    });
    const request = {
      kind: "runtime_configuration" as const,
      change: { operation: "memory_configuration" as const, config: { enabled: true, qmdEnabled: true } },
    };
    const prepared = await adapter.prepare(context, request);
    expect(prepared.risk).toBe("caution");
    await adapter.apply(context, { request, target: prepared.target } as ChangePlanRecord);
    expect(updateSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
      memory: { enabled: true, qmdEnabled: true },
    });
  });

  it("validates utility models against the live provider catalog before confirmation", async () => {
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () =>
        settings({
          llm: {
            providers: [{ providerId: "openai", label: "OpenAI", authReadiness: { status: "ready" } }],
          },
        }),
      ),
      updateSettings: vi.fn(),
      listModels: vi.fn(async () => [{ id: "gpt-5.5" }, { id: "gpt-5-mini" }]),
    });
    await expect(
      adapter.prepare(context, {
        kind: "runtime_configuration",
        change: { operation: "utility_model", providerId: "openai", model: "missing-model" },
      }),
    ).rejects.toMatchObject({ httpStatus: 422, details: { alternatives: ["gpt-5.5", "gpt-5-mini"] } });
  });

  it("keeps Gateway auth credentials in the dedicated owner flow", async () => {
    const current = settings({
      auth: { mode: "none", allowLoopbackBypass: true, tokenConfigured: false, basicConfigured: false },
    });
    const updateSettings = vi.fn(async () =>
      settings({
        revision: 8,
        auth: { mode: "token", allowLoopbackBypass: false, tokenConfigured: true, basicConfigured: false },
      }),
    );
    const consumeTemporaryAuthCredential = vi.fn(async () => "private-token-value");
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      getSettings: vi.fn(async () => current),
      updateSettings,
      hasTemporaryAuthCredential: vi.fn(async () => true),
      consumeTemporaryAuthCredential,
      discardTemporaryAuthCredential: vi.fn(),
    });
    const request = {
      kind: "runtime_configuration" as const,
      change: {
        operation: "gateway_auth_configuration" as const,
        mode: "token" as const,
        allowLoopbackBypass: false,
        replaceCredential: true,
      },
    };
    const prepared = await adapter.prepare(context, request);
    expect(prepared.status).toBe("awaiting_input");
    expect(JSON.stringify(prepared)).not.toContain("private-token-value");
    const resumed = await adapter.resumeOwnerInput(
      context,
      {
        planId: "plan-auth",
        request,
      } as ChangePlanRecord,
      {
        actionId: "secure-1",
        actionKind: "secure_input",
        ownerId: "gateway_auth_temporary_secret",
        ownerResourceId: "gateway-auth",
        evidenceRefs: ["gateway-auth:temporary-credential-captured"],
      },
    );
    expect(resumed.status).toBe("awaiting_confirmation");
    await adapter.apply(context, {
      planId: "plan-auth",
      request,
      target: prepared.target,
    } as ChangePlanRecord);
    expect(consumeTemporaryAuthCredential).toHaveBeenCalledWith("plan-auth");
    expect(updateSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
      auth: { mode: "token", allowLoopbackBypass: false, token: "private-token-value" },
    });
  });

  describe("runtime write access", () => {
    const outside = process.platform === "win32" ? "D:\\scratch\\out" : "/srv/scratch/out";

    /** By default every group that is off is the operator's own switch, with no plugin holding one. */
    function writeAccessSettings(overrides: Record<string, unknown> = {}) {
      const switchedOff = overrides.switchedOffToolGroups ?? [];
      return settings({
        operatorWriteRoots: [],
        globalToolAccess: { allow: ["fs.read"], deny: ["fs.write", "fs.delete"] },
        switchedOffToolGroups: switchedOff,
        operatorSwitchedOffToolGroups: switchedOff,
        pluginToolGroupHolds: [],
        ...overrides,
      });
    }

    function writeAccessAdapter(current: () => any, validateSettingsUpdate = vi.fn(async () => undefined)) {
      const updateSettings = vi.fn(async () => current());
      const adapter = new RuntimeConfigurationChangePlanAdapter({
        ...authCredentialDeps,
        getSettings: vi.fn(async () => current()),
        updateSettings,
        validateSettingsUpdate,
      });
      return { adapter, updateSettings, validateSettingsUpdate };
    }

    it.each([
      [{ action: "add", path: outside, allowDelete: true }, "danger"],
      [{ action: "add", path: outside }, "caution"],
      [{ action: "add", preset: "os_temp", allowDelete: false }, "caution"],
      [{ action: "remove", path: outside }, "caution"],
    ] as const)("classifies operator write root %o as %s", async (change, risk) => {
      const { adapter } = writeAccessAdapter(() => writeAccessSettings());
      const prepared = await adapter.prepare(context, {
        kind: "runtime_configuration",
        change: { operation: "operator_write_root", ...change },
      });
      expect(prepared.risk).toBe(risk);
      if (change.action === "add") expect(prepared.impact).toContain("Deny-wins still applies");
    });

    it.each([
      ["fs.delete", "available", "danger"],
      ["fs.write", "available", "danger"],
      ["fs.write", "unlisted", "danger"],
      ["fs.copy", "available", "caution"],
      ["fs.delete", "denied", "safe"],
    ] as const)("classifies %s -> %s as %s", async (toolName, posture, risk) => {
      const { adapter } = writeAccessAdapter(() => writeAccessSettings());
      const prepared = await adapter.prepare(context, {
        kind: "runtime_configuration",
        change: { operation: "tool_global_access", toolName, posture },
      });
      expect(prepared.risk).toBe(risk);
      expect(prepared.target.resourceId).toBe(`tool_global_access:${toolName}`);
    });

    it.each([
      ["files", false, "safe", "Switch off the Files tools", "The AI can't use the Files tools in any chat."],
      [
        "shell_and_code",
        false,
        "safe",
        "Switch off the Shell and code tools",
        "The AI can't use the Shell and code tools in any chat.",
      ],
      [
        "files",
        true,
        "caution",
        "Switch the Files tools back on",
        "The Files tools are back on. Other safety rules still apply.",
      ],
      [
        "email_and_calendar",
        true,
        "caution",
        "Switch the Email and calendar tools back on",
        "The Email and calendar tools are back on. Other safety rules still apply.",
      ],
    ] as const)(
      "treats switching off as safe and switching on as caution, in the operator's words (%s, enabled: %s)",
      async (groupId, enabled, risk, title, completedSummary) => {
        const { adapter, updateSettings } = writeAccessAdapter(() =>
          writeAccessSettings({ switchedOffToolGroups: enabled ? [groupId] : [] }),
        );
        const request = {
          kind: "runtime_configuration" as const,
          change: { operation: "tool_group_access" as const, groupId, enabled },
        };

        const prepared = await adapter.prepare(context, request);

        expect(prepared.risk).toBe(risk);
        expect(prepared.title).toBe(title);
        expect(prepared.target.resourceId).toBe(`tool_group_access:${groupId}`);
        const applied = await adapter.apply(context, { request, target: prepared.target } as ChangePlanRecord);
        expect(applied.result?.summary).toBe(completedSummary);
        expect(updateSettings).toHaveBeenCalledWith({
          expectedRevision: 7,
          toolGroupChange: { groupId, enabled },
        });
      },
    );

    it("keeps the written copy for a group switch free of banned cockpit words", async () => {
      const { adapter } = writeAccessAdapter(() => writeAccessSettings());
      for (const enabled of [false, true]) {
        const prepared = await adapter.prepare(context, {
          kind: "runtime_configuration",
          change: { operation: "tool_group_access", groupId: "browser", enabled },
        });
        const copy = [prepared.title, prepared.summary, prepared.impact].join(" ");
        expect(copy).not.toMatch(
          /posture|gateway|revision|evidence|owner|snapshot|canonical|durable|projection|replay/i,
        );
        expect(prepared.summary).toContain("Browser");
      }
    });

    it("validates a group switch through the settings owner before preparing", async () => {
      const validateSettingsUpdate = vi.fn(async () => {
        throw new Error("toolGroupChange must name a tool group other than Core.");
      });
      const { adapter } = writeAccessAdapter(() => writeAccessSettings(), validateSettingsUpdate);

      await expect(
        adapter.prepare(context, {
          kind: "runtime_configuration",
          change: { operation: "tool_group_access", groupId: "files", enabled: false },
        }),
      ).rejects.toThrow(/toolGroupChange/);
      expect(validateSettingsUpdate).toHaveBeenCalledWith({
        expectedRevision: 7,
        toolGroupChange: { groupId: "files", enabled: false },
      });
    });

    it("verifies a group switch against the groups the settings owner reports as off", async () => {
      let current = writeAccessSettings();
      const { adapter } = writeAccessAdapter(() => current);
      const off = {
        kind: "runtime_configuration" as const,
        change: { operation: "tool_group_access" as const, groupId: "files" as const, enabled: false },
      };
      const on = {
        kind: "runtime_configuration" as const,
        change: { operation: "tool_group_access" as const, groupId: "files" as const, enabled: true },
      };
      const offPlan = { request: off, target: (await adapter.prepare(context, off)).target } as ChangePlanRecord;
      const onPlan = { request: on, target: (await adapter.prepare(context, on)).target } as ChangePlanRecord;

      expect((await adapter.verify(context, offPlan)).status).toBe("manual_required");
      expect((await adapter.verify(context, onPlan)).status).toBe("completed");

      current = writeAccessSettings({ switchedOffToolGroups: ["files", "git"] });
      expect((await adapter.verify(context, offPlan)).status).toBe("completed");
      expect((await adapter.verify(context, onPlan)).status).toBe("manual_required");

      // A different group being off says nothing about this one.
      current = writeAccessSettings({ switchedOffToolGroups: ["git"] });
      expect((await adapter.verify(context, offPlan)).status).toBe("manual_required");
      expect((await adapter.verify(context, onPlan)).status).toBe("completed");
    });

    it("never reads a plugin's hold as the operator's own switch, so an interrupted switch-off isn't taken as written (F8)", async () => {
      // A plugin holds Browser off; the operator's own switch for it was never written.
      const held = writeAccessSettings({
        switchedOffToolGroups: ["browser"],
        operatorSwitchedOffToolGroups: [],
        pluginToolGroupHolds: [{ groupId: "browser", pluginId: "meeting-tools", pluginName: "Meeting tools" }],
      });
      let current = held;
      const { adapter } = writeAccessAdapter(() => current);
      const request = {
        kind: "runtime_configuration" as const,
        change: { operation: "tool_group_access" as const, groupId: "browser" as const, enabled: false },
      };
      const plan = { request, target: (await adapter.prepare(context, request)).target } as ChangePlanRecord;

      // The Gateway stopped before the write: recovery reports it, rather than marking the plan done.
      await expect(adapter.reconcile(context, plan)).resolves.toMatchObject({
        effectObserved: false,
        status: "manual_required",
      });
      expect((await adapter.verify(context, plan)).status).toBe("manual_required");

      // Once the operator's own switch is written, it reads as done, hold or not.
      current = { ...held, operatorSwitchedOffToolGroups: ["browser"] };
      await expect(adapter.reconcile(context, plan)).resolves.toMatchObject({
        effectObserved: true,
        status: "completed",
      });
    });

    it.each([
      ["approval_required", "danger"],
      ["deny", "safe"],
    ] as const)("classifies the outside-root write policy %s as %s", async (mode, risk) => {
      const { adapter } = writeAccessAdapter(() => writeAccessSettings());
      const prepared = await adapter.prepare(context, {
        kind: "runtime_configuration",
        change: { operation: "outside_root_write_policy", mode },
      });
      expect(prepared.risk).toBe(risk);
      if (mode === "approval_required") expect(prepared.impact).toContain("deny-wins and Citadel Wards still apply");
    });

    it("says un-denying makes the tool callable with approval in every write root", async () => {
      const { adapter } = writeAccessAdapter(() => writeAccessSettings());
      const prepared = await adapter.prepare(context, {
        kind: "runtime_configuration",
        change: { operation: "tool_global_access", toolName: "fs.delete", posture: "available" },
      });
      expect(prepared.summary).toBe("Change the global posture of fs.delete from denied to available.");
      expect(prepared.impact).toContain("makes it callable, with approval, in every write root");
      expect(prepared.impact).toContain("Deny-wins still applies");
    });

    it("validates through the settings owner before preparing and fails closed without it", async () => {
      const validateSettingsUpdate = vi.fn(async () => {
        throw new Error("Folder cannot be an operator write root (runtime_protected_path)");
      });
      const { adapter } = writeAccessAdapter(() => writeAccessSettings(), validateSettingsUpdate);
      const request = {
        kind: "runtime_configuration" as const,
        change: { operation: "operator_write_root" as const, action: "add" as const, path: outside },
      };
      await expect(adapter.prepare(context, request)).rejects.toThrow(/runtime_protected_path/);
      expect(validateSettingsUpdate).toHaveBeenCalledWith({
        expectedRevision: 7,
        operatorWriteRootChange: { action: "add", path: outside },
      });

      const withoutOwner = new RuntimeConfigurationChangePlanAdapter({
        ...authCredentialDeps,
        getSettings: vi.fn(async () => writeAccessSettings()),
        updateSettings: vi.fn(),
      });
      await expect(withoutOwner.prepare(context, request)).rejects.toThrow(/settings owner is unavailable/);
    });

    it("applies typed settings patches and verifies the owner state", async () => {
      let current = writeAccessSettings();
      const { adapter, updateSettings } = writeAccessAdapter(() => current);
      const rootRequest = {
        kind: "runtime_configuration" as const,
        change: { operation: "operator_write_root" as const, action: "add" as const, path: outside, label: "Out" },
      };
      const prepared = await adapter.prepare(context, rootRequest);
      const plan = { request: rootRequest, target: prepared.target } as ChangePlanRecord;
      await adapter.apply(context, plan);
      expect(updateSettings).toHaveBeenCalledWith({
        expectedRevision: 7,
        operatorWriteRootChange: { action: "add", path: outside, label: "Out" },
      });
      expect((await adapter.verify(context, plan)).status).toBe("manual_required");
      current = writeAccessSettings({ operatorWriteRoots: [{ path: outside, allowDelete: false }] });
      expect((await adapter.verify(context, plan)).status).toBe("completed");

      const toolRequest = {
        kind: "runtime_configuration" as const,
        change: {
          operation: "tool_global_access" as const,
          toolName: "fs.write" as const,
          posture: "available" as const,
        },
      };
      const toolPlan = { request: toolRequest, target: (await adapter.prepare(context, toolRequest)).target };
      await adapter.apply(context, toolPlan as ChangePlanRecord);
      expect(updateSettings).toHaveBeenLastCalledWith({
        expectedRevision: 7,
        globalToolAccessChange: { toolName: "fs.write", posture: "available" },
      });
      expect((await adapter.verify(context, toolPlan as ChangePlanRecord)).status).toBe("manual_required");
      current = writeAccessSettings({ globalToolAccess: { allow: ["fs.read", "fs.write"], deny: ["fs.delete"] } });
      expect((await adapter.verify(context, toolPlan as ChangePlanRecord)).status).toBe("completed");
    });
  });
});

describe("RuntimeConfigurationChangePlanAdapter public web address", () => {
  const setRequest = (publicWebAddress: string | null) =>
    ({
      kind: "runtime_configuration" as const,
      change: { operation: "public_web_address_configuration" as const, config: { publicWebAddress } },
    }) as const;

  function addressAdapter(initial: Record<string, unknown> = {}) {
    let current = settings({ revision: 7, ...initial });
    const updateSettings = vi.fn(async (input: Record<string, unknown>) => {
      const { expectedRevision: _expectedRevision, ...patch } = input;
      const next = { ...current, ...patch, revision: current.revision + 1 };
      if (patch.publicWebAddress === null) delete next.publicWebAddress;
      current = next;
      return current;
    });
    const validateSettingsUpdate = vi.fn(async () => undefined);
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: async () => current,
      updateSettings,
      validateSettingsUpdate,
    });
    return { adapter, updateSettings, validateSettingsUpdate };
  }

  it("prepares a set as a caution that names the address, targeted at its own resource", async () => {
    const { adapter } = addressAdapter();
    const prepared = await adapter.prepare(context, setRequest("https://example.com"));

    expect(prepared).toMatchObject({
      target: { ownerId: "runtime_settings", resourceId: "public_web_address_configuration", expectedRevision: 7 },
      summary: "Set GoatCitadel's public web address to https://example.com",
      risk: "caution",
      status: "awaiting_confirmation",
      requiredAction: {
        kind: "confirmation",
        confirmationText: "Set GoatCitadel's public web address to https://example.com",
      },
    });
  });

  it("prepares a clear as a caution", async () => {
    const { adapter } = addressAdapter({ publicWebAddress: "https://example.com" });
    const prepared = await adapter.prepare(context, setRequest(null));

    expect(prepared).toMatchObject({
      target: { resourceId: "public_web_address_configuration" },
      summary: "Clear GoatCitadel's public web address",
      risk: "caution",
      status: "awaiting_confirmation",
    });
  });

  it("keeps the written copy free of banned cockpit words", async () => {
    const { adapter } = addressAdapter();
    for (const address of ["https://example.com", null]) {
      const prepared = await adapter.prepare(context, setRequest(address));
      const copy = [prepared.title, prepared.summary, prepared.impact].join(" ");
      expect(copy).not.toMatch(/posture|gateway|revision|evidence|owner|snapshot|canonical|durable|projection|replay/i);
    }
  });

  it("names the normalized address when a plan carries an address that was not tidied", async () => {
    const { adapter } = addressAdapter();
    const prepared = await adapter.prepare(context, setRequest("  https://Example.com/goat/ "));

    expect(prepared.summary).toBe("Set GoatCitadel's public web address to https://example.com/goat");
  });

  it.each([
    ["example.com", PUBLIC_WEB_ADDRESS_NOT_URL],
    ["http://example.com", PUBLIC_WEB_ADDRESS_NOT_HTTPS],
    ["https://user:pw@example.com", PUBLIC_WEB_ADDRESS_HAS_LOGIN],
    ["https://example.com/?a=1", PUBLIC_WEB_ADDRESS_HAS_EXTRA],
    ["https://192.168.1.5", PUBLIC_WEB_ADDRESS_NOT_PUBLIC],
    ["https://" + "a".repeat(200) + ".com", PUBLIC_WEB_ADDRESS_TOO_LONG],
  ])("refuses to prepare %s with its own sentence", async (address, sentence) => {
    const { adapter, updateSettings } = addressAdapter();

    const error = await adapter.prepare(context, setRequest(address)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe(sentence);
    expect((error as ValidationError).httpStatus).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("needs no second dry run, because the address check is the owner's whole check", async () => {
    const { adapter, validateSettingsUpdate } = addressAdapter();
    await adapter.prepare(context, setRequest("https://example.com"));
    expect(validateSettingsUpdate).not.toHaveBeenCalled();
  });

  it("hands the address to the settings owner to store, and null to clear it", async () => {
    const { adapter, updateSettings } = addressAdapter();
    const set = setRequest("https://example.com/goat");
    const prepared = await adapter.prepare(context, set);
    await adapter.apply(context, { request: set, target: prepared.target } as ChangePlanRecord);
    expect(updateSettings).toHaveBeenLastCalledWith({
      expectedRevision: 7,
      publicWebAddress: "https://example.com/goat",
    });

    const clear = setRequest(null);
    const clearing = await adapter.prepare(context, clear);
    await adapter.apply(context, {
      request: clear,
      target: { ...clearing.target, expectedRevision: 8 },
    } as ChangePlanRecord);
    expect(updateSettings).toHaveBeenLastCalledWith({ expectedRevision: 8, publicWebAddress: null });
  });

  it("verifies an address that was not tidied against the tidied one the settings owner stores", async () => {
    const untidy = setRequest("  https://Example.com/goat/ ");
    const stored = addressAdapter({ publicWebAddress: "https://example.com/goat" });
    const target = { ownerId: "runtime_settings", resourceId: "public_web_address_configuration", expectedRevision: 7 };

    await expect(
      stored.adapter.verify(context, { request: untidy, target } as ChangePlanRecord),
    ).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("verifies against the owner: set matches only the same address, clear only an unset one", async () => {
    const set = setRequest("https://example.com");
    const clear = setRequest(null);
    const unset = addressAdapter();
    const same = addressAdapter({ publicWebAddress: "https://example.com" });
    const other = addressAdapter({ publicWebAddress: "https://other.example.com" });
    const target = { ownerId: "runtime_settings", resourceId: "public_web_address_configuration", expectedRevision: 7 };

    const verify = async (harness: ReturnType<typeof addressAdapter>, request: typeof set | typeof clear) =>
      (await harness.adapter.verify(context, { request, target } as ChangePlanRecord)).status;

    expect(await verify(same, set)).toBe("completed");
    expect(await verify(unset, set)).toBe("manual_required");
    expect(await verify(other, set)).toBe("manual_required");
    expect(await verify(unset, clear)).toBe("completed");
    expect(await verify(same, clear)).toBe("manual_required");
  });

  it("does not take a reconcile for done when the owner holds a different address", async () => {
    const { adapter } = addressAdapter({ publicWebAddress: "https://other.example.com" });
    const result = await adapter.reconcile(context, {
      request: setRequest("https://example.com"),
      target: { ownerId: "runtime_settings", resourceId: "public_web_address_configuration", expectedRevision: 7 },
    } as ChangePlanRecord);
    expect(result).toMatchObject({ effectObserved: false, status: "manual_required" });
  });
});
