// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { RailGroupTabs } from "./RailGroupTabs";
import type { AppRoute, RailItem } from "./route-model";

const items: RailItem[] = [
  { id: "providers", label: "Providers", description: "Model providers.", area: "settings", section: "providers" },
  { id: "local-ai", label: "Local AI", description: "Local runtimes.", area: "settings", section: "local-ai" },
];

describe("RailGroupTabs", () => {
  it("lists the active page's sections and marks the current one", () => {
    const navigate = vi.fn();
    let renderer!: ReactTestRenderer;
    const route: AppRoute = { area: "settings", section: "local-ai" };
    act(() => {
      renderer = create(<RailGroupTabs route={route} sections={[{ id: "settings-models", label: "Models", items }]} navigate={navigate} />);
    });
    const buttons = renderer.root.findAllByType("button");
    expect(buttons.map((button) => button.props.children)).toEqual(["Providers", "Local AI"]);
    expect(buttons[1]!.props["aria-current"]).toBe("page");
    act(() => buttons[0]!.props.onClick());
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ area: "settings", section: "providers" }));
  });

  it("renders nothing for a single-section page", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<RailGroupTabs route={{ area: "settings", section: "providers" }} sections={[{ id: "settings-access", label: "Access", items: [items[0]!] }]} navigate={vi.fn()} />);
    });
    expect(renderer.toJSON()).toBeNull();
  });
});
