import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsidianIntegrationStatus } from "../../api/client";
import { useIntegrationsObsidianActions } from "./useIntegrationsObsidianActions";

const apiMocks = vi.hoisted(() => ({
  captureObsidianInboxEntry: vi.fn(async () => ({})),
  patchObsidianIntegrationConfig: vi.fn(async () => ({
    enabled: true,
    vaultPath: "F:/vault",
    mode: "read_append",
    allowedSubpaths: ["Projects", "Inbox"],
  })),
  searchObsidianNotes: vi.fn(async () => ({
    items: [
      {
        relativePath: "Projects/GoatCitadel.md",
        title: "GoatCitadel",
        snippet: "Mission control notes",
        score: 0.91,
      },
    ],
  })),
  testObsidianIntegration: vi.fn(async () => ({
    enabled: true,
    reachable: true,
    checkedAt: "2026-05-14T10:00:00.000Z",
  })),
}));

vi.mock("../../api/client", () => ({
  captureObsidianInboxEntry: apiMocks.captureObsidianInboxEntry,
  patchObsidianIntegrationConfig: apiMocks.patchObsidianIntegrationConfig,
  searchObsidianNotes: apiMocks.searchObsidianNotes,
  testObsidianIntegration: apiMocks.testObsidianIntegration,
}));

type Actions = ReturnType<typeof useIntegrationsObsidianActions>;

let latestActions: Actions | null = null;
let latestState: {
  error: string | null;
  busy: null | "save" | "test" | "search" | "capture";
  enabled: boolean;
  vaultPath: string;
  mode: "read_append" | "read_only";
  allowedSubpaths: string;
  status: ObsidianIntegrationStatus | null;
  searchResults: Array<{ relativePath: string; title: string; snippet: string; score: number }>;
  inboxRequest: string;
  loadCalls: Array<{ background?: boolean } | undefined>;
} | null = null;

function Harness(props: {
  query?: string;
  inboxRequest?: string;
  allowedSubpaths?: string;
  enabled?: boolean;
  vaultPath?: string;
  mode?: "read_append" | "read_only";
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "test" | "search" | "capture">(null);
  const [enabled, setEnabled] = useState(props.enabled ?? false);
  const [vaultPath, setVaultPath] = useState(props.vaultPath ?? " F:/vault ");
  const [mode, setMode] = useState<"read_append" | "read_only">(props.mode ?? "read_only");
  const [allowedSubpaths, setAllowedSubpaths] = useState(props.allowedSubpaths ?? " Projects, Inbox ,, ");
  const [status, setStatus] = useState<ObsidianIntegrationStatus | null>(null);
  const [searchResults, setSearchResults] = useState<
    Array<{ relativePath: string; title: string; snippet: string; score: number }>
  >([]);
  const [inboxRequest, setInboxRequest] = useState(props.inboxRequest ?? " Capture this feature idea ");
  const [loadCalls, setLoadCalls] = useState<Array<{ background?: boolean } | undefined>>([]);

  const load = async (options?: { background?: boolean }) => {
    setLoadCalls((current) => [...current, options]);
  };

  latestActions = useIntegrationsObsidianActions({
    obsidianAllowedSubpaths: allowedSubpaths,
    obsidianEnabled: enabled,
    obsidianVaultPath: vaultPath,
    obsidianMode: mode,
    obsidianQuery: props.query ?? "goatcitadel",
    obsidianInboxRequest: inboxRequest,
    load,
    setError,
    setObsidianBusy: setBusy,
    setObsidianEnabled: setEnabled,
    setObsidianVaultPath: setVaultPath,
    setObsidianMode: setMode,
    setObsidianAllowedSubpaths: setAllowedSubpaths,
    setObsidianStatus: setStatus,
    setObsidianSearchResults: setSearchResults,
    setObsidianInboxRequest: setInboxRequest,
  });

  latestState = {
    error,
    busy,
    enabled,
    vaultPath,
    mode,
    allowedSubpaths,
    status,
    searchResults,
    inboxRequest,
    loadCalls,
  };

  return null;
}

describe("useIntegrationsObsidianActions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T10:05:30.000Z"));
    latestActions = null;
    latestState = null;
    for (const mock of Object.values(apiMocks)) {
      mock.mockClear();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves normalized config, tests the vault, and searches notes", async () => {
    await act(async () => {
      create(<Harness enabled vaultPath=" F:/draft-vault " mode="read_append" />);
    });

    await act(async () => {
      await latestActions?.onSaveObsidianConfig();
      await latestActions?.onTestObsidian();
      await latestActions?.onSearchObsidian();
    });

    expect(apiMocks.patchObsidianIntegrationConfig).toHaveBeenCalledWith({
      enabled: true,
      vaultPath: "F:/draft-vault",
      mode: "read_append",
      allowedSubpaths: ["Projects", "Inbox"],
    });
    expect(latestState).toMatchObject({
      error: null,
      busy: null,
      enabled: true,
      vaultPath: "F:/vault",
      mode: "read_append",
      allowedSubpaths: "Projects, Inbox",
      loadCalls: [{ background: true }],
    });
    expect(latestState?.status).toMatchObject({ reachable: true });
    expect(apiMocks.searchObsidianNotes).toHaveBeenCalledWith({ query: "goatcitadel", limit: 8 });
    expect(latestState?.searchResults[0]?.relativePath).toBe("Projects/GoatCitadel.md");
  });

  it("requires a note search query before calling the gateway", async () => {
    await act(async () => {
      create(<Harness query="   " />);
    });

    await act(async () => {
      await latestActions?.onSearchObsidian();
    });

    expect(latestState?.error).toBe("Enter a search query for Obsidian notes.");
    expect(apiMocks.searchObsidianNotes).not.toHaveBeenCalled();
  });

  it("captures inbox requests with a deterministic GoatCitadel inbox id", async () => {
    await act(async () => {
      create(<Harness inboxRequest=" Add a Mission Control checklist " />);
    });

    await act(async () => {
      await latestActions?.onCaptureObsidianInbox();
    });

    expect(apiMocks.captureObsidianInboxEntry).toHaveBeenCalledWith({
      id: "GC-IN-1778753130",
      request: "Add a Mission Control checklist",
      type: "feature",
      priority: "medium",
      owner: "Personal Assistant Goat",
      state: "new",
      taskLink: "[[GoatCitadel Tasks]]",
    });
    expect(latestState?.inboxRequest).toBe("");
    expect(latestState?.error).toBeNull();
    expect(latestState?.busy).toBeNull();
    expect(latestState?.loadCalls).toEqual([{ background: true }]);
  });

  it("requires inbox text before capture", async () => {
    await act(async () => {
      create(<Harness inboxRequest=" " />);
    });

    await act(async () => {
      await latestActions?.onCaptureObsidianInbox();
    });

    expect(latestState?.error).toBe("Enter a short request to capture in Obsidian inbox.");
    expect(apiMocks.captureObsidianInboxEntry).not.toHaveBeenCalled();
  });
});
