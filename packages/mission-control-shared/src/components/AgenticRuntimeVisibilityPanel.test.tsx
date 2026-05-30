import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgenticRuntimeVisibilityPanel } from "./AgenticRuntimeVisibilityPanel";

const apiMocks = vi.hoisted(() => ({
  fetchAgenticChannelDeliveries: vi.fn(),
  fetchAgenticRuntimeAvailability: vi.fn(),
}));

vi.mock("../api/agentic", () => ({
  fetchAgenticChannelDeliveries: apiMocks.fetchAgenticChannelDeliveries,
  fetchAgenticRuntimeAvailability: apiMocks.fetchAgenticRuntimeAvailability,
}));

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join(" ");
  }
  return "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AgenticRuntimeVisibilityPanel", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    renderer = null;
    vi.clearAllMocks();
    apiMocks.fetchAgenticRuntimeAvailability.mockResolvedValue({
      generatedAt: "2026-01-01T00:00:00.000Z",
      scalability: [
        {
          trackId: "a2a_protocol",
          label: "A2A protocol interoperability",
          kind: "agent_protocol",
          status: "unavailable",
          callable: false,
          implementationStatus: "missing",
          summary: "A2A is not implemented as a protocol surface.",
          reasons: ["No A2A Agent Card contracts, discovery routes, or JSON-RPC handlers are registered."],
          evidence: [],
          requiredNextSteps: [
            "Add A2A contracts for Agent Cards, messages, tasks, artifacts, streaming events, and auth metadata",
          ],
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      harnesses: [
        {
          harnessId: "playwright",
          label: "Browser harness",
          status: "callable",
          callable: true,
          reasons: [],
          sandboxRequired: true,
          sandboxSatisfied: false,
        },
        {
          harnessId: "shell",
          label: "Shell harness",
          status: "blocked",
          callable: false,
          reasons: ["Denied by policy."],
          executablePath: "pwsh.exe",
        },
        {
          harnessId: "manual",
          label: "Manual harness",
          status: "callable",
          callable: false,
          reasons: [],
        },
      ],
      plugins: [
        {
          runtimeId: "plugin-good",
          label: "Plugin OK",
          status: "callable",
          callableExposure: "callable",
          integrityStatus: "healthy",
          healthMessage: "Ready",
          permissions: ["files.read"],
          secretsRequired: [],
          rollbackRef: "v1",
        },
        {
          runtimeId: "plugin-bad",
          label: "Plugin Bad",
          status: "callable",
          callableExposure: "blocked",
          integrityStatus: "corrupt",
          healthMessage: "Hash mismatch",
          permissions: ["files.write"],
          secretsRequired: ["TOKEN"],
        },
      ],
      providers: [
        {
          runtimeId: "provider-1",
          label: "Provider",
          status: "not_configured",
          callableExposure: "not_configured",
          integrityStatus: "healthy",
          healthMessage: "Missing key",
          permissions: [],
          secretsRequired: ["API_KEY"],
        },
      ],
      channels: [
        { capabilityId: "email", label: "Email", status: "blocked", callable: false, reasons: ["No account."] },
        { capabilityId: "chat", label: "Chat", status: "callable", callable: false, reasons: [] },
      ],
    });
    apiMocks.fetchAgenticChannelDeliveries.mockResolvedValue({
      deliveries: [
        {
          deliveryId: "delivery-1",
          channelKey: "email",
          target: "ops@example.com",
          status: "sent",
          attempts: 1,
          maxAttempts: 3,
          providerMessageId: "msg-1",
        },
        {
          deliveryId: "delivery-2",
          channelKey: "slack",
          target: "#ops",
          status: "retrying",
          attempts: 2,
          maxAttempts: 3,
          nextAttemptAt: "2026-01-01T00:05:00.000Z",
          staleReason: "Backoff",
        },
        {
          deliveryId: "delivery-3",
          channelKey: "sms",
          target: "+15555550123",
          status: "failed",
          attempts: 3,
          maxAttempts: 3,
          error: "Provider rejected message.",
        },
        {
          deliveryId: "delivery-4",
          channelKey: "webhook",
          target: "ops-hook",
          status: "cancelled",
          attempts: 1,
          maxAttempts: 1,
        },
      ],
    });
  });

  afterEach(() => {
    renderer?.unmount();
  });

  it("loads runtime availability groups and channel delivery posture", async () => {
    renderer = create(<AgenticRuntimeVisibilityPanel surface="code" className="extra" deliveryLimit={3} />);
    expect(textOf(renderer.toJSON())).toContain("checking");

    await flush();
    const rendered = textOf(renderer.toJSON());
    expect(apiMocks.fetchAgenticChannelDeliveries).toHaveBeenCalledWith({ limit: 3 });
    expect(rendered).toContain("Code runtime availability");
    expect(rendered).toContain("Generated");
    expect(rendered).toContain("2026-01-01T00:00:00.000Z");
    expect(rendered).toContain("Scalability");
    expect(rendered).toContain("A2A protocol interoperability");
    expect(rendered).toContain("Protocol missing.");
    expect(rendered).toContain("No A2A Agent Card contracts");
    expect(rendered).toContain("Sandbox posture is not satisfied.");
    expect(rendered).toContain("Executable pwsh.exe.");
    expect(rendered).toContain("Manual harness");
    expect(rendered).toContain("Runtime checks did not prove it callable.");
    expect(rendered).toContain("Permissions: files.write.");
    expect(rendered).toContain("Rollback v1.");
    expect(rendered).toContain("Integrity is corrupt.");
    expect(rendered).toContain("Secrets required: TOKEN.");
    expect(rendered).toContain("No account.");
    expect(rendered).toContain("email");
    expect(rendered).toContain("ops@example.com");
    expect(rendered).toContain("provider msg-1");
    expect(rendered).toContain("Backoff");
    expect(rendered).toContain("Provider rejected message.");
    expect(rendered).toContain("webhook");
    expect(rendered).toContain("cancelled");
  });

  it("renders empty loading groups and surfaces load failures", async () => {
    apiMocks.fetchAgenticRuntimeAvailability.mockResolvedValueOnce({
      generatedAt: "2026-01-01T00:00:00.000Z",
      scalability: [],
      harnesses: [],
      plugins: [],
      providers: [],
      channels: [],
    });
    apiMocks.fetchAgenticChannelDeliveries.mockResolvedValueOnce({ deliveries: [] });
    renderer = create(<AgenticRuntimeVisibilityPanel surface="cowork" />);
    expect(textOf(renderer.toJSON())).toContain("Loading channel delivery state");
    await flush();
    expect(textOf(renderer.toJSON())).toContain("No scalability tracks are reported yet.");
    expect(textOf(renderer.toJSON())).toContain("harnesses");
    expect(textOf(renderer.toJSON())).toContain("are reported yet.");
    expect(textOf(renderer.toJSON())).toContain("No queued or historical channel deliveries are visible.");

    apiMocks.fetchAgenticRuntimeAvailability.mockRejectedValueOnce(new Error("runtime offline"));
    renderer.update(<AgenticRuntimeVisibilityPanel surface="cowork" deliveryLimit={2} />);
    await flush();
    expect(textOf(renderer.toJSON())).toContain("runtime offline");
    expect(textOf(renderer.toJSON())).toContain("unavailable");
  });
});
