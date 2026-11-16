import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const promptQueues = {
  input: [] as string[],
  password: [] as string[],
  select: [] as string[],
  confirm: [] as boolean[],
};

const inputMock = vi.fn(async (config?: { default?: string; message?: string }) => {
  const next = promptQueues.input.shift();
  return next ?? config?.default ?? "";
});
const passwordMock = vi.fn(async () => promptQueues.password.shift() ?? "");
const selectMock = vi.fn(async (config?: { default?: string; message?: string }) => {
  const next = promptQueues.select.shift();
  return next ?? config?.default ?? "";
});
const confirmMock = vi.fn(async (config?: { default?: boolean; message?: string }) => {
  const next = promptQueues.confirm.shift();
  return next ?? config?.default ?? false;
});

vi.mock("@inquirer/prompts", () => ({
  input: inputMock,
  password: passwordMock,
  select: selectMock,
  confirm: confirmMock,
}));

vi.mock("@goatcitadel/contracts", () => ({
  providerTemplates: [
    {
      providerId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
    },
    {
      providerId: "glm",
      label: "GLM (Z.AI)",
      baseUrl: "https://api.z.ai/api/paas/v4",
      defaultModel: "glm-5",
    },
    { providerId: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.1" },
    { providerId: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", defaultModel: "local-model" },
    { providerId: "llamacpp", label: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", defaultModel: "gemma-4-local" },
    {
      providerId: "moonshot",
      label: "Moonshot (Kimi API)",
      baseUrl: "https://api.moonshot.ai/v1",
      defaultModel: "kimi-k2.6",
    },
  ],
}));

const spawnMock = vi.fn(() => ({
  unref: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("onboarding tui entrypoint coverage", () => {
  beforeEach(() => {
    vi.resetModules();
    promptQueues.input = [];
    promptQueues.password = [];
    promptQueues.select = [];
    promptQueues.confirm = [];
    inputMock.mockClear();
    passwordMock.mockClear();
    selectMock.mockClear();
    confirmMock.mockClear();
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GOATCITADEL_GATEWAY_URL;
    delete process.env.GOATCITADEL_APP_DIR;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GLM_API_KEY;
    process.exitCode = undefined;
  });

  it("runs the guided wizard using default answers", async () => {
    // A provider key supplied by the environment keeps "Mark onboarding complete" defaulting to yes.
    process.env.OPENAI_API_KEY = "test-key-from-environment";
    const initialState = {
      completed: false,
      completedAt: null,
      completedBy: null,
      checklist: [
        { id: "gateway", label: "Gateway access control", status: "complete", detail: "Mode none is configured." },
        { id: "llm", label: "LLM provider", status: "needs_input", detail: "Select an active provider/model." },
      ],
      settings: {
        defaultToolProfile: "minimal",
        budgetMode: "balanced",
        networkAllowlist: [],
        auth: {
          mode: "none",
          allowLoopbackBypass: true,
        },
        llm: {
          activeProviderId: "openai",
          activeModel: "gpt-4.1-mini",
          providers: [
            {
              providerId: "openai",
              label: "OpenAI",
              baseUrl: "https://api.openai.com/v1",
              defaultModel: "gpt-4.1-mini",
            },
          ],
        },
        mesh: {
          enabled: false,
          mode: "lan",
          nodeId: "node-local",
          mdns: true,
          staticPeers: [],
          requireMtls: false,
          tailnetEnabled: false,
        },
      },
    };

    const bootstrap = {
      appliedAt: new Date().toISOString(),
      state: {
        completed: true,
        checklist: [
          { id: "gateway", label: "Gateway access control", status: "complete" },
          { id: "llm", label: "LLM provider", status: "complete" },
        ],
      },
    };

    const llmConfig = {
      activeProviderId: "openai",
      activeModel: "gpt-4.1-mini",
      providers: [],
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(initialState), { status: 200, headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: "gpt-4.1-mini" }], source: "live" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(bootstrap), { status: 200, headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: bootstrap.state }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmConfig), { status: 200, headers: { "content-type": "application/json" } }),
      );

    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./onboarding-tui.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const bootstrapBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(bootstrapBody.auth).toMatchObject({ mode: "none", allowLoopbackBypass: false });
    expect(selectMock).toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalled();
    const promptedMessages = inputMock.mock.calls.map(([config]) => config?.message);
    expect(promptedMessages).not.toContain("Provider ID");
    expect(promptedMessages).not.toContain("Provider label");
    expect(promptedMessages).not.toContain("Provider API key env var");
    expect(promptedMessages).not.toContain("Provider default model");
    expect(errorSpy).not.toHaveBeenCalledWith("Onboarding wizard failed.");
  });

  it("auto-starts loopback gateway when the first onboarding probe fails", async () => {
    process.env.GOATCITADEL_APP_DIR = "C:/Users/test/.GoatCitadel/app";
    promptQueues.confirm = [true, true, false, true, true];

    const initialState = {
      completed: false,
      completedAt: null,
      completedBy: null,
      checklist: [],
      settings: {
        defaultToolProfile: "minimal",
        budgetMode: "balanced",
        networkAllowlist: [],
        auth: { mode: "none", allowLoopbackBypass: true },
        llm: {
          activeProviderId: "glm",
          activeModel: "glm-5",
          providers: [
            {
              providerId: "glm",
              label: "GLM (Z.AI)",
              baseUrl: "https://api.z.ai/api/paas/v4",
              defaultModel: "glm-5",
            },
          ],
        },
        mesh: {
          enabled: false,
          mode: "lan",
          nodeId: "node-local",
          mdns: true,
          staticPeers: [],
          requireMtls: false,
          tailnetEnabled: false,
        },
      },
    };

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(initialState), { status: 200, headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: "glm-5" }], source: "live" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ appliedAt: new Date().toISOString(), state: { completed: true, checklist: [] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: { completed: true, checklist: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ activeProviderId: "glm", activeModel: "glm-5", providers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await import("./onboarding-tui.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  const wizardState = {
    completed: false,
    completedAt: null,
    completedBy: null,
    checklist: [],
    settings: {
      defaultToolProfile: "minimal",
      budgetMode: "balanced",
      networkAllowlist: [],
      auth: { mode: "none", allowLoopbackBypass: true },
      llm: {
        activeProviderId: "glm",
        activeModel: "glm-5",
        providers: [
          { providerId: "glm", label: "GLM (Z.AI)", baseUrl: "https://api.z.ai/api/paas/v4", defaultModel: "glm-5" },
        ],
      },
      mesh: {
        enabled: false,
        mode: "lan",
        nodeId: "node-local",
        mdns: true,
        staticPeers: [],
        requireMtls: false,
        tailnetEnabled: false,
      },
    },
  };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("exits quietly when the operator presses Ctrl+C", async () => {
    inputMock.mockRejectedValueOnce(
      Object.assign(new Error("User force closed the prompt with SIGINT"), { name: "ExitPromptError" }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await import("./onboarding-tui.js");
    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith("Cancelled. Nothing was changed."));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the settings were saved but the key was not, and does not mark setup complete", async () => {
    promptQueues.password = ["typed-secret-key-123"];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(wizardState))
      .mockResolvedValueOnce(json({ items: [{ id: "glm-5" }], source: "live" }))
      .mockResolvedValueOnce(
        json({
          appliedAt: new Date().toISOString(),
          state: { completed: false, checklist: [], settings: { revision: "r1" } },
        }),
      )
      .mockResolvedValueOnce(new Response("keychain unavailable for typed-secret-key-123", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./onboarding-tui.js");
    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.flat().join(" ")).toContain("Provider settings were saved, but the key was not:"),
    );

    const printed = errorSpy.mock.calls.flat().join(" ");
    expect(printed).toContain("Add the key in Settings > Models > Providers & models, or run the wizard again.");
    expect(printed).not.toContain("typed-secret-key-123");
    expect(printed).toContain("no secure storage is available on this computer");
    expect(printed).not.toMatch(/api\/v1|\(503\)|keychain unavailable/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/onboarding/complete"))).toBe(false);
    expect(errorSpy).not.toHaveBeenCalledWith("Onboarding wizard failed.");
    expect(process.exitCode).toBe(1);
  });

  it("defaults completion to no and says so when the provider has no key", async () => {
    delete process.env.GLM_API_KEY;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(wizardState))
      .mockResolvedValueOnce(json({ items: [{ id: "glm-5" }], source: "live" }))
      .mockResolvedValueOnce(
        json({
          appliedAt: new Date().toISOString(),
          state: { completed: false, checklist: [], settings: { revision: "r1" } },
        }),
      )
      .mockResolvedValueOnce(json({ activeProviderId: "glm", activeModel: "glm-5", providers: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./onboarding-tui.js");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    const completion = confirmMock.mock.calls.find(([config]) => config?.message === "Mark onboarding complete now?");
    expect(completion?.[0]?.default).toBe(false);
    expect(logSpy.mock.calls.flat().join(" ")).toContain(
      "No provider key is set, so Chat will not answer until you add one.",
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/onboarding/complete"))).toBe(false);
  });

  async function runKeyScenario(options: {
    template?: string;
    providerHasKey?: { source: "keychain" | "env" | "inline" };
    typedKey?: string;
    saveTypedKey?: boolean;
  }): Promise<{ printed: string; completionDefault: boolean | undefined }> {
    const state = structuredClone(wizardState);
    if (options.providerHasKey) {
      Object.assign(state.settings.llm.providers[0] as object, {
        hasApiKey: true,
        apiKeySource: options.providerHasKey.source,
      });
    }
    if (options.template) {
      promptQueues.select = ["none", options.template];
    }
    if (options.typedKey) {
      promptQueues.password = [options.typedKey];
      promptQueues.confirm = [options.saveTypedKey ?? true];
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(state))
      .mockResolvedValueOnce(json({ items: [{ id: "glm-5" }], source: "live" }))
      .mockResolvedValueOnce(
        json({
          appliedAt: new Date().toISOString(),
          state: { completed: false, checklist: [], settings: { revision: "r1" } },
        }),
      )
      .mockResolvedValue(
        json({
          activeProviderId: "glm",
          activeModel: "glm-5",
          providers: [],
          state: { completed: true, checklist: [] },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await import("./onboarding-tui.js");
    await vi.waitFor(() =>
      expect(confirmMock.mock.calls.some(([c]) => c?.message === "Apply onboarding now?")).toBe(true),
    );
    const completion = confirmMock.mock.calls.find(([c]) => c?.message === "Mark onboarding complete now?");
    return { printed: logSpy.mock.calls.flat().join(" "), completionDefault: completion?.[0]?.default };
  }

  it("counts a key the Gateway already has as present", async () => {
    delete process.env.GLM_API_KEY;
    const result = await runKeyScenario({ providerHasKey: { source: "keychain" } });
    expect(result.printed).not.toContain("No provider key is set");
    expect(result.printed).toContain("already saved in the OS secure store");
    expect(result.completionDefault).toBe(true);
  });

  it("counts a key from the environment as present and says so", async () => {
    process.env.GLM_API_KEY = "from-environment";
    const result = await runKeyScenario({});
    expect(result.printed).not.toContain("No provider key is set");
    expect(result.printed).toContain("from the environment");
    expect(result.printed).not.toContain("from-environment");
    expect(result.completionDefault).toBe(true);
  });

  it.each(["ollama", "lmstudio", "llamacpp"])(
    "needs no key for the keyless local provider %s: no warning, completion default unchanged",
    async (template) => {
      const result = await runKeyScenario({ template });
      expect(result.printed).not.toContain("No provider key is set");
      expect(result.printed).toContain("not needed for this provider");
      expect(result.completionDefault).toBe(true);
    },
  );

  it("still reports a cloud provider with no key as missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await runKeyScenario({ template: "openai" });
    expect(result.printed).toContain("No provider key is set");
    expect(result.completionDefault).toBe(false);
  });

  it("keeps the typed-key behaviour for a local provider when a key was typed", async () => {
    const result = await runKeyScenario({ template: "ollama", typedKey: "typed-local-key-1", saveTypedKey: false });
    expect(result.printed).toContain("typed here, not saved");
    expect(result.printed).not.toContain("typed-local-key-1");
  });

  it("says a typed key was saved", async () => {
    const result = await runKeyScenario({ typedKey: "typed-secret-key-456", saveTypedKey: true });
    expect(result.printed).toContain("saved to the OS secure store");
    expect(result.printed).not.toContain("typed-secret-key-456");
    expect(result.completionDefault).toBe(true);
  });

  it("says typed here, not saved, even when the environment holds a key", async () => {
    process.env.GLM_API_KEY = "from-environment";
    const result = await runKeyScenario({ typedKey: "typed-secret-key-789", saveTypedKey: false });
    expect(result.printed).toContain("typed here, not saved");
    expect(result.printed).not.toContain("typed-secret-key-789");
    expect(result.printed).not.toContain("No provider key is set");
  });

  it("checks the gateway address and the model id before accepting them", async () => {
    inputMock.mockClear();
    inputMock.mockImplementationOnce(async (config) => {
      expect(config?.message).toBe("Gateway URL");
      expect((config as { validate?: (value: string) => unknown }).validate?.("not a url")).toBe(
        "Enter a full address that starts with http:// or https://.",
      );
      throw Object.assign(new Error("stop"), { name: "ExitPromptError" });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());

    await import("./onboarding-tui.js");
    await vi.waitFor(() => expect(inputMock).toHaveBeenCalledTimes(1));
  });

  it("logs failures when onboarding bootstrap fails", async () => {
    promptQueues.confirm = [false];
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    await import("./onboarding-tui.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).toHaveBeenCalledWith("Onboarding wizard failed.");
  });
});
