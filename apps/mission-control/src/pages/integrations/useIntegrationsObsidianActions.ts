import { useCallback } from "react";
import {
  captureObsidianInboxEntry,
  patchObsidianIntegrationConfig,
  searchObsidianNotes,
  testObsidianIntegration,
  type ObsidianIntegrationStatus,
} from "../../api/client";

type UseIntegrationsObsidianActionsArgs = {
  obsidianAllowedSubpaths: string;
  obsidianEnabled: boolean;
  obsidianVaultPath: string;
  obsidianMode: "read_append" | "read_only";
  obsidianQuery: string;
  obsidianInboxRequest: string;
  load: (options?: { background?: boolean }) => Promise<void>;
  setError: (value: string | null) => void;
  setObsidianBusy: (value: null | "save" | "test" | "search" | "capture") => void;
  setObsidianEnabled: (value: boolean) => void;
  setObsidianVaultPath: (value: string) => void;
  setObsidianMode: (value: "read_append" | "read_only") => void;
  setObsidianAllowedSubpaths: (value: string) => void;
  setObsidianStatus: (value: ObsidianIntegrationStatus | null) => void;
  setObsidianSearchResults: (
    value: Array<{
      relativePath: string;
      title: string;
      snippet: string;
      score: number;
    }>,
  ) => void;
  setObsidianInboxRequest: (value: string) => void;
};

export function useIntegrationsObsidianActions({
  obsidianAllowedSubpaths,
  obsidianEnabled,
  obsidianVaultPath,
  obsidianMode,
  obsidianQuery,
  obsidianInboxRequest,
  load,
  setError,
  setObsidianBusy,
  setObsidianEnabled,
  setObsidianVaultPath,
  setObsidianMode,
  setObsidianAllowedSubpaths,
  setObsidianStatus,
  setObsidianSearchResults,
  setObsidianInboxRequest,
}: UseIntegrationsObsidianActionsArgs) {
  const onSaveObsidianConfig = useCallback(async () => {
    setObsidianBusy("save");
    try {
      const allowedSubpaths = obsidianAllowedSubpaths
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const updated = await patchObsidianIntegrationConfig({
        enabled: obsidianEnabled,
        vaultPath: obsidianVaultPath.trim(),
        mode: obsidianMode,
        allowedSubpaths,
      });
      setObsidianEnabled(updated.enabled);
      setObsidianVaultPath(updated.vaultPath);
      setObsidianMode(updated.mode);
      setObsidianAllowedSubpaths(updated.allowedSubpaths.join(", "));
      setError(null);
      await load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setObsidianBusy(null);
    }
  }, [
    load,
    obsidianAllowedSubpaths,
    obsidianEnabled,
    obsidianMode,
    obsidianVaultPath,
    setError,
    setObsidianAllowedSubpaths,
    setObsidianBusy,
    setObsidianEnabled,
    setObsidianMode,
    setObsidianVaultPath,
  ]);

  const onTestObsidian = useCallback(async () => {
    setObsidianBusy("test");
    try {
      const tested = await testObsidianIntegration();
      setObsidianStatus(tested);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setObsidianBusy(null);
    }
  }, [setError, setObsidianBusy, setObsidianStatus]);

  const onSearchObsidian = useCallback(async () => {
    const query = obsidianQuery.trim();
    if (!query) {
      setError("Enter a search query for Obsidian notes.");
      return;
    }
    setObsidianBusy("search");
    try {
      const response = await searchObsidianNotes({ query, limit: 8 });
      setObsidianSearchResults(response.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setObsidianBusy(null);
    }
  }, [obsidianQuery, setError, setObsidianBusy, setObsidianSearchResults]);

  const onCaptureObsidianInbox = useCallback(async () => {
    const requestText = obsidianInboxRequest.trim();
    if (!requestText) {
      setError("Enter a short request to capture in Obsidian inbox.");
      return;
    }
    setObsidianBusy("capture");
    try {
      await captureObsidianInboxEntry({
        id: `GC-IN-${Math.floor(Date.now() / 1000)}`,
        request: requestText,
        type: "feature",
        priority: "medium",
        owner: "Personal Assistant Goat",
        state: "new",
        taskLink: "[[GoatCitadel Tasks]]",
      });
      setObsidianInboxRequest("");
      setError(null);
      await load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setObsidianBusy(null);
    }
  }, [load, obsidianInboxRequest, setError, setObsidianBusy, setObsidianInboxRequest]);

  return {
    onSaveObsidianConfig,
    onTestObsidian,
    onSearchObsidian,
    onCaptureObsidianInbox,
  };
}
