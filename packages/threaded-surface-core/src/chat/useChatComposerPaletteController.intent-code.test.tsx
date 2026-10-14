import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useChatComposerPaletteController as PaletteHook } from "./useChatComposerPaletteController";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope = vi.hoisted(() => ({ caller: 0, access: 0, gateway: "http://gateway-a", loads: 0 }));
const api = vi.hoisted(() => ({ files: vi.fn(), packs: vi.fn(), tests: vi.fn(), artifacts: vi.fn(), notes: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScopeRevision: () => scope.caller,
  getGatewayAccessRevision: () => scope.access,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => scope.gateway }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchFilesList: api.files,
  fetchPromptPacks: api.packs,
  fetchPromptPackTests: api.tests,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatGeneratedArtifacts: api.artifacts }));
vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({ listNotes: api.notes }));

function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (cause?: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let hook: typeof PaletteHook;
let renderer: ReactTestRenderer | undefined;
let latest: ReturnType<typeof PaletteHook>;
let props: Parameters<typeof PaletteHook>[0];
let codeGate: ReturnType<typeof deferred<void>>;
function Harness() {
  latest = hook(props);
  return null;
}
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<Harness />);
    else renderer = create(<Harness />);
  });
}
async function advance() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(140);
  });
}
async function releaseCode() {
  await act(async () => {
    codeGate.resolve();
    await vi.dynamicImportSettled();
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.assign(scope, { caller: 0, access: 0, gateway: "http://gateway-a", loads: 0 });
  codeGate = deferred<void>();
  vi.doMock("./composer-palette-source-code.js", async (importOriginal) => {
    scope.loads += 1;
    await codeGate.promise;
    return importOriginal<typeof import("./composer-palette-source-code")>();
  });
  api.files.mockResolvedValue({
    items: [{ relativePath: "brief.md", size: 2048, modifiedAt: "2026-10-14T00:00:00.000Z" }],
  });
  api.packs.mockResolvedValue({ items: [] });
  api.tests.mockResolvedValue({ items: [] });
  api.artifacts.mockResolvedValue({ items: [] });
  api.notes.mockResolvedValue({ items: [] });
  props = {
    enabled: true,
    active: false,
    sessionKey: "session-a",
    sessionId: "session-a",
    workspaceId: "workspace-a",
    mode: "all",
    query: "",
    commandCatalog: [],
    inlineCommandSuggestions: [],
    providerOptions: [],
    agents: [],
    installedSkills: [],
    projects: [],
    knowledgeAttachments: [],
    externalSourcesAvailable: false,
    typedRunVariablesEnabled: false,
    documentEditingEnabled: false,
  };
  hook = (await import("./useChatComposerPaletteController")).useChatComposerPaletteController;
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    renderer = undefined;
    codeGate.resolve();
  });
  await vi.dynamicImportSettled();
  vi.doUnmock("./composer-palette-source-code.js");
  vi.useRealTimers();
});

