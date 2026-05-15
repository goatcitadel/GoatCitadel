import React, { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ShellDetailPanelProvider, type ShellDetailPanelEntry, useShellDetailPanel } from "./ShellDetailPanelContext";

function Probe({ entry }: { entry?: ShellDetailPanelEntry }) {
  const panel = useShellDetailPanel();
  const { registerEntry } = panel;

  useEffect(() => {
    if (!entry) {
      return undefined;
    }
    return registerEntry(entry);
  }, [entry, registerEntry]);

  return (
    <div>
      <span>{panel.activeEntry?.title ?? "none"}</span>
      <span>{panel.isOpen ? "open" : "closed"}</span>
      <button type="button" onClick={panel.openPanel}>
        Open
      </button>
      <button type="button" onClick={panel.closePanel}>
        Close
      </button>
    </div>
  );
}

function text(renderer: ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}

describe("ShellDetailPanelContext", () => {
  it("exposes open controls and selects the newest entry when priorities tie", () => {
    const onOpenPanel = vi.fn();
    const onClosePanel = vi.fn();
    const onActiveEntryChange = vi.fn();
    const first = { id: "first", title: "First", body: <p>First body</p> };
    const second = { id: "second", title: "Second", body: <p>Second body</p> };
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(
        <ShellDetailPanelProvider
          isOpen
          onOpenPanel={onOpenPanel}
          onClosePanel={onClosePanel}
          onActiveEntryChange={onActiveEntryChange}
        >
          <Probe entry={first} />
          <Probe entry={second} />
        </ShellDetailPanelProvider>,
      );
    });

    expect(text(renderer!)).toContain("Second");
    expect(text(renderer!)).toContain("open");
    expect(onActiveEntryChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: "second" }));

    act(() => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Open"))
        ?.props.onClick();
    });
    act(() => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Close"))
        ?.props.onClick();
    });
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("prefers higher priority entries and falls back after unregister", () => {
    const low = { id: "low", title: "Low", priority: 1, body: <p>Low body</p> };
    const high = { id: "high", title: "High", priority: 5, body: <p>High body</p> };
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(
        <ShellDetailPanelProvider isOpen={false} onOpenPanel={vi.fn()} onClosePanel={vi.fn()}>
          <Probe entry={low} />
          <Probe entry={high} />
        </ShellDetailPanelProvider>,
      );
    });

    expect(text(renderer!)).toContain("High");
    expect(text(renderer!)).toContain("closed");

    act(() => {
      renderer!.update(
        <ShellDetailPanelProvider isOpen={false} onOpenPanel={vi.fn()} onClosePanel={vi.fn()}>
          <Probe entry={low} />
        </ShellDetailPanelProvider>,
      );
    });

    expect(text(renderer!)).toContain("Low");
  });

  it("returns inert defaults outside the provider", () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });

    expect(text(renderer!)).toContain("none");
    expect(text(renderer!)).toContain("closed");
    act(() => {
      renderer!.root.findAllByType("button").forEach((button) => button.props.onClick());
    });
  });
});
