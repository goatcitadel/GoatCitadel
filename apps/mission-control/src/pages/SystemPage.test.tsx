import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchSystemVitals: vi.fn(),
  fetchDaemonStatus: vi.fn(),
  fetchDaemonLogs: vi.fn(),
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
  restartDaemon: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchSystemVitals: apiMocks.fetchSystemVitals,
  fetchDaemonStatus: apiMocks.fetchDaemonStatus,
  fetchDaemonLogs: apiMocks.fetchDaemonLogs,
  startDaemon: apiMocks.startDaemon,
  stopDaemon: apiMocks.stopDaemon,
  restartDaemon: apiMocks.restartDaemon,
}));

import { SystemPage } from "./SystemPage";

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

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const instanceText = (node: unknown): string => {
    if (typeof node === "string") {
      return node;
    }
    if (!node || typeof node !== "object" || !("children" in node)) {
      return "";
    }
    const children = (node as { children?: unknown[] }).children ?? [];
    return children.map((child) => instanceText(child)).join(" ");
  };

  const button = renderer.root.findAll((node) => {
    if (node.type !== "button") {
      return false;
    }
    return instanceText(node).replace(/\s+/g, " ").includes(label);
  })[0];

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  await act(async () => {
    button.props.onClick();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("SystemPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchSystemVitals.mockResolvedValue({
      hostname: "goat-box",
      platform: "win32",
      release: "11",
      uptimeSeconds: 123,
      loadAverage: [0.1, 0.2, 0.3],
      cpuCount: 8,
      memoryTotalBytes: 16 * 1024 * 1024 * 1024,
      memoryFreeBytes: 8 * 1024 * 1024 * 1024,
      memoryUsedBytes: 8 * 1024 * 1024 * 1024,
      processRssBytes: 256 * 1024 * 1024 * 1024,
      processHeapUsedBytes: 128 * 1024 * 1024,
    });
    apiMocks.fetchDaemonStatus.mockResolvedValue({
      state: "running",
      running: true,
      pid: 4242,
      uptimeSeconds: 45,
      host: "goat-box",
      supported: true,
      controllable: true,
      controlMessage: "Local daemon control is available.",
    });
    apiMocks.fetchDaemonLogs.mockResolvedValue({
      items: [
        {
          timestamp: "2026-03-29T00:00:00.000Z",
          level: "info",
          message: "daemon ready",
        },
      ],
    });
    apiMocks.startDaemon.mockResolvedValue({
      accepted: true,
      reason: "started",
      status: {
        state: "running",
        running: true,
        pid: 4242,
        uptimeSeconds: 45,
        host: "goat-box",
        supported: true,
        controllable: true,
        controlMessage: "Local daemon control is available.",
      },
    });
    apiMocks.stopDaemon.mockResolvedValue({
      accepted: true,
      reason: "stopped",
      status: {
        state: "stopped",
        running: false,
        pid: 0,
        uptimeSeconds: 0,
        host: "goat-box",
        supported: true,
        controllable: true,
        controlMessage: "Local daemon control is available.",
      },
    });
    apiMocks.restartDaemon.mockResolvedValue({
      accepted: true,
      reason: "restarted",
      status: {
        state: "running",
        running: true,
        pid: 4343,
        uptimeSeconds: 1,
        host: "goat-box",
        supported: true,
        controllable: true,
        controlMessage: "Local daemon control is available.",
      },
    });
  });

  it("renders the runtime-health page without parity surfaces", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SystemPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Host Vitals");
      expect(text).toContain("Service Manager");
      expect(text).toContain("daemon ready");
      expect(text).toContain("8.00 GB");
      expect(text).toContain("of 16.00 GB host memory");
      expect(text).toContain("Start");
      expect(text).toContain("Stop");
      expect(text).toContain("Restart");
      expect(text).toContain("Refresh");
      expect(text).not.toContain("OpenClaw");
      expect(text).not.toContain("Follow-On Parity");
      expect(text).not.toContain("proof lane");
      expect(text).not.toContain("parity");
    } finally {
      renderer.unmount();
    }
  });

  it("refreshes daemon status and logs on demand", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SystemPage />);
      });
      await flush();

      expect(apiMocks.fetchDaemonStatus).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchDaemonLogs).toHaveBeenCalledTimes(1);

      await clickButton(renderer, "Refresh");
      await flush();

      expect(apiMocks.fetchDaemonStatus).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchDaemonLogs).toHaveBeenCalledTimes(2);
    } finally {
      renderer.unmount();
    }
  });

  it("shows an error when the initial vitals load fails", async () => {
    apiMocks.fetchSystemVitals.mockRejectedValue(new Error("vitals unavailable"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SystemPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("vitals unavailable");
    } finally {
      renderer.unmount();
    }
  });
});
