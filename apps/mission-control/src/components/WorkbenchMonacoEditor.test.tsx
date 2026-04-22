// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
});
