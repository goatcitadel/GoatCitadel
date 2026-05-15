import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@radix-ui/react-switch", async () => {
  const ReactModule = await import("react");
  return {
    Root: ReactModule.forwardRef<
      HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement> & { checked?: boolean; disabled?: boolean }
    >(({ checked, disabled, children, ...props }, ref) =>
      ReactModule.createElement(
        "button",
        {
          ...props,
          ref,
          disabled,
          "data-checked": checked ? "" : undefined,
          "data-unchecked": checked ? undefined : "",
          "data-disabled": disabled ? "" : undefined,
        },
        children,
      ),
    ),
    Thumb: ReactModule.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>((props, ref) =>
      ReactModule.createElement("span", { ...props, ref }),
    ),
  };
});

import { GCAlert } from "./GCAlert";
import { Switch } from "./switch";

function textOf(value: unknown): string {
  if (value == null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => textOf(child)).join(" ");
  }
  if (typeof value === "object" && "children" in value) {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

describe("Switch", () => {
  it("passes sizing, disabled state, checked state, and caller classes to the primitive", () => {
    const onClick = vi.fn();
    const renderer = create(<Switch size="sm" checked disabled className="switch-extra" onClick={onClick} />);
    const root = renderer.root.findByProps({ "data-slot": "switch" });
    const thumb = renderer.root.findByProps({ "data-slot": "switch-thumb" });

    expect(root.props["data-size"]).toBe("sm");
    expect(root.props.disabled).toBe(true);
    expect(root.props.className).toContain("switch-extra");
    expect(root.props.className).toContain("data-checked:bg-primary");
    expect(thumb.props.className).toContain("group-data-[size=sm]/switch:size-3");

    act(() => {
      root.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    });

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("GCAlert", () => {
  it("renders info alerts as status regions with optional titles", () => {
    const renderer = create(
      <GCAlert title="Heads up">
        <span>Memory sync queued.</span>
      </GCAlert>,
    );
    const alert = renderer.root.findByProps({ "data-slot": "alert" });

    expect(alert.props.role).toBe("status");
    expect(alert.props.className).toContain("gc-alert-info");
    expect(textOf(renderer.toJSON())).toContain("Heads up");
    expect(textOf(renderer.toJSON())).toContain("Memory sync queued.");
  });

  it("renders error alerts with destructive alert semantics", () => {
    const renderer = create(<GCAlert tone="error">Gateway offline.</GCAlert>);
    const alert = renderer.root.findByProps({ "data-slot": "alert" });

    expect(alert.props.role).toBe("alert");
    expect(alert.props.className).toContain("mc-gc-alert-error");
    expect(alert.props.className).toContain("text-destructive");
    expect(textOf(renderer.toJSON())).toContain("Gateway offline.");
    expect(renderer.root.findAllByProps({ "data-slot": "alert-title" })).toHaveLength(0);
  });
});
