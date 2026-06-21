// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ResultCount } from "./ResultCount";

describe("ResultCount", () => {
  it("shows 'Showing N of M' with the noun when truncated", () => {
    const markup = renderToStaticMarkup(<ResultCount shown={10} total={42} noun="providers" />);
    expect(markup).toContain("Showing 10 of 42 providers");
    expect(markup).toContain('aria-live="polite"');
  });

  it("shows just the total when the list is complete", () => {
    const markup = renderToStaticMarkup(<ResultCount shown={7} total={7} noun="rows" />);
    expect(markup).toContain("7 rows");
    expect(markup).not.toContain("Showing");
  });

  it("formats large numbers with separators", () => {
    const markup = renderToStaticMarkup(<ResultCount shown={10} total={12000} />);
    expect(markup).toContain("12,000");
  });

  it("renders a View all action only when truncated and a handler is provided", () => {
    const withAction = renderToStaticMarkup(<ResultCount shown={10} total={42} onViewAll={() => {}} />);
    expect(withAction).toContain("mc-next-result-count-action");
    const completeList = renderToStaticMarkup(<ResultCount shown={42} total={42} onViewAll={() => {}} />);
    expect(completeList).not.toContain("mc-next-result-count-action");
  });

  it("invokes onViewAll when the action is activated", async () => {
    const onViewAll = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ResultCount shown={10} total={42} onViewAll={onViewAll} />);
    });
    const button = renderer!.root.findByType("button");
    await act(async () => {
      button.props.onClick();
    });
    expect(onViewAll).toHaveBeenCalled();
  });
});
