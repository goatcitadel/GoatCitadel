// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FilterPill } from "./FilterPill";
import { FilterPillGroup, type FilterPillOption } from "./FilterPillGroup";

describe("FilterPill", () => {
  it("keeps each pill at least 24px tall for touch input", () => {
    const primitivesCss = readFileSync(
      resolve(process.cwd(), "src/features/native-routes/primitives/primitives.css"),
      "utf8",
    );
    expect(primitivesCss).toMatch(/\.mc-next-filter-pill\s*\{[^}]*min-height:\s*24px;/u);
  });

  it("renders label, count, and selected state", () => {
    const markup = renderToStaticMarkup(
      <FilterPill label="knowledge" count={22} selected={true} tabIndex={0} onSelect={() => {}} />,
    );
    expect(markup).toContain('class="mc-next-filter-pill is-selected"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("knowledge");
    expect(markup).toContain("22");
  });

  it("omits the count when not provided", () => {
    const markup = renderToStaticMarkup(<FilterPill label="all" selected={false} tabIndex={-1} onSelect={() => {}} />);
    expect(markup).not.toContain("mc-next-filter-pill-count");
  });

  it("forwards id and ariaLabel to the underlying button", () => {
    const markup = renderToStaticMarkup(
      <FilterPill
        label="routing"
        count={14}
        selected={false}
        tabIndex={-1}
        id="memory-namespace-filter-routing"
        ariaLabel="Filter by namespace routing (14 items)"
        onSelect={() => {}}
      />,
    );
    expect(markup).toContain('id="memory-namespace-filter-routing"');
    expect(markup).toContain('aria-label="Filter by namespace routing (14 items)"');
  });

  it("uses tabIndex=-1 when unselected so only the active pill participates in tab order", () => {
    const markup = renderToStaticMarkup(
      <FilterPill label="files" count={2} selected={false} tabIndex={-1} onSelect={() => {}} />,
    );
    expect(markup).toContain('tabindex="-1"');
  });
});

describe("FilterPillGroup", () => {
  const options: FilterPillOption[] = [
    { value: "all", label: "all", count: 37 },
    { value: "knowledge", label: "knowledge", count: 22 },
    { value: "routing", label: "routing", count: 14 },
    { value: "files", label: "files", count: 2 },
  ];

  it("renders a tablist with the supplied accessible label", () => {
    const markup = renderToStaticMarkup(
      <FilterPillGroup label="Memory namespace filter" options={options} value="all" onChange={() => {}} />,
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Memory namespace filter"');
    expect(markup).not.toContain("Swipe for more filters");
    expect(markup).toContain('data-overflowing="false"');
  });

  it("renders nothing when no options are supplied", () => {
    const markup = renderToStaticMarkup(<FilterPillGroup label="empty" options={[]} value="all" onChange={() => {}} />);
    expect(markup).toBe("");
  });

  it("shows the swipe hint only while the rendered pill row overflows", async () => {
    let notifyResize: (() => void) | undefined;
    const dimensions = { scrollWidth: 480, clientWidth: 240 };
    class FakeResizeObserver {
      public constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      public observe() {}
      public disconnect() {}
      public unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <FilterPillGroup label="Memory namespace filter" options={options} value="all" onChange={() => {}} />,
        {
          createNodeMock: (element) => {
            const props = element.props as { className?: string };
            return props.className === "mc-next-filter-pill-group"
              ? dimensions
              : element.type === "button"
                ? { focus: vi.fn() }
                : {};
          },
        },
      );
    });
    expect(renderer!.root.findAllByProps({ className: "mc-next-filter-pill-hint" })).toHaveLength(1);

    dimensions.scrollWidth = 240;
    await act(async () => notifyResize?.());
    expect(renderer!.root.findAllByProps({ className: "mc-next-filter-pill-hint" })).toHaveLength(0);

    act(() => renderer!.unmount());
    vi.unstubAllGlobals();
  });

  it("marks only the active option as selected and tabbable", () => {
    const markup = renderToStaticMarkup(
      <FilterPillGroup label="Memory namespace filter" options={options} value="routing" onChange={() => {}} />,
    );
    // Three selected="false" plus the active one true
    const selectedTrueCount = markup.match(/aria-selected="true"/g)?.length ?? 0;
    const selectedFalseCount = markup.match(/aria-selected="false"/g)?.length ?? 0;
    expect(selectedTrueCount).toBe(1);
    expect(selectedFalseCount).toBe(3);
  });

  it("invokes onChange when a pill is clicked", async () => {
    const onChange = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <FilterPillGroup label="Memory namespace filter" options={options} value="all" onChange={onChange} />,
      );
    });
    const buttons = renderer!.root.findAllByType("button");
    expect(buttons).toHaveLength(4);
    await act(async () => {
      buttons[1]!.props.onClick();
    });
    expect(onChange).toHaveBeenCalledWith("knowledge");
  });

  it("moves selection right when ArrowRight is pressed", async () => {
    const onChange = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <FilterPillGroup label="Memory namespace filter" options={options} value="all" onChange={onChange} />,
      );
    });
    const firstButton = renderer!.root.findAllByType("button")[0]!;
    const preventDefault = vi.fn();
    await act(async () => {
      firstButton.props.onKeyDown({ key: "ArrowRight", preventDefault });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("knowledge");
  });

  it("moves selection left when ArrowLeft is pressed, wrapping from the first pill", async () => {
    const onChange = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <FilterPillGroup label="Memory namespace filter" options={options} value="all" onChange={onChange} />,
      );
    });
    const firstButton = renderer!.root.findAllByType("button")[0]!;
    await act(async () => {
      firstButton.props.onKeyDown({ key: "ArrowLeft", preventDefault: vi.fn() });
    });
    // Wraps to the last option
    expect(onChange).toHaveBeenCalledWith("files");
  });

  it("jumps to the first option on Home and the last on End", async () => {
    const onChange = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <FilterPillGroup label="Memory namespace filter" options={options} value="routing" onChange={onChange} />,
      );
    });
    const buttons = renderer!.root.findAllByType("button");
    // The active button is "routing" (index 2). Press Home from there.
    const routingButton = buttons[2]!;
    await act(async () => {
      routingButton.props.onKeyDown({ key: "Home", preventDefault: vi.fn() });
    });
    expect(onChange).toHaveBeenCalledWith("all");
    onChange.mockClear();
    await act(async () => {
      routingButton.props.onKeyDown({ key: "End", preventDefault: vi.fn() });
    });
    expect(onChange).toHaveBeenCalledWith("files");
  });

  it("ignores unrelated keys (Space, Enter handled by native click)", async () => {
    const onChange = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <FilterPillGroup label="Memory namespace filter" options={options} value="all" onChange={onChange} />,
      );
    });
    const firstButton = renderer!.root.findAllByType("button")[0]!;
    const preventDefault = vi.fn();
    await act(async () => {
      firstButton.props.onKeyDown({ key: "Tab", preventDefault });
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls back to index 0 for the active tabindex when value does not match any option", () => {
    const markup = renderToStaticMarkup(
      <FilterPillGroup label="Memory namespace filter" options={options} value="missing" onChange={() => {}} />,
    );
    // No selected pill, but first option still gets tabIndex=0 for keyboard entry.
    expect(markup).toContain('tabindex="0"');
    expect(markup).not.toContain('aria-selected="true"');
  });
});
