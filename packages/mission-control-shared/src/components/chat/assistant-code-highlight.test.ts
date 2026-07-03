import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root as HastRoot } from "hast";

import {
  HIGHLIGHT_MAX_CODE_CHARS,
  highlightCodeToHast,
  isAssistantCodeHighlightEnabled,
  loadAssistantCodeHighlighter,
  normalizeHighlightLanguage,
  resetAssistantCodeHighlighterForTests,
  type AssistantHighlighter,
} from "./assistant-code-highlight";
// Static import is fine in tests — only the runtime source (assistant-code-highlight.ts)
// must avoid a static/runtime import of the languages chunk.
import { createAssistantHighlighter } from "./assistant-code-highlight-languages";

function collectTextNodes(node: unknown, out: string[]): void {
  if (node == null || typeof node !== "object") {
    return;
  }
  const record = node as { type?: unknown; value?: unknown; children?: unknown };
  if (record.type === "text" && typeof record.value === "string") {
    out.push(record.value);
    return;
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      collectTextNodes(child, out);
    }
  }
}

function flattenedText(root: HastRoot): string {
  const out: string[] = [];
  collectTextNodes(root, out);
  return out.join("");
}

describe("normalizeHighlightLanguage", () => {
  it("maps common aliases to their canonical registered language", () => {
    expect(normalizeHighlightLanguage("js")).toBe("javascript");
    expect(normalizeHighlightLanguage("mjs")).toBe("javascript");
    expect(normalizeHighlightLanguage("cjs")).toBe("javascript");
    expect(normalizeHighlightLanguage("ts")).toBe("typescript");
    expect(normalizeHighlightLanguage("mts")).toBe("typescript");
    expect(normalizeHighlightLanguage("cts")).toBe("typescript");
    expect(normalizeHighlightLanguage("tsx")).toBe("typescript");
    expect(normalizeHighlightLanguage("jsx")).toBe("typescript");
    expect(normalizeHighlightLanguage("sh")).toBe("bash");
    expect(normalizeHighlightLanguage("zsh")).toBe("bash");
    expect(normalizeHighlightLanguage("shell")).toBe("bash");
    expect(normalizeHighlightLanguage("html")).toBe("xml");
    expect(normalizeHighlightLanguage("svg")).toBe("xml");
    expect(normalizeHighlightLanguage("vue")).toBe("xml");
    expect(normalizeHighlightLanguage("yml")).toBe("yaml");
    expect(normalizeHighlightLanguage("ps")).toBe("powershell");
    expect(normalizeHighlightLanguage("ps1")).toBe("powershell");
    expect(normalizeHighlightLanguage("c#")).toBe("csharp");
    expect(normalizeHighlightLanguage("cs")).toBe("csharp");
    expect(normalizeHighlightLanguage("golang")).toBe("go");
    expect(normalizeHighlightLanguage("py")).toBe("python");
    expect(normalizeHighlightLanguage("md")).toBe("markdown");
    expect(normalizeHighlightLanguage("patch")).toBe("diff");
  });

  it("is case-insensitive", () => {
    expect(normalizeHighlightLanguage("TS")).toBe("typescript");
    expect(normalizeHighlightLanguage("JS")).toBe("javascript");
    expect(normalizeHighlightLanguage("Python")).toBe("python");
    expect(normalizeHighlightLanguage("C#")).toBe("csharp");
  });

  it("returns the identity for every registered canonical name", () => {
    const canonical = [
      "typescript",
      "javascript",
      "json",
      "bash",
      "python",
      "css",
      "xml",
      "markdown",
      "yaml",
      "sql",
      "diff",
      "go",
      "rust",
      "java",
      "csharp",
      "powershell",
    ];
    for (const name of canonical) {
      expect(normalizeHighlightLanguage(name)).toBe(name);
    }
  });

  it("returns null for unknown languages and for undefined input", () => {
    expect(normalizeHighlightLanguage("brainfuck")).toBeNull();
    expect(normalizeHighlightLanguage("openui")).toBeNull();
    expect(normalizeHighlightLanguage("")).toBeNull();
    expect(normalizeHighlightLanguage(undefined)).toBeNull();
  });
});

