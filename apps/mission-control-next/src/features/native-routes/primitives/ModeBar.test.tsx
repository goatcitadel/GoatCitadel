// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModeBar } from "./ModeBar";

describe("ModeBar", () => {
  it("renders three segments with mode data-attributes", () => {
    const markup = renderToStaticMarkup(<ModeBar chat={50} cowork={30} code={20} />);
    expect(markup).toContain('class="mc-next-mode-bar"');
    expect(markup).toContain('data-mode="chat"');
    expect(markup).toContain('data-mode="cowork"');
    expect(markup).toContain('data-mode="code"');
  });

  it("normalizes inputs to sum to 100 when totals diverge", () => {
    const markup = renderToStaticMarkup(<ModeBar chat={5} cowork={3} code={2} />);
    expect(markup).toContain("width:50%");
    expect(markup).toContain("width:30%");
    expect(markup).toContain("width:20%");
  });

  it("handles zero totals by rendering an empty bar without crashing", () => {
    const markup = renderToStaticMarkup(<ModeBar chat={0} cowork={0} code={0} />);
    expect(markup).toMatch(/class="mc-next-mode-bar /);
    expect(markup).toContain("mc-next-mode-bar-empty");
  });

  it("includes an accessible aria-label summarising the split", () => {
    const markup = renderToStaticMarkup(<ModeBar chat={50} cowork={30} code={20} />);
    expect(markup).toMatch(/aria-label="[^"]*50% chat[^"]*30% cowork[^"]*20% code/);
  });

  it("hides zero-percent segments to avoid empty visual ticks", () => {
    const markup = renderToStaticMarkup(<ModeBar chat={100} cowork={0} code={0} />);
    expect(markup).toContain('data-mode="chat"');
    expect(markup).not.toContain('data-mode="cowork"');
    expect(markup).not.toContain('data-mode="code"');
  });
});
