import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  shouldRenderMonacoRuntime: vi.fn(),
}));

const loaderMocks = vi.hoisted(() => ({
  loadMonacoEditorRuntime: vi.fn(),
  normalizeMonacoLoaderLanguage: vi.fn((language?: string) => {
    const value = language?.trim().toLowerCase();
    return value === "ts" || value === "tsx" || value === "typescript" ? "typescript" : value || "plaintext";
  }),
}));

vi.mock("./monaco-runtime", () => ({
  shouldRenderMonacoRuntime: runtimeMocks.shouldRenderMonacoRuntime,
}));

vi.mock("./monaco-loader", () => ({
  loadMonacoEditorRuntime: loaderMocks.loadMonacoEditorRuntime,
  normalizeMonacoLoaderLanguage: loaderMocks.normalizeMonacoLoaderLanguage,
}));

import { MonacoDiffEditor } from "./MonacoDiffEditor";
import { WorkbenchMonacoEditor } from "./WorkbenchMonacoEditor";

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createMonaco() {
  const listeners: Array<() => void> = [];
  const modelValues: string[] = [];
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  const createModel = vi.fn((value: string, language: string) => {
    let currentValue = value;
    modelValues.push(`${language}:${value}`);
    const dispose = vi.fn();
    disposers.push(dispose);
    return {
      dispose,
      getValue: vi.fn(() => currentValue),
      setValue: vi.fn((nextValue: string) => {
        currentValue = nextValue;
      }),
    };
  });
  const codeEditor = {
    dispose: vi.fn(),
    getValue: vi.fn(() => "typed value"),
    onDidChangeModelContent: vi.fn((listener: () => void) => {
      listeners.push(listener);
    }),
    updateOptions: vi.fn(),
  };
  const diffEditor = {
    dispose: vi.fn(),
    setModel: vi.fn(),
  };
  const monaco = {
    editor: {
      create: vi.fn(() => codeEditor),
      createDiffEditor: vi.fn(() => diffEditor),
      createModel,
      setModelLanguage: vi.fn(),
      setTheme: vi.fn(),
    },
  };
  return { codeEditor, diffEditor, disposers, listeners, modelValues, monaco };
}

describe("Monaco editor wrappers", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    renderer = null;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    runtimeMocks.shouldRenderMonacoRuntime.mockReturnValue(false);
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
  });

  afterEach(() => {
    renderer?.unmount();
    vi.unstubAllGlobals();
  });

  it("uses textarea/pre fallbacks when Monaco runtime is disabled", () => {
    const onChange = vi.fn();
    renderer = create(<WorkbenchMonacoEditor value="draft" height={120} onChange={onChange} className="editor" />);
    const textarea = renderer.root.findByType("textarea");
    expect(textarea.props.value).toBe("draft");
    expect(textarea.props.style).toEqual({ minHeight: "120px" });
    act(() => {
      textarea.props.onChange({ target: { value: "next" } });
    });
    expect(onChange).toHaveBeenCalledWith("next");

    renderer.update(<WorkbenchMonacoEditor value="readonly" readOnly className="editor" />);
    expect(renderer.root.findByType("pre").props.children).toBe("readonly");

    renderer.update(<MonacoDiffEditor original="before" modified="after" className="diff" />);
    expect(renderer.root.findAllByType("pre").map((node) => node.props.children)).toEqual(["before", "after"]);
  });

  it("creates, updates, and disposes the workbench Monaco editor runtime", async () => {
    const monacoHarness = createMonaco();
    runtimeMocks.shouldRenderMonacoRuntime.mockReturnValue(true);
    loaderMocks.loadMonacoEditorRuntime.mockResolvedValue(monacoHarness.monaco);
    vi.stubGlobal("document", { querySelector: vi.fn(() => ({ className: "theme-citadel-light" })) });
    const onChange = vi.fn();

    renderer = create(<WorkbenchMonacoEditor value="initial" language="ts" height="50vh" onChange={onChange} />, {
      createNodeMock: () => ({}),
    });
    await flush();

    expect(loaderMocks.loadMonacoEditorRuntime).toHaveBeenCalledWith("typescript");
    expect(monacoHarness.monaco.editor.setTheme).toHaveBeenCalledWith("vs");
    expect(monacoHarness.monaco.editor.createModel).toHaveBeenCalledWith("initial", "typescript");
    expect(monacoHarness.monaco.editor.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ readOnly: false, wordWrap: "on" }),
    );

    act(() => {
      monacoHarness.listeners[0]!();
    });
    expect(onChange).toHaveBeenCalledWith("typed value");

    renderer.update(<WorkbenchMonacoEditor value="changed" language="ts" readOnly onChange={onChange} />);
    expect(monacoHarness.monaco.editor.setModelLanguage).toHaveBeenCalledWith(expect.anything(), "typescript");
    expect(monacoHarness.codeEditor.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, renderLineHighlight: "none", wordWrap: "on" }),
    );

    renderer.update(<WorkbenchMonacoEditor value="changed" language="diff" readOnly onChange={onChange} />);
    await flush();
    expect(monacoHarness.monaco.editor.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ readOnly: true, wordWrap: "off" }),
    );

    renderer.unmount();
    renderer = null;
    expect(monacoHarness.codeEditor.dispose).toHaveBeenCalled();
    expect(monacoHarness.disposers[0]).toHaveBeenCalled();
  });

  it("creates, refreshes, and disposes Monaco diff models", async () => {
    const monacoHarness = createMonaco();
    runtimeMocks.shouldRenderMonacoRuntime.mockReturnValue(true);
    loaderMocks.loadMonacoEditorRuntime.mockResolvedValue(monacoHarness.monaco);

    renderer = create(<MonacoDiffEditor original="old" modified="new" language="ts" height={320} />, {
      createNodeMock: () => ({}),
    });
    await flush();

    expect(loaderMocks.loadMonacoEditorRuntime).toHaveBeenCalledWith("ts");
    expect(monacoHarness.monaco.editor.createDiffEditor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ readOnly: true, renderSideBySide: true }),
    );
    expect(monacoHarness.diffEditor.setModel).toHaveBeenCalledWith({
      original: expect.anything(),
      modified: expect.anything(),
    });

    renderer.update(<MonacoDiffEditor original="older" modified="newer" language="tsx" height={320} />);
    expect(monacoHarness.disposers[0]).toHaveBeenCalled();
    expect(monacoHarness.disposers[1]).toHaveBeenCalled();
    expect(monacoHarness.modelValues).toContain("typescript:older");
    expect(monacoHarness.modelValues).toContain("typescript:newer");

    renderer.unmount();
    renderer = null;
    expect(monacoHarness.diffEditor.dispose).toHaveBeenCalled();
  });
});
