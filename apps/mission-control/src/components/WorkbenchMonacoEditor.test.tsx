// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create as createTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchMonacoEditor } from "./WorkbenchMonacoEditor";
import { setMonacoTestRuntimeEnabled } from "./monaco-runtime";

const monacoLoaderState = vi.hoisted(() => {
  let resolveModuleLoad: (() => void) | null = null;
  let moduleLoadPromise = new Promise<void>((resolve) => {
    resolveModuleLoad = resolve;
  });

  return {
    wait() {
      return moduleLoadPromise;
    },
    resolve() {
      resolveModuleLoad?.();
    },
    reset() {
      moduleLoadPromise = new Promise<void>((resolve) => {
        resolveModuleLoad = resolve;
      });
    },
  };
});

const renderedMonacoEditorMock = vi.fn();
const createEditorMock = vi.fn();
const createModelMock = vi.fn();
const setModelLanguageMock = vi.fn();
const setThemeMock = vi.fn();

vi.mock("./monaco-loader", () => {
  return {
    loadMonacoEditorRuntime: vi.fn(async () => {
      await monacoLoaderState.wait();
      return {
        editor: {
          create: (...args: unknown[]) => {
            renderedMonacoEditorMock(args[1]);
            return createEditorMock(...args);
          },
          createModel: createModelMock,
          setModelLanguage: setModelLanguageMock,
          setTheme: setThemeMock,
        },
      };
    }),
    normalizeMonacoLoaderLanguage: vi.fn((language?: string) => {
      if (language === "ts") {
        return "typescript";
      }
      return language ?? "plaintext";
    }),
  };
});

describe("WorkbenchMonacoEditor", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    createEditorMock.mockReturnValue({
      onDidChangeModelContent: vi.fn(),
      dispose: vi.fn(),
      updateOptions: vi.fn(),
      getValue: vi.fn(() => "const answer = 42;"),
    });
    createModelMock.mockReturnValue({
      getValue: vi.fn(() => "const answer = 42;"),
      setValue: vi.fn(),
      dispose: vi.fn(),
    });
    createEditorMock.mockClear();
    createModelMock.mockClear();
    setModelLanguageMock.mockClear();
    setThemeMock.mockClear();
    setMonacoTestRuntimeEnabled(true);
    monacoLoaderState.reset();
    renderedMonacoEditorMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    setMonacoTestRuntimeEnabled(false);
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it("does not mount the async editor after unmount while the module import resolves", async () => {
    await act(async () => {
      root?.render(<WorkbenchMonacoEditor value="const answer = 42;" language="ts" />);
    });

    await act(async () => {
      root?.unmount();
    });

    await act(async () => {
      monacoLoaderState.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createEditorMock).not.toHaveBeenCalled();
    expect(renderedMonacoEditorMock).not.toHaveBeenCalled();
  });

  it("uses the textarea and pre fallbacks when Monaco runtime is disabled", async () => {
    const onChange = vi.fn();
    setMonacoTestRuntimeEnabled(false);

    const editable = createTestRenderer(
      <WorkbenchMonacoEditor value="draft text" onChange={onChange} height={180} className="editor" />,
    );
    const textarea = editable.root.findByType("textarea");
    expect(textarea.props.value).toBe("draft text");
    expect(textarea.props.style.minHeight).toBe("180px");

    await act(async () => {
      textarea.props.onChange({ target: { value: "changed text" } });
    });

    expect(onChange).toHaveBeenCalledWith("changed text");

    editable.unmount();

    await act(async () => {
      root?.render(<WorkbenchMonacoEditor value="read only" readOnly className="viewer" />);
    });

    const pre = container?.querySelector("pre.viewer");
    expect(pre?.textContent).toBe("read only");
  });

  it("creates, updates, and disposes the Monaco runtime editor", async () => {
    const onChange = vi.fn();
    let changeHandler: (() => void) | null = null;
    const editorDispose = vi.fn();
    const modelDispose = vi.fn();
    const updateOptions = vi.fn();
    const getValue = vi.fn(() => "editor changed");
    const modelGetValue = vi.fn(() => "old text");
    const modelSetValue = vi.fn();

    createEditorMock.mockReturnValue({
      onDidChangeModelContent: vi.fn((callback: () => void) => {
        changeHandler = callback;
      }),
      dispose: editorDispose,
      updateOptions,
      getValue,
    });
    createModelMock.mockReturnValue({
      getValue: modelGetValue,
      setValue: modelSetValue,
      dispose: modelDispose,
    });

    await act(async () => {
      root?.render(<WorkbenchMonacoEditor value="old text" language="diff" onChange={onChange} height={240} />);
      monacoLoaderState.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createModelMock).toHaveBeenCalledWith("old text", "plaintext");
    expect(renderedMonacoEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: false,
        renderLineHighlight: "line",
        wordWrap: "off",
      }),
    );
    expect(setThemeMock).toHaveBeenCalledWith("vs-dark");

    await act(async () => {
      changeHandler?.();
    });

    expect(onChange).toHaveBeenCalledWith("editor changed");

    await act(async () => {
      root?.render(<WorkbenchMonacoEditor value="new text" language="diff" readOnly onChange={onChange} />);
      await Promise.resolve();
    });

    expect(updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        renderLineHighlight: "none",
        wordWrap: "off",
      }),
    );
    expect(setModelLanguageMock).toHaveBeenCalledWith(expect.anything(), "plaintext");
    expect(modelSetValue).toHaveBeenCalledWith("new text");

    await act(async () => {
      root?.unmount();
    });

    expect(editorDispose).toHaveBeenCalledTimes(1);
    expect(modelDispose).toHaveBeenCalledTimes(1);
  });
});
