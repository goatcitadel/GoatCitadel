import { useEffect, useMemo, useState } from "react";
import type {
  CapabilityCatalogSnapshotRecord,
  CodeModeRunArtifactKind,
  CodeModeRunArtifactPreview,
  CodeModeRunComparisonRecord,
} from "@goatcitadel/contracts";
import {
  compareCodeModeRuns,
  fetchCapabilityCatalogSnapshot,
  fetchCodeModeRunArtifact,
} from "@goatcitadel/mission-control-shared/api/capabilities";
import {
  formatCodeModeArtifactKind,
  isCodeModeArtifactAvailable,
  summarizeCapabilitySnapshotProfile,
} from "./code-workbench-evidence";
import type { useCodeRunLedger } from "./useCodeRunLedger";

export function useCodeRunArtifacts(ledger: ReturnType<typeof useCodeRunLedger>) {
  const { selectedRunDetail, selectedRunScope, selectedRunComparisonScope, comparisonCandidates } = ledger;
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<CapabilityCatalogSnapshotRecord | null>(null);
  const [capabilitySnapshotLoading, setCapabilitySnapshotLoading] = useState(false);
  const [capabilitySnapshotError, setCapabilitySnapshotError] = useState<string | null>(null);
  const [selectedArtifactKind, setSelectedArtifactKind] = useState<CodeModeRunArtifactKind>("source");
  const [artifactPreview, setArtifactPreview] = useState<CodeModeRunArtifactPreview | null>(null);
  const [artifactPreviewLoading, setArtifactPreviewLoading] = useState(false);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  const [compareBaselineRunId, setCompareBaselineRunId] = useState("");
  const [runComparison, setRunComparison] = useState<CodeModeRunComparisonRecord | null>(null);
  const [runComparisonLoading, setRunComparisonLoading] = useState(false);
  const [runComparisonError, setRunComparisonError] = useState<string | null>(null);
  const capabilityProfile = useMemo(() => summarizeCapabilitySnapshotProfile(capabilitySnapshot), [capabilitySnapshot]);
  useEffect(() => {
    const snapshotId = selectedRunDetail?.capabilitySnapshotId;
    if (!snapshotId) {
      setCapabilitySnapshot(null);
      setCapabilitySnapshotError(null);
      setCapabilitySnapshotLoading(false);
      return undefined;
    }
    let cancelled = false;
    setCapabilitySnapshotLoading(true);
    setCapabilitySnapshotError(null);
    setCapabilitySnapshot(null);
    fetchCapabilityCatalogSnapshot(snapshotId)
      .then((snapshot) => {
        if (!cancelled) {
          setCapabilitySnapshot(snapshot);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCapabilitySnapshot(null);
          setCapabilitySnapshotError(
            error instanceof Error ? error.message : "Unable to load frozen capability snapshot.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCapabilitySnapshotLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunDetail?.capabilitySnapshotId]);

  useEffect(() => {
    setCompareBaselineRunId((current) => {
      if (current && comparisonCandidates.some((run) => run.runId === current)) {
        return current;
      }
      return comparisonCandidates[0]?.runId ?? "";
    });
  }, [comparisonCandidates]);

  useEffect(() => {
    if (!selectedRunDetail) {
      setArtifactPreview(null);
      setArtifactPreviewError(null);
      setArtifactPreviewLoading(false);
      return undefined;
    }
    if (!isCodeModeArtifactAvailable(selectedRunDetail, selectedArtifactKind)) {
      setArtifactPreview(null);
      setArtifactPreviewError(
        `${formatCodeModeArtifactKind(selectedArtifactKind)} artifact is not recorded for this run.`,
      );
      setArtifactPreviewLoading(false);
      return undefined;
    }
    let cancelled = false;
    setArtifactPreviewLoading(true);
    setArtifactPreviewError(null);
    setArtifactPreview(null);
    fetchCodeModeRunArtifact(selectedRunDetail.runId, selectedArtifactKind, selectedRunScope)
      .then((preview) => {
        if (!cancelled) {
          setArtifactPreview(preview);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setArtifactPreview(null);
          setArtifactPreviewError(error instanceof Error ? error.message : "Unable to load Code Mode artifact.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setArtifactPreviewLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedArtifactKind, selectedRunDetail, selectedRunScope]);

  useEffect(() => {
    if (!selectedRunDetail || !compareBaselineRunId) {
      setRunComparison(null);
      setRunComparisonError(null);
      setRunComparisonLoading(false);
      return undefined;
    }
    let cancelled = false;
    setRunComparisonLoading(true);
    setRunComparisonError(null);
    setRunComparison(null);
    compareCodeModeRuns(selectedRunDetail.runId, compareBaselineRunId, selectedRunComparisonScope)
      .then((comparison) => {
        if (!cancelled) {
          setRunComparison(comparison);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunComparison(null);
          setRunComparisonError(error instanceof Error ? error.message : "Unable to compare Code Mode runs.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunComparisonLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [compareBaselineRunId, selectedRunComparisonScope, selectedRunDetail]);

  return {
    capabilityProfile,
    capabilitySnapshotLoading,
    capabilitySnapshotError,
    selectedArtifactKind,
    setSelectedArtifactKind,
    artifactPreview,
    artifactPreviewLoading,
    artifactPreviewError,
    compareBaselineRunId,
    setCompareBaselineRunId,
    runComparison,
    runComparisonLoading,
    runComparisonError,
  };
}
