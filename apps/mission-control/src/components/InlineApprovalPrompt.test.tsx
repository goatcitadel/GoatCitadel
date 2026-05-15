import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineApprovalPrompt } from "./InlineApprovalPrompt";

afterEach(() => {
  vi.useRealTimers();
});

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

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => instanceText(button).includes(label));
}

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return ((node as { children?: unknown[] }).children ?? []).map((child) => instanceText(child)).join(" ");
}

describe("InlineApprovalPrompt", () => {
  it("renders a live countdown and disables actions after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
    let renderer = create(<div />);

    try {
      await act(async () => {
        renderer = create(
          <InlineApprovalPrompt
            approvalId="approval-1"
            toolName="shell.exec"
            reason="Approval required by policy."
            expiresAt="2026-03-22T12:00:05.000Z"
            onApproveOnce={() => undefined}
            onApproveInSession={() => undefined}
            onApproveInWorkspace={() => undefined}
            onDeny={() => undefined}
          />,
        );
      });

      const countdownBefore = renderer.root.findAll(
        (node) => typeof node.props.className === "string" && node.props.className.includes("chat-approval-countdown"),
      );
      expect(countdownBefore[0]?.children.join("")).toContain("Expires in 0m 05s");

      await act(async () => {
        vi.advanceTimersByTime(6_000);
      });

      const expiredLabel = renderer.root.findAll(
        (node) =>
          typeof node.props.className === "string" &&
          node.props.className.includes("chat-approval-countdown") &&
          node.props.className.includes("is-expired"),
      );
      expect(expiredLabel[0]?.children.join("")).toContain("Approval expired, rerun the action.");
      const buttons = renderer.root.findAllByType("button");
      expect(buttons.every((button) => button.props.disabled === true)).toBe(true);
    } finally {
      renderer.unmount();
    }
  });

  it("renders risk, resource, and technical details while confirming workspace grants", async () => {
    const onApproveOnce = vi.fn();
    const onApproveInSession = vi.fn();
    const onApproveInWorkspace = vi.fn();
    const onDeny = vi.fn();
    const renderer = create(
      <InlineApprovalPrompt
        approvalId="approval-2"
        kind="tool_call"
        toolName="filesystem.write"
        reason="The worker needs to write a focused test file."
        riskLevel="danger"
        codeHash="sha256-code"
        wrapperManifestHash="sha256-wrapper"
        capabilitySnapshotId="snapshot-1"
        inspectPath="apps/mission-control/src"
        requestedOutputIntent="Persist the test."
        saveCandidateOnSuccess
        remainingCount={2}
        affectedResources={["App.tsx", "SettingsPage.tsx", "OfficePage.tsx", "PromptLabWorkspace.tsx", "extra.ts"]}
        codePreview="writeFileSync('test.ts')"
        approvalsHref="/approvals/approval-2"
        workspaceAllowAvailable
        onApproveOnce={onApproveOnce}
        onApproveInSession={onApproveInSession}
        onApproveInWorkspace={onApproveInWorkspace}
        onDeny={onDeny}
      />,
    );

    const text = rendererText(renderer);
    expect(text).toContain("2 more waiting");
    expect(text).toContain("Danger risk");
    expect(text).toContain("Action type: tool_call");
    expect(text).toContain("Expected result: Persist the test.");
    expect(text).toContain("Touches: App.tsx, SettingsPage.tsx, OfficePage.tsx, PromptLabWorkspace.tsx, +1 more");
    expect(text).toContain("On success, GoatCitadel will stage a candidate skill for review.");
    expect(text).toContain("Code hash: sha256-code");
    expect(text).toContain("Wrapper hash: sha256-wrapper");
    expect(text).toContain("Snapshot: snapshot-1");
    expect(text).toContain("Inspect: apps/mission-control/src");
    expect(text).toContain("Open persisted approval record");

    await act(async () => {
      findButton(renderer, "Allow once")?.props.onClick();
      findButton(renderer, "Allow in session")?.props.onClick();
      findButton(renderer, "Deny")?.props.onClick();
      findButton(renderer, "Allow in workspace")?.props.onClick();
    });

    expect(onApproveOnce).toHaveBeenCalledTimes(1);
    expect(onApproveInSession).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(rendererText(renderer)).toContain("Workspace allow is broader than session allow");

    await act(async () => {
      findButton(renderer, "Cancel")?.props.onClick();
    });
    expect(rendererText(renderer)).not.toContain("Workspace allow is broader than session allow");

    await act(async () => {
      findButton(renderer, "Allow in workspace")?.props.onClick();
    });
    await act(async () => {
      findButton(renderer, "Confirm workspace allow")?.props.onClick();
    });
    expect(onApproveInWorkspace).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it.each([
    ["safe" as const, "shell.read", "Safe risk", "shell.read is ready to continue"],
    ["caution" as const, "browser.open", "Caution risk", "browser.open will continue immediately after approval"],
    ["nuclear" as const, undefined, "Nuclear risk", "remote_delete will continue immediately after approval"],
    [undefined, undefined, "", "remote_delete is paused until you explicitly approve or deny it."],
  ])("summarizes %s risk approvals with the right decision copy", (riskLevel, toolName, riskCopy, decisionCopy) => {
    const renderer = create(
      <InlineApprovalPrompt
        approvalId={`approval-${riskLevel ?? "none"}`}
        kind="remote_delete"
        toolName={toolName}
        riskLevel={riskLevel}
        workspaceAllowAvailable={false}
        onApproveOnce={() => undefined}
        onApproveInSession={() => undefined}
        onApproveInWorkspace={() => undefined}
        onDeny={() => undefined}
      />,
    );

    const text = rendererText(renderer);
    if (riskCopy) {
      expect(text).toContain(riskCopy);
    } else {
      expect(text).not.toContain("risk.");
    }
    expect(text).toContain(decisionCopy);
    expect(findButton(renderer, "Allow in workspace")?.props.disabled).toBe(true);

    renderer.unmount();
  });
});
