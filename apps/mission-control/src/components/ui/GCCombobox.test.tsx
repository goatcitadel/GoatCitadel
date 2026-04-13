import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { GCCombobox } from "./GCCombobox";

vi.mock("@radix-ui/react-popover", () => ({
  Root: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Content: ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>,
}));

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GCCombobox", () => {
  it("does not crash when the highlighted option disappears during a rerender", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    const onChange = vi.fn();

    await act(async () => {
      renderer = create(
        <GCCombobox
          value="alpha"
          onChange={onChange}
          options={[
            { value: "alpha", label: "Alpha" },
            { value: "beta", label: "Beta" },
          ]}
        />,
      );
    });

    const trigger = renderer.root.findAllByType("button").find((button) =>
      String(button.props.className ?? "").includes("gc-combobox-trigger"),
    );
    expect(trigger).toBeDefined();
    await act(async () => {
      trigger?.props.onKeyDown({
        key: "ArrowDown",
        preventDefault() {},
      });
    });
    await flush();

    await act(async () => {
      renderer.update(<GCCombobox value="" onChange={onChange} options={[]} />);
    });

    const input = renderer.root.findByType("input");
    expect(input.props["aria-activedescendant"]).toBeUndefined();
  });
});
