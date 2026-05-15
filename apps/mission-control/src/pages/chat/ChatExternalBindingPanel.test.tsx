import React from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/ActionButton", () => ({
  ActionButton: ({
    label,
    disabled,
    pending,
    onClick,
  }: {
    label: string;
    disabled?: boolean;
    pending?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled || pending} onClick={onClick}>
      {pending ? "pending" : label}
    </button>
  ),
}));

vi.mock("../../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    children,
    className,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <section className={className}>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
}));

import { ChatExternalBindingPanel } from "./ChatExternalBindingPanel";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

describe("ChatExternalBindingPanel", () => {
  it("warns for read-only external sessions and persists binding edits", () => {
    const onIntegrationConnectionIdChange = vi.fn();
    const onIntegrationTargetChange = vi.fn();
    const onSaveBinding = vi.fn();
    const renderer = create(
      <ChatExternalBindingPanel
        writable={false}
        integrationConnectionId="slack:workspace-a"
        onIntegrationConnectionIdChange={onIntegrationConnectionIdChange}
        integrationTarget="#ops"
        onIntegrationTargetChange={onIntegrationTargetChange}
        sending={false}
        pending={false}
        controlsDisabled={false}
        onSaveBinding={onSaveBinding}
      />,
    );

    expect(collectText(renderer.toJSON())).toContain("read-only");

    const inputs = renderer.root.findAllByType("input");
    act(() => {
      inputs[0]!.props.onChange({ target: { value: "discord:guild" } });
      inputs[1]!.props.onChange({ target: { value: "thread-1" } });
      renderer.root.findByType("button").props.onClick();
    });

    expect(onIntegrationConnectionIdChange).toHaveBeenCalledWith("discord:guild");
    expect(onIntegrationTargetChange).toHaveBeenCalledWith("thread-1");
    expect(onSaveBinding).toHaveBeenCalledTimes(1);
  });

  it("disables save while sending or pending", () => {
    const renderer = create(
      <ChatExternalBindingPanel
        writable
        integrationConnectionId=""
        onIntegrationConnectionIdChange={() => undefined}
        integrationTarget=""
        onIntegrationTargetChange={() => undefined}
        sending={false}
        pending
        controlsDisabled={false}
        onSaveBinding={() => undefined}
      />,
    );

    expect(collectText(renderer.toJSON())).not.toContain("read-only");
    expect(renderer.root.findByType("button").props.disabled).toBe(true);
  });
});
