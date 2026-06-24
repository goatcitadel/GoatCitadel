import { type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NativeList } from "./NativeRoutePageLayout";

// Same mock shape as ChatThreadView: react-test-renderer has no layout, so real
// Virtuoso would window to zero rows. Render every row through itemContent so
// the windowed branch is observable in tests.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data = [],
    computeItemKey,
    itemContent,
    className,
    style,
    "aria-label": ariaLabel,
    "data-native-scroll": dataNativeScroll,
  }: {
    data?: unknown[];
    computeItemKey?: (index: number, item: unknown) => string;
    itemContent: (index: number, item: unknown) => ReactNode;
    className?: string;
    style?: Record<string, unknown>;
    "aria-label"?: string;
    "data-native-scroll"?: string;
  }) => (
    <div
      className={className}
      style={style}
      aria-label={ariaLabel}
      data-native-scroll={dataNativeScroll}
      data-virtuoso="true"
    >
      {data.map((item, index) => (
        <div key={computeItemKey?.(index, item) ?? index} data-virtuoso-item="true">
          {itemContent(index, item)}
        </div>
      ))}
    </div>
  ),
}));

function makeItems(count: number): Array<{ title: string; meta?: string; body?: string }> {
  return Array.from({ length: count }, (_unused, index) => ({
    title: `Item ${index}`,
    meta: `meta ${index}`,
    body: `body ${index}`,
  }));
}

function renderList(node: ReactNode): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(node as never);
  });
  return renderer;
}

function findVirtuoso(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll((candidate) => candidate.props?.["data-virtuoso"] === "true");
}

describe("NativeList opt-in virtualization", () => {
  it("renders plainly (no windowing) by default even for long lists", () => {
    const renderer = renderList(<NativeList items={makeItems(120)} maxHeight="20rem" />);
    expect(findVirtuoso(renderer)).toHaveLength(0);
    // Every item is in the tree under the plain list path.
    expect(renderer.root.findAll((node) => node.props?.className === "mc-next-directory-list-item").length).toBe(120);
    act(() => renderer.unmount());
  });

  it("windows a long list when virtualized and height-bounded past the threshold", () => {
    const renderer = renderList(
      <NativeList items={makeItems(120)} virtualized maxHeight="20rem" ariaLabel="Big list" windowThreshold={50} />,
    );
    const scrollers = findVirtuoso(renderer);
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]?.props["aria-label"]).toBe("Big list");
    expect(scrollers[0]?.props["data-native-scroll"]).toBe("true");
    // Rows still render the shared item markup through the windowed path.
    expect(renderer.root.findAll((node) => node.props?.["data-virtuoso-item"] === "true").length).toBe(120);
    act(() => renderer.unmount());
  });

  it("stays on the plain path for short virtualized lists (below threshold)", () => {
    const renderer = renderList(
      <NativeList items={makeItems(10)} virtualized maxHeight="20rem" windowThreshold={50} />,
    );
    expect(findVirtuoso(renderer)).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.props?.className === "mc-next-directory-list-item").length).toBe(10);
    act(() => renderer.unmount());
  });

  it("falls back to the plain path when virtualized but unbounded (no maxHeight)", () => {
    // Virtuoso needs a bounded height; without one we must not mount it.
    const renderer = renderList(<NativeList items={makeItems(120)} virtualized windowThreshold={50} />);
    expect(findVirtuoso(renderer)).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.props?.className === "mc-next-directory-list-item").length).toBe(120);
    act(() => renderer.unmount());
  });

  it("keeps the empty-state contract regardless of the virtualized flag", () => {
    expect(renderToStaticMarkup(<NativeList items={[]} virtualized maxHeight="20rem" emptyLabel="Nothing yet" />)).toContain(
      "Nothing yet",
    );
  });
});
