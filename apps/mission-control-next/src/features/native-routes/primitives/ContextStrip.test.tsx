// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextStrip } from "./ContextStrip";

describe("ContextStrip", () => {
  it("renders model and mode", () => {
    const markup = renderToStaticMarkup(<ContextStrip model="claude-opus-4-7" mode="chat" />);
    expect(markup).toContain('class="mc-next-context-strip"');
    expect(markup).toContain('data-mode="chat"');
    expect(markup).toContain("claude-opus-4-7");
    expect(markup).toContain("Chat");
  });

  it("supports all 3 modes via data-mode", () => {
    for (const mode of ["chat", "cowork", "code"] as const) {
      const markup = renderToStaticMarkup(<ContextStrip model="m" mode={mode} />);
      expect(markup).toContain(`data-mode="${mode}"`);
    }
  });

  it("renders memory cell when provided", () => {
    const markup = renderToStaticMarkup(<ContextStrip model="m" mode="chat" memory="knowledge/routing · 14 items" />);
    expect(markup).toContain("knowledge/routing · 14 items");
    expect(markup).toContain("mc-next-context-strip-memory");
  });

  it("renders live cost cell with tokens and cost", () => {
    const markup = renderToStaticMarkup(<ContextStrip model="m" mode="chat" tokens="428 tok" cost="$0.018" />);
    expect(markup).toContain("428 tok");
    expect(markup).toContain("$0.018");
    expect(markup).toContain("mc-next-context-strip-live");
  });

  it("omits optional cells when their props absent", () => {
    const markup = renderToStaticMarkup(<ContextStrip model="m" mode="chat" />);
    expect(markup).not.toContain("mc-next-context-strip-memory");
    expect(markup).not.toContain("mc-next-context-strip-live");
    expect(markup).not.toContain("mc-next-context-strip-attachments");
  });

  it("renders attachments slot when supplied", () => {
    const markup = renderToStaticMarkup(<ContextStrip model="m" mode="cowork" attachments={<span>2 files</span>} />);
    expect(markup).toContain("mc-next-context-strip-attachments");
    expect(markup).toContain("2 files");
  });
});
