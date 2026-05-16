// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreePartChip } from "./ThreePartChip";

describe("ThreePartChip", () => {
  it("renders state slot and applies tone data-attribute", () => {
    const markup = renderToStaticMarkup(<ThreePartChip tone="safe" state="streaming" />);
    expect(markup).toContain('class="mc-next-chip-3"');
    expect(markup).toContain('data-tone="safe"');
    expect(markup).toContain("streaming");
  });

  it("supports all 6 tones", () => {
    const tones = ["safe", "caution", "danger", "nuclear", "muted", "accent"] as const;
    for (const tone of tones) {
      const markup = renderToStaticMarkup(<ThreePartChip tone={tone} state="x" />);
      expect(markup).toContain(`data-tone="${tone}"`);
    }
  });

  it("renders middle slot when mid provided", () => {
    const markup = renderToStaticMarkup(<ThreePartChip tone="safe" state="streaming" mid="428 tok" />);
    expect(markup).toContain("mc-next-chip-3-mid");
    expect(markup).toContain("428 tok");
  });

  it("renders age slot when provided", () => {
    const markup = renderToStaticMarkup(<ThreePartChip tone="caution" state="awaiting" age="4m" />);
    expect(markup).toContain("mc-next-chip-3-age");
    expect(markup).toContain(">4m<");
  });

  it("omits mid and age slots when not provided", () => {
    const markup = renderToStaticMarkup(<ThreePartChip tone="muted" state="idle" />);
    expect(markup).not.toContain("mc-next-chip-3-mid");
    expect(markup).not.toContain("mc-next-chip-3-age");
  });

  it("renders dot by default and omits when dot={false}", () => {
    const withDot = renderToStaticMarkup(<ThreePartChip tone="safe" state="x" />);
    expect(withDot).toContain("mc-next-chip-3-dot");

    const noDot = renderToStaticMarkup(<ThreePartChip tone="safe" state="x" dot={false} />);
    expect(noDot).not.toContain("mc-next-chip-3-dot");
  });
});
