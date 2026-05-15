import { afterEach, describe, expect, it, vi } from "vitest";

const workerConstructors = vi.hoisted(() => {
  class EditorWorker {}
  class JsonWorker {}
  class CssWorker {}
  class HtmlWorker {}
  class TypescriptWorker {}

  return {
    CssWorker,
    EditorWorker,
    HtmlWorker,
    JsonWorker,
    TypescriptWorker,
  };
});

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: workerConstructors.EditorWorker,
}));

vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
  default: workerConstructors.JsonWorker,
}));

vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({
  default: workerConstructors.CssWorker,
}));

vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({
  default: workerConstructors.HtmlWorker,
}));

vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: workerConstructors.TypescriptWorker,
}));

type MonacoEnvironment = {
  getWorker(moduleId: string, label: string): unknown;
};

function currentMonacoEnvironment(): MonacoEnvironment | undefined {
  return (globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironment }).MonacoEnvironment;
}

describe("configure-monaco", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "MonacoEnvironment");
  });

  it("installs the browser Monaco worker router for each supported language label", async () => {
    vi.stubGlobal("window", {});

    await import("./configure-monaco");

    const environment = currentMonacoEnvironment();
    expect(environment).toBeDefined();
    expect(environment?.getWorker("", "json")).toBeInstanceOf(workerConstructors.JsonWorker);
    expect(environment?.getWorker("", "css")).toBeInstanceOf(workerConstructors.CssWorker);
    expect(environment?.getWorker("", "scss")).toBeInstanceOf(workerConstructors.CssWorker);
    expect(environment?.getWorker("", "less")).toBeInstanceOf(workerConstructors.CssWorker);
    expect(environment?.getWorker("", "html")).toBeInstanceOf(workerConstructors.HtmlWorker);
    expect(environment?.getWorker("", "handlebars")).toBeInstanceOf(workerConstructors.HtmlWorker);
    expect(environment?.getWorker("", "razor")).toBeInstanceOf(workerConstructors.HtmlWorker);
    expect(environment?.getWorker("", "typescript")).toBeInstanceOf(workerConstructors.TypescriptWorker);
    expect(environment?.getWorker("", "javascript")).toBeInstanceOf(workerConstructors.TypescriptWorker);
    expect(environment?.getWorker("", "plaintext")).toBeInstanceOf(workerConstructors.EditorWorker);
  });

  it("preserves an existing MonacoEnvironment in browser runtimes", async () => {
    vi.stubGlobal("window", {});
    const existing = { getWorker: vi.fn() };
    Object.defineProperty(globalThis, "MonacoEnvironment", {
      configurable: true,
      writable: true,
      value: existing,
    });

    await import("./configure-monaco");

    expect(currentMonacoEnvironment()).toBe(existing);
  });

  it("does not install a worker router outside browser runtimes", async () => {
    vi.stubGlobal("window", undefined);

    await import("./configure-monaco");

    expect(currentMonacoEnvironment()).toBeUndefined();
  });
});
