import { useEffect, useMemo, useState } from "react";
import type { ChatMode } from "@goatcitadel/contracts";
import { fetchEffectivePermissionProfile } from "@goatcitadel/mission-control-shared/api/client";
import {
  MissionThreadedControllerHost,
  type MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { ThreadedSurfacePage, type ThreadedPermissionState } from "./ThreadedSurfacePage";

export function ThreadedSurfaceRoute({
  surface,
  workspaceId,
  workspaceName,
  approvalsCount,
  lockSurface,
  onOpenCowork,
  onOpenCode,
  onOpenTasks,
  onOpenApprovals,
  onNavigateSurface,
}: {
  surface: ChatMode;
  workspaceId: string;
  workspaceName: string;
  approvalsCount: number;
  lockSurface?: boolean;
  onOpenCowork?: () => void;
  onOpenCode?: () => void;
  onOpenTasks?: () => void;
  onOpenApprovals?: (approvalId?: string) => void;
  onNavigateSurface?: (
    surface: ChatMode,
    options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
  ) => void;
}) {
  return (
    <MissionThreadedControllerHost
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      approvalsCount={approvalsCount}
      surface={surface}
      lockSurface={lockSurface}
      onOpenCowork={onOpenCowork}
      onOpenCode={onOpenCode}
      onOpenTasks={onOpenTasks}
      onOpenApprovals={onOpenApprovals}
      onNavigateSurface={onNavigateSurface}
      renderSurface={(input: MissionThreadedRenderSurfaceInput) => (
        <ThreadedSurfacePermissionBridge surface={surface} workspaceId={workspaceId} input={input} />
      )}
    />
  );
}

function ThreadedSurfacePermissionBridge({
  surface,
  workspaceId,
  input,
}: {
  surface: ChatMode;
  workspaceId: string;
  input: MissionThreadedRenderSurfaceInput;
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

  return <ThreadedSurfacePage surface={surface} input={input} permissionState={permissionState} />;
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
