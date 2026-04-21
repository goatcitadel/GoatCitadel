// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonacoDiffEditor } from "./MonacoDiffEditor";
import { setMonacoTestRuntimeEnabled } from "./monaco-runtime";

const setThemeMock = vi.fn();
const createModelMock = vi.fn((content: string, language: string) => ({
  content,
  language,
  dispose: vi.fn(),
}));
const setModelMock = vi.fn();
const disposeEditorMock = vi.fn();
const createDiffEditorMock = vi.fn(() => ({
  setModel: setModelMock,
  dispose: disposeEditorMock,
}));

vi.mock("monaco-editor", () => ({
  editor: {
    createDiffEditor: createDiffEditorMock,
    createModel: createModelMock,
    setTheme: setThemeMock,
  },
}));

describe("MonacoDiffEditor", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    setMonacoTestRuntimeEnabled(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    createDiffEditorMock.mockClear();
    createModelMock.mockClear();
    setModelMock.mockClear();
    setThemeMock.mockClear();
    disposeEditorMock.mockClear();
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

  it("applies the initial diff model after Monaco loads on first mount", async () => {
    await act(async () => {
      root?.render(<MonacoDiffEditor original="const before = 1;" modified="const after = 2;" language="ts" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createDiffEditorMock).toHaveBeenCalledTimes(1);
    expect(createModelMock).toHaveBeenCalledWith("const before = 1;", "typescript");
    expect(createModelMock).toHaveBeenCalledWith("const after = 2;", "typescript");
    expect(setModelMock).toHaveBeenCalledTimes(1);
  });
});
