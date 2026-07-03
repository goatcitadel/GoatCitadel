import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAssistantCodeHighlighterForTests } from "./assistant-code-highlight";

const languagesMocks = vi.hoisted(() => ({
  createAssistantHighlighter: vi.fn(),
}));

vi.mock("./assistant-code-highlight-languages", () => ({
  createAssistantHighlighter: languagesMocks.createAssistantHighlighter,
}));

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function fakeHighlighter() {
  return {
    highlight: (_language: string, code: string) => ({
      type: "root" as const,
      children: [
        {
          type: "element" as const,
          tagName: "span",
          properties: { className: ["hljs-keyword"] },
          children: [{ type: "text" as const, value: code }],
        },
      ],
    }),
    listLanguages: () => ["typescript", "python"],
  };
}

describe("HighlightedCode", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    resetAssistantCodeHighlighterForTests();
    vi.unstubAllGlobals();
    languagesMocks.createAssistantHighlighter.mockReset();
    languagesMocks.createAssistantHighlighter.mockReturnValue(fakeHighlighter());
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    resetAssistantCodeHighlighterForTests();
    vi.unstubAllGlobals();
  });

  it("renders plain text immediately, then upgrades to .hljs spans once resolved", async () => {
    const { HighlightedCode } = await import("./HighlightedCode");
    renderer = create(
      <HighlightedCode code="const x = 1;" language="typescript" codeClassName="language-typescript" codeProps={{}} />,
    );

    const codeBefore = renderer.root.findByType("code");
    expect(codeBefore.props.className).toBe("language-typescript");

    await flush();

    const codeAfter = renderer.root.findByType("code");
    expect(codeAfter.props.className).toContain("hljs");
    expect(renderer.root.findAllByProps({ className: "hljs-keyword" }).length).toBeGreaterThan(0);
  });

  it("calls the loader exactly once (singleton) across two settled blocks", async () => {
    const { HighlightedCode } = await import("./HighlightedCode");
    renderer = create(
      <>
        <HighlightedCode code="const a = 1;" language="typescript" codeClassName={undefined} codeProps={{}} />
        <HighlightedCode code="const b = 2;" language="typescript" codeClassName={undefined} codeProps={{}} />
      </>,
    );
    await flush();
    expect(languagesMocks.createAssistantHighlighter).toHaveBeenCalledTimes(1);
  });

  it("never calls the loader while inside the streaming-tail context", async () => {
    const { HighlightedCode, AssistantStreamingTailContext } = await import("./HighlightedCode");
    renderer = create(
      <AssistantStreamingTailContext.Provider value={true}>
        <HighlightedCode code="const x = 1;" language="typescript" codeClassName={undefined} codeProps={{}} />
      </AssistantStreamingTailContext.Provider>,
    );
    await flush();
    expect(languagesMocks.createAssistantHighlighter).not.toHaveBeenCalled();
    expect(renderer.root.findByType("code").props.children).toBe("const x = 1;");
  });

  it("falls back to plain text without throwing when the loader rejects", async () => {
    vi.doMock("./assistant-code-highlight", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./assistant-code-highlight")>();
      return {
        ...actual,
        loadAssistantCodeHighlighter: () => Promise.reject(new Error("chunk failure")),
      };
    });
    vi.resetModules();
    const { HighlightedCode } = await import("./HighlightedCode");
    renderer = create(
      <HighlightedCode code="const x = 1;" language="typescript" codeClassName={undefined} codeProps={{}} />,
    );
    await flush();
    expect(renderer.root.findByType("code").props.children).toBe("const x = 1;");
    vi.doUnmock("./assistant-code-highlight");
    vi.resetModules();
  });

  it("stays plain text when the kill-switch is set, and never invokes the loader", async () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "true" },
    });
    const { HighlightedCode } = await import("./HighlightedCode");
    renderer = create(
      <HighlightedCode code="const x = 1;" language="typescript" codeClassName={undefined} codeProps={{}} />,
    );
    await flush();
    expect(languagesMocks.createAssistantHighlighter).not.toHaveBeenCalled();
    expect(renderer.root.findByType("code").props.children).toBe("const x = 1;");
  });
});