describe("composer palette optional source-code custody", () => {
  it("keeps inactive readiness immediate without loading source code or reading sources", async () => {
    await render();
    await advance();
    expect(scope.loads).toBe(0);
    expect(api.files).not.toHaveBeenCalled();
    expect(api.packs).not.toHaveBeenCalled();
    expect(latest).toEqual({ items: [], failures: [], loading: false });
  });

  it("loads on first palette intent and admits source reads only after code is ready", async () => {
    props.active = true;
    await render();
    await advance();
    expect(scope.loads).toBe(1);
    expect(latest.loading).toBe(true);
    expect(api.files).not.toHaveBeenCalled();
    await releaseCode();
    await act(async () => {
      await vi.waitFor(() =>
        expect(api.files).toHaveBeenCalledExactlyOnceWith(".", 250, { workspaceId: "workspace-a" }),
      );
    });
    expect(api.files).toHaveBeenCalledExactlyOnceWith(".", 250, { workspaceId: "workspace-a" });
    expect(latest.items.some((item) => item.command === "brief.md")).toBe(true);
    expect(latest.loading).toBe(false);
  });

  it("does not read after the palette closes while code is loading", async () => {
    props.active = true;
    await render();
    await advance();
    props = { ...props, active: false };
    await render();
    await releaseCode();
    expect(api.files).not.toHaveBeenCalled();
    expect(latest).toEqual({ items: [], failures: [], loading: false });
  });

  it("does not read after unmount while code is loading", async () => {
    props.active = true;
    await render();
    await advance();
    await act(async () => {
      renderer!.unmount();
      renderer = undefined;
    });
    await releaseCode();
    expect(api.files).not.toHaveBeenCalled();
  });

  it.each(["session", "caller", "access", "gateway"])(
    "rejects %s A-to-B-to-A ownership during the code await",
    async (subject) => {
      props.active = true;
      await render();
      await advance();
      if (subject === "session") props = { ...props, sessionKey: "session-b", sessionId: "session-b" };
      if (subject === "caller") scope.caller += 1;
      if (subject === "access") scope.access += 1;
      if (subject === "gateway") scope.gateway = "http://gateway-b";
      await render();
      if (subject === "session") props = { ...props, sessionKey: "session-a", sessionId: "session-a" };
      if (subject === "caller") scope.caller += 1;
      if (subject === "access") scope.access += 1;
      if (subject === "gateway") scope.gateway = "http://gateway-a";
      await render();
      await releaseCode();
      expect(api.files).not.toHaveBeenCalled();
      expect(latest.items).toEqual([]);
      await advance();
      await act(async () => {
        await vi.waitFor(() => expect(api.files).toHaveBeenCalledTimes(1));
      });
      expect(api.files).toHaveBeenCalledTimes(1);
    },
  );

  it("checks the current caller before later prompt-pack reads after a source await", async () => {
    const packs = deferred<{ items: Array<{ packId: string; runVariableSchema: object }> }>();
    api.packs.mockReturnValue(packs.promise);
    props = { ...props, active: true, typedRunVariablesEnabled: true };
    await render();
    await advance();
    await releaseCode();
    expect(api.packs).toHaveBeenCalledTimes(1);
    scope.caller += 1;
    await act(async () => {
      packs.resolve({ items: [{ packId: "pack-a", runVariableSchema: { fields: [] } }] });
    });
    expect(api.tests).not.toHaveBeenCalled();
    expect(latest.items).toEqual([]);
  });

  it("reuses query-only source caches while isolating workspace and caller scopes", async () => {
    props.active = true;
    await render();
    await advance();
    await releaseCode();
    expect(api.files).toHaveBeenCalledTimes(1);
    props = { ...props, query: "brief" };
    await render();
    await advance();
    expect(api.files).toHaveBeenCalledTimes(1);
    expect(latest.items.some((item) => item.command === "brief.md")).toBe(true);
    props = { ...props, workspaceId: "workspace-b", sessionKey: "session-b", sessionId: "session-b" };
    await render();
    await advance();
    expect(api.files).toHaveBeenCalledTimes(2);
    expect(api.files).toHaveBeenLastCalledWith(".", 250, { workspaceId: "workspace-b" });
    scope.caller += 1;
    await render();
    await advance();
    expect(api.files).toHaveBeenCalledTimes(3);
  });

  it("shows a bounded code-load failure and retries only on fresh intent", async () => {
    props.active = true;
    await render();
    await advance();
    await act(async () => {
      codeGate.reject(new Error("Synthetic optional code load failure"));
      await vi.dynamicImportSettled();
    });
    expect(api.files).not.toHaveBeenCalled();
    expect(latest).toEqual({
      items: [],
      failures: [
        {
          source: "commands",
          sourceLabel: "Composer palette",
          message: "Composer palette couldn't load. Open it again to retry.",
        },
      ],
      loading: false,
    });
    vi.doUnmock("./composer-palette-source-code.js");
    props = { ...props, active: false };
    await render();
    props = { ...props, active: true };
    await render();
    await advance();
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(api.files).toHaveBeenCalledTimes(1);
    expect(latest.loading).toBe(false);
  });
});
