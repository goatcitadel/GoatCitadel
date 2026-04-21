// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchMonacoEditor } from "./WorkbenchMonacoEditor";
import { setMonacoTestRuntimeEnabled } from "./monaco-runtime";

let resolveModuleLoad: (() => void) | null = null;
let moduleLoadPromise = new Promise<void>((resolve) => {
  resolveModuleLoad = resolve;
});
const renderedMonacoEditorMock = vi.fn();

function resetModuleLoadPromise(): void {
  moduleLoadPromise = new Promise<void>((resolve) => {
    resolveModuleLoad = resolve;
  });
}

vi.mock("@uiw/react-monacoeditor", async () => {
  await moduleLoadPromise;
  return {
    default: (props: { value: string }) => {
      renderedMonacoEditorMock(props.value);
      return <div data-testid="mock-monaco-editor">{props.value}</div>;
    },
  };
});

describe("WorkbenchMonacoEditor", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    setMonacoTestRuntimeEnabled(true);
    resetModuleLoadPromise();
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
      resolveModuleLoad?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderedMonacoEditorMock).not.toHaveBeenCalled();
  });
});
