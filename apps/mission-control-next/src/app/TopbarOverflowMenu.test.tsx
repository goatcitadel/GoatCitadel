// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { TopbarOverflowMenu, type TopbarOverflowItem } from "./TopbarOverflowMenu";

function buildItems(overrides: Partial<TopbarOverflowItem>[] = []): TopbarOverflowItem[] {
  const base: TopbarOverflowItem[] = [
    { id: "start-here", label: "Start Here", onSelect: vi.fn() },
    { id: "theme", label: "Switch to light theme", onSelect: vi.fn() },
  ];
  return base.map((item, index) => ({ ...item, ...overrides[index] }));
}

function findTrigger(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ "aria-haspopup": "menu" });
}

describe("TopbarOverflowMenu", () => {
  it("renders nothing when there are no items", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TopbarOverflowMenu items={[]} />);
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it("renders a collapsed trigger and no menu items until opened", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TopbarOverflowMenu items={buildItems()} />);
    });

    const trigger = findTrigger(renderer);
    expect(trigger.props["aria-expanded"]).toBe(false);
    expect(renderer.root.findAllByProps({ role: "menuitem" })).toHaveLength(0);
  });

  it("opens the menu and renders one menuitem per item when the trigger is clicked", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TopbarOverflowMenu items={buildItems()} />);
    });

    act(() => {
      findTrigger(renderer).props.onClick();
    });

    expect(findTrigger(renderer).props["aria-expanded"]).toBe(true);
    expect(renderer.root.findAllByProps({ role: "menuitem" })).toHaveLength(2);
  });

  it("invokes the item handler and closes the menu when an item is selected", () => {
    const onSelect = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TopbarOverflowMenu items={buildItems([{ onSelect }])} />);
    });

    act(() => {
      findTrigger(renderer).props.onClick();
    });
    act(() => {
      renderer.root.findAllByProps({ role: "menuitem" })[0]!.props.onClick();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(findTrigger(renderer).props["aria-expanded"]).toBe(false);
    expect(renderer.root.findAllByProps({ role: "menuitem" })).toHaveLength(0);
  });

  it("closes the menu when Escape is pressed without bubbling to shell handlers", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TopbarOverflowMenu items={buildItems()} />);
    });

    act(() => {
      findTrigger(renderer).props.onClick();
    });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    act(() => {
      renderer.root.findByProps({ role: "menu" }).props.onKeyDown({ key: "Escape", preventDefault, stopPropagation });
    });

    expect(stopPropagation).toHaveBeenCalled();
    expect(findTrigger(renderer).props["aria-expanded"]).toBe(false);
  });

  it("forwards each item's accessible label and active state", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <TopbarOverflowMenu
          items={buildItems([
            { ariaLabel: "Open Start Here" },
            { active: true, ariaLabel: "Switch to light theme" },
          ])}
        />,
      );
    });

    act(() => {
      findTrigger(renderer).props.onClick();
    });

    const items = renderer.root.findAllByProps({ role: "menuitem" });
    expect(items[0]!.props["aria-label"]).toBe("Open Start Here");
    expect(items[1]!.props["aria-label"]).toBe("Switch to light theme");
    expect(String(items[1]!.props.className)).toContain("active");
  });
});
