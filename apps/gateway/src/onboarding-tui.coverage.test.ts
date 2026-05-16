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
  });

  it("runs the guided wizard using default answers", async () => {
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
        new Response(JSON.stringify(llmConfig), { status: 200, headers: { "content-type": "application/json" } }),
      );

    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./onboarding-tui.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(4);
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
        new Response(JSON.stringify({ activeProviderId: "glm", activeModel: "glm-5", providers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await import("./onboarding-tui.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalled();
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
