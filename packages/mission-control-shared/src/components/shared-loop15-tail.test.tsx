import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ConfigFormBuilder } from "./ConfigFormBuilder";
import { useShellDetailPanel } from "./ShellDetailPanelContext";

function ShellDetailFallbackProbe({
  onSnapshot,
}: {
  onSnapshot: (value: ReturnType<typeof useShellDetailPanel>) => void;
}) {
  const context = useShellDetailPanel();
  React.useEffect(() => {
    onSnapshot(context);
  }, [context, onSnapshot]);
  return <span>{context.activeEntry?.title ?? "none"}</span>;
}

describe("shared loop 15 component tails", () => {
  it("keeps shell detail default callbacks safe outside a provider", () => {
    const snapshots: Array<ReturnType<typeof useShellDetailPanel>> = [];

    create(<ShellDetailFallbackProbe onSnapshot={(snapshot) => snapshots.push(snapshot)} />);

    expect(snapshots.at(-1)?.isOpen).toBe(false);
    expect(() => snapshots.at(-1)?.openPanel()).not.toThrow();
    expect(() => snapshots.at(-1)?.closePanel()).not.toThrow();
    expect(typeof snapshots.at(-1)?.registerEntry({ id: "fallback", title: "Fallback", body: "Body" })).toBe(
      "function",
    );
  });

  it("routes select field changes through ConfigFormBuilder with existing form values intact", () => {
    const onChange = vi.fn();
    const renderer = create(
      <ConfigFormBuilder
        schema={
          {
            title: "Slack",
            fields: [
              {
                key: "channel",
                label: "Channel",
                type: "select",
                options: [
                  { value: "ops", label: "Ops" },
                  { value: "dev", label: "Dev" },
                ],
              },
            ],
          } as never
        }
        value={{ enabled: true, channel: "ops" }}
        onChange={onChange}
      />,
    );

    act(() => {
      renderer.root.findByType("select").props.onChange({ target: { value: "dev" } });
    });

    expect(onChange).toHaveBeenCalledWith({ enabled: true, channel: "dev" });
  });
});
