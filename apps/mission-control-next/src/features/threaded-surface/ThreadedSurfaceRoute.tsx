import { useEffect, useMemo, useState } from "react";
import type { ChatMode } from "@goatcitadel/contracts";
import { fetchEffectivePermissionProfile } from "@goatcitadel/mission-control-shared/api/client";
import {
  MissionThreadedControllerHost,
  type MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import type { ThreadedGatewayStatusSummary } from "@goatcitadel/threaded-surface-core/work-trust";
import { ThreadedSurfacePage, type ThreadedPermissionState } from "./ThreadedSurfacePage";

export function ThreadedSurfaceRoute({
  surface,
  workspaceId,
  workspaceName,
  gatewayStatus,
  approvalsCount,
  lockSurface,
  hidePageHeader,
  initialModeOverride,
  onOpenCowork,
  onOpenCode,
  onOpenTasks,
  onOpenApprovals,
  onCopyTrustReport,
  onOpenStartHere,
  onOpenPersonalitiesSettings,
  onOpenLibraryArtifacts,
  onOpenOpsRuntime,
  onOpenUniversalRunDetail,
  onNavigateSurface,
  onResolvedModeChange,
}: {
  surface: ChatMode;
  workspaceId: string;
  workspaceName: string;
  gatewayStatus?: ThreadedGatewayStatusSummary;
  approvalsCount: number;
  lockSurface?: boolean;
  hidePageHeader?: boolean;
  initialModeOverride?: ChatMode;
  onOpenCowork?: () => void;
  onOpenCode?: () => void;
  onOpenTasks?: () => void;
  onOpenApprovals?: (approvalId?: string) => void;
  onCopyTrustReport?: (sessionId?: string | null, turnId?: string | null) => void;
  onOpenStartHere?: () => void;
  onOpenPersonalitiesSettings?: () => void;
  onOpenLibraryArtifacts?: () => void;
  onOpenOpsRuntime?: () => void;
  onOpenUniversalRunDetail?: (runId: string) => void;
  onNavigateSurface?: (
    surface: ChatMode,
    options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
  ) => void;
  onResolvedModeChange?: (mode: ChatMode, origin?: "session-sync" | "manual-override") => void;
}) {
  return (
    <MissionThreadedControllerHost
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      gatewayStatus={gatewayStatus}
      approvalsCount={approvalsCount}
      surface={surface}
      lockSurface={lockSurface}
      hidePageHeader={hidePageHeader}
      initialModeOverride={initialModeOverride}
      onOpenCowork={onOpenCowork}
      onOpenCode={onOpenCode}
      onOpenTasks={onOpenTasks}
      onOpenApprovals={onOpenApprovals}
      onOpenStartHere={onOpenStartHere}
      onOpenPersonalitiesSettings={onOpenPersonalitiesSettings}
      onOpenLibraryArtifacts={onOpenLibraryArtifacts}
      onOpenOpsRuntime={onOpenOpsRuntime}
      onNavigateSurface={onNavigateSurface}
      onResolvedModeChange={onResolvedModeChange}
      renderSurface={(input: MissionThreadedRenderSurfaceInput) => (
        <ThreadedSurfacePermissionBridge
          surface={surface}
          workspaceId={workspaceId}
          input={input}
          onCopyTrustReport={onCopyTrustReport}
          onOpenUniversalRunDetail={onOpenUniversalRunDetail}
        />
      )}
    />
  );
}

function ThreadedSurfacePermissionBridge({
  surface,
  workspaceId,
  input,
  onCopyTrustReport,
  onOpenUniversalRunDetail,
}: {
  surface: ChatMode;
  workspaceId: string;
  input: MissionThreadedRenderSurfaceInput;
  onCopyTrustReport?: (sessionId?: string | null, turnId?: string | null) => void;
  onOpenUniversalRunDetail?: (runId: string) => void;
}) {
  const selectedSessionId =
    input.activeSessionSurfaceProps?.selectedSessionId ?? input.contextDockProps?.selectedSessionId ?? undefined;
  const selectedTurn = input.activeSessionSurfaceProps?.selectedTurn ?? input.contextDockProps?.selectedTurn ?? null;
  const selectedRunId = selectedTurn?.trace.orchestration?.runId ?? selectedTurn?.trace.durable?.runId;
  const permissionQuery = useMemo(
    () =>
      resolveThreadedPermissionQuery({
        workspaceId,
        surface,
        selectedSessionId,
        selectedRunId,
      }),
    [workspaceId, surface, selectedSessionId, selectedRunId],
  );
  const [permissionState, setPermissionState] = useState<ThreadedPermissionState>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setPermissionState((current) => ({ ...current, loading: true, error: undefined }));
    void fetchEffectivePermissionProfile(permissionQuery)
      .then((context) => {
        if (!cancelled) {
          setPermissionState(readThreadedPermissionState(context));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPermissionState({ loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [permissionQuery]);

  return (
    <ThreadedSurfacePage
      surface={surface}
      input={input}
      permissionState={permissionState}
      onCopyTrustReport={onCopyTrustReport}
      onOpenUniversalRunDetail={onOpenUniversalRunDetail}
    />
  );
}

export function resolveThreadedPermissionQuery({
  workspaceId,
  surface,
  input,
  selectedSessionId: explicitSelectedSessionId,
  selectedRunId: explicitSelectedRunId,
}: {
  workspaceId: string;
  surface: ChatMode;
  input?: MissionThreadedRenderSurfaceInput;
  selectedSessionId?: string;
  selectedRunId?: string;
}) {
  const selectedSessionId =
    explicitSelectedSessionId ??
    input?.activeSessionSurfaceProps?.selectedSessionId ??
    input?.contextDockProps?.selectedSessionId ??
    undefined;
  const selectedTurn = input?.activeSessionSurfaceProps?.selectedTurn ?? input?.contextDockProps?.selectedTurn ?? null;
  return {
    workspaceId,
    surface,
    sessionId: selectedSessionId ?? undefined,
    runId: explicitSelectedRunId ?? selectedTurn?.trace.orchestration?.runId ?? selectedTurn?.trace.durable?.runId,
  };
}

function readThreadedPermissionState(value: unknown): ThreadedPermissionState {
  const record = readRecord(value);
  const profile = readRecord(record.permissionProfile);
  const override = readRecord(record.localOperatorOverride);
  return {
    loading: false,
    profileId: readString(record.permissionProfileId),
    profileLabel: readString(record.permissionProfileLabel) ?? readString(profile.label),
    approvalMode: readString(record.permissionProfileApprovalMode) ?? readString(profile.approvalMode),
    localOperatorOverrideId:
      readString(record.localOperatorOverrideId) ??
      readString(override.overrideId) ??
      readString(override.localOperatorOverrideId),
    overrideExpiresAt: readString(record.localOperatorOverrideExpiresAt) ?? readString(override.expiresAt),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