describe("highlightCodeToHast", () => {
  const highlighter: AssistantHighlighter = createAssistantHighlighter();

  it("returns null when the code exceeds HIGHLIGHT_MAX_CODE_CHARS", () => {
    const oversized = "a".repeat(HIGHLIGHT_MAX_CODE_CHARS + 1);
    expect(highlightCodeToHast(highlighter, oversized, "typescript")).toBeNull();
  });

  it("returns null for a language that is not registered", () => {
    expect(highlightCodeToHast(highlighter, "print(1)", "brainfuck")).toBeNull();
  });

  it("returns null when the underlying highlighter throws", () => {
    const throwingHighlighter: AssistantHighlighter = {
      highlight: () => {
        throw new Error("boom");
      },
      listLanguages: () => ["typescript"],
    };
    expect(highlightCodeToHast(throwingHighlighter, "const x = 1;", "typescript")).toBeNull();
  });

  it("produces hast spans containing hljs-keyword for a TypeScript snippet", () => {
    const tree = highlightCodeToHast(
      highlighter,
      "import { foo } from 'bar';\nexport const x: number = 1;",
      "typescript",
    );
    expect(tree).not.toBeNull();
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain("hljs-keyword");
  });

  it.each([
    ["typescript", "import { foo } from 'bar';\nexport const x: number = 1;\n// a comment"],
    ["python", 'def greet(name):\n    return f"hello, {name}!"\n'],
    ["diff", "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old line\n+new line\n"],
    ["typescript", 'const emoji = "👋 café — naïve"; // unicode 混合 test'],
  ])("is byte-equivalent for %s: concatenated hast text nodes equal the input", (language, code) => {
    const tree = highlightCodeToHast(highlighter, code, language);
    expect(tree).not.toBeNull();
    expect(flattenedText(tree as HastRoot)).toBe(code);
  });
});

describe("isAssistantCodeHighlightEnabled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to enabled when window/localStorage is unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(isAssistantCodeHighlightEnabled()).toBe(true);
  });

  it("defaults to enabled when localStorage access throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(isAssistantCodeHighlightEnabled()).toBe(true);
  });

  it("is enabled when the kill-switch key is absent", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null } });
    expect(isAssistantCodeHighlightEnabled()).toBe(true);
  });

  it("is disabled only when the kill-switch key is exactly the string 'true'", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => (key === "goatcitadel.chat.code_highlight.disabled" ? "true" : null) },
    });
    expect(isAssistantCodeHighlightEnabled()).toBe(false);

    vi.stubGlobal("window", {
      localStorage: { getItem: () => "TRUE" },
    });
    expect(isAssistantCodeHighlightEnabled()).toBe(true);

    vi.stubGlobal("window", {
      localStorage: { getItem: () => "1" },
    });
    expect(isAssistantCodeHighlightEnabled()).toBe(true);
  });
});

describe("loadAssistantCodeHighlighter", () => {
  beforeEach(() => {
    resetAssistantCodeHighlighterForTests();
  });

  afterEach(() => {
    resetAssistantCodeHighlighterForTests();
    vi.doUnmock("./assistant-code-highlight-languages");
  });

  it("memoizes the loader as a singleton promise across repeated calls", async () => {
    const [first, second] = await Promise.all([loadAssistantCodeHighlighter(), loadAssistantCodeHighlighter()]);
    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  it("resolves null when the dynamic import fails, without throwing", async () => {
    vi.doMock("./assistant-code-highlight-languages", () => {
      throw new Error("chunk load failure");
    });
    resetAssistantCodeHighlighterForTests();
    const { loadAssistantCodeHighlighter: freshLoad } = await import("./assistant-code-highlight");
    await expect(freshLoad()).resolves.toBeNull();
  });
});
