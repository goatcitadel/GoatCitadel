// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

const routeShortcuts = [
  { label: "Work", letter: "c" },
  { label: "Settings", letter: "s" },
];

describe("ShortcutsOverlay", () => {
  it("renders nothing when closed", () => {
    const markup = renderToStaticMarkup(
      <ShortcutsOverlay open={false} onClose={() => {}} routeShortcuts={routeShortcuts} />,
    );
    expect(markup).toBe("");
  });

  it("renders a labelled modal dialog with the route shortcuts when open", () => {
    const markup = renderToStaticMarkup(<ShortcutsOverlay open onClose={() => {}} routeShortcuts={routeShortcuts} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Command palette");
    expect(markup).toContain("Go to Work");
    expect(markup).toContain("Go to Settings");
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ShortcutsOverlay open onClose={onClose} routeShortcuts={routeShortcuts} />);
    });
    const backdrop = renderer!.root.findByProps({ className: "mc-next-shortcuts-overlay" });
    await act(async () => {
      backdrop.props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the close button is activated", async () => {
    const onClose = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ShortcutsOverlay open onClose={onClose} routeShortcuts={routeShortcuts} />);
    });
    const button = renderer!.root.findByType("button");
    await act(async () => {
      button.props.onClick();
    });
    expect(onClose).toHaveBeenCalled();
  });
});
