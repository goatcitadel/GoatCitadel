import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateStatus } from "@goatcitadel/contracts";
const bridge = vi.hoisted(() => ({ status: null as DesktopUpdateStatus | null, requestDesktopUpdate: vi.fn() }));
vi.mock("./desktop-update-bridge", () => ({
  useDesktopUpdates: () => bridge.status,
  requestDesktopUpdate: bridge.requestDesktopUpdate,
}));
import { DesktopUpdatesPanel } from "./DesktopUpdatesPanel";

const available: DesktopUpdateStatus = {
  channel: "preview",
  phase: "available",
  installedVersion: "0.1.0-preview.1.0",
  installedCommit: "a".repeat(40),
  lastSuccessfulCheck: "2026-09-19T12:00:00Z",
  nextCheckAt: null,
  snoozedUntil: null,
  downloadedBytes: 0,
  downloadedPath: null,
  message: "An update is available.",
  availableRelease: {
    channel: "preview",
    tag: "preview-2-1",
    version: "0.1.0-preview.2.0",
    sourceCommit: "b".repeat(40),
    buildSequence: 2,
    publishedAt: "2026-09-19T12:00:00Z",
    releaseNotes: "Fix chat history.",
    publisherSigned: false,
    installer: { name: "setup.exe", url: "https://example.test/setup.exe", sizeBytes: 100, sha256: "c".repeat(64) },
  },
};
describe("DesktopUpdatesPanel", () => {
  beforeEach(() => {
    bridge.status = structuredClone(available);
    bridge.requestDesktopUpdate.mockReset().mockResolvedValue(undefined);
  });
  it("shows versions and unsigned truth and waits for an explicit download click", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DesktopUpdatesPanel />);
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Unsigned preview");
    expect(text).toContain("0.1.0-preview.2.0");
    expect(bridge.requestDesktopUpdate).not.toHaveBeenCalled();
    const button = renderer.root.findAllByType("button").find((candidate) => candidate.children.includes("Download"))!;
    await act(async () => {
      button.props.onClick();
    });
    expect(bridge.requestDesktopUpdate).toHaveBeenCalledWith(
      "download",
      expect.objectContaining({ releaseTag: "preview-2-1" }),
    );
    await act(async () => {
      renderer.unmount();
    });
  });
  it("offers channel selection and persisted snoozing through the native owner", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DesktopUpdatesPanel />);
    });
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: "stable" } });
    });
    expect(bridge.requestDesktopUpdate).toHaveBeenCalledWith("channel", expect.objectContaining({ channel: "stable" }));
    const later = renderer.root
      .findAllByType("button")
      .find((candidate) => candidate.children.includes("Remind me tomorrow"))!;
    await act(async () => {
      later.props.onClick();
    });
    expect(bridge.requestDesktopUpdate).toHaveBeenCalledWith("snooze", expect.anything());
    await act(async () => {
      renderer.unmount();
    });
  });
  it("has a useful browser fallback and disables controls during download", async () => {
    bridge.status = null;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DesktopUpdatesPanel />);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("installed Windows app");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    bridge.status = { ...available, phase: "downloading", downloadedBytes: 50 };
    await act(async () => {
      renderer.update(<DesktopUpdatesPanel />);
    });
    expect(renderer.root.findByType("progress").props.value).toBe(50);
    expect(renderer.root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);
    await act(async () => {
      renderer.unmount();
    });
  });
});
