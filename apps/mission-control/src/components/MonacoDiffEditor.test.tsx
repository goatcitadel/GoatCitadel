// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonacoDiffEditor } from "./MonacoDiffEditor";
import { setMonacoTestRuntimeEnabled } from "./monaco-runtime";
import { loadMonacoEditorRuntime } from "./monaco-loader";

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

vi.mock("./monaco-loader", () => ({
  loadMonacoEditorRuntime: vi.fn(async () => ({
    editor: {
      createDiffEditor: createDiffEditorMock,
      createModel: createModelMock,
      setTheme: setThemeMock,
    },
  })),
  normalizeMonacoLoaderLanguage: vi.fn((language?: string) => {
    if (language === "ts") {
      return "typescript";
    }
    return language ?? "plaintext";
  }),
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

  it("renders preformatted fallback content when the Monaco runtime is disabled", async () => {
    setMonacoTestRuntimeEnabled(false);

    await act(async () => {
      root?.render(
        <MonacoDiffEditor original="before text" modified="after text" language="markdown" className="diff-fallback" />,
      );
      await Promise.resolve();
    });

    expect(createDiffEditorMock).not.toHaveBeenCalled();
    expect(container?.querySelectorAll("pre")).toHaveLength(2);
    expect(container?.textContent).toContain("before text");
    expect(container?.textContent).toContain("after text");
    expect(container?.querySelector(".diff-fallback")).toBeTruthy();
  });

  it("updates models, applies the light theme, and disposes old models on prop changes", async () => {
    document.body.className = "theme-citadel-light";

    await act(async () => {
      root?.render(<MonacoDiffEditor original="left-a" modified="right-a" language="ts" height={240} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstOriginalModel = createModelMock.mock.results[0]?.value;
    const firstModifiedModel = createModelMock.mock.results[1]?.value;

    await act(async () => {
      root?.render(<MonacoDiffEditor original="left-b" modified="right-b" language="json" height={240} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setThemeMock).toHaveBeenCalledWith("vs");
    expect(createModelMock).toHaveBeenCalledWith("left-b", "json");
    expect(createModelMock).toHaveBeenCalledWith("right-b", "json");
    expect(firstOriginalModel.dispose).toHaveBeenCalledTimes(1);
    expect(firstModifiedModel.dispose).toHaveBeenCalledTimes(1);

    disposeEditorMock.mockClear();
    await act(async () => {
      root?.unmount();
    });

    expect(disposeEditorMock).toHaveBeenCalledTimes(1);
    root = null;
  });

  it("ignores a late Monaco load after unmount", async () => {
    let resolveRuntime: (runtime: unknown) => void = () => undefined;
    vi.mocked(loadMonacoEditorRuntime).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRuntime = resolve;
        }) as never,
    );

    await act(async () => {
      root?.render(<MonacoDiffEditor original="late-a" modified="late-b" language="ts" />);
    });
    await act(async () => {
      root?.unmount();
    });
    root = null;
    await act(async () => {
      resolveRuntime({
        editor: {
          createDiffEditor: createDiffEditorMock,
          createModel: createModelMock,
          setTheme: setThemeMock,
        },
      });
      await Promise.resolve();
    });

    expect(createDiffEditorMock).not.toHaveBeenCalled();
  });
});
