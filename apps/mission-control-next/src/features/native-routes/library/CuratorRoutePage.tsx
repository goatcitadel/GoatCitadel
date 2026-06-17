import { useEffect, useState } from "react";
import { Archive, RefreshCw, ShieldCheck } from "lucide-react";
import type { CuratorSkillStatusItem, CuratorStatusResponse } from "@goatcitadel/contracts";
import { archiveCuratorSkill, fetchCuratorStatus, runCurator } from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { getRouteReleaseScope, routeKicker } from "@next/app/route-model";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import "../native-routes.css";

export function CuratorRoutePage({ route, navigate: _navigate, activeWorkspaceId }: NativeRoutePagesProps) {
  const [data, setData] = useState<CuratorStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingArchive, setPendingArchive] = useState<CuratorSkillStatusItem | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCuratorStatus();
      setData(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void fetchCuratorStatus()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  function handleArchive(item: CuratorSkillStatusItem) {
    if (item.immune) return;
    setPendingArchive(item);
  }

  async function confirmArchive() {
    if (!pendingArchive || pendingArchive.immune) return;
    setActionBusy(true);
    setNotice(null);
    try {
      await archiveCuratorSkill({
        skillId: pendingArchive.skillId,
        reason: "manual archive from Mission Control",
        confirm: true,
      });
      setNotice(`Archived ${pendingArchive.name}`);
      setPendingArchive(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRun() {
    setActionBusy(true);
    setNotice(null);
    try {
      const result = await runCurator({ sync: true, dryRun: true });
      setNotice(
        `Report complete: ${result.report?.proposalCount ?? 0} archive proposals, ${result.report?.immuneCount ?? 0} immune`,
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  const subtitle = data ? `${data.cycleDays}-day cycle · ${data.items.length} skills` : "Proposal-only skill grader";

  return (
    <NativePageFrame
      icon={ShieldCheck}
      kicker={routeKicker(route)}
      title="Skill Curator"
      description="Ranked skill status, immunity flags, and archive proposals from the background curator report cycle."
      loading={loading}
      error={error}
      releaseStatus={getRouteReleaseScope(route).status}
    >
      <NativeGrid>
        <NativeCard
          title="Actions"
          subtitle={subtitle}
          actions={
            <div className="mc-next-runtime-actions">
              <button
                type="button"
                className="gc-button subtle"
                onClick={() => void load()}
                disabled={loading || actionBusy}
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
              <button type="button" className="gc-button subtle" onClick={handleRun} disabled={loading || actionBusy}>
                <ShieldCheck className="h-4 w-4" />
                Generate report
              </button>
            </div>
          }
        >
          {notice ? (
            <div className="mc-next-runtime-notice tone-success" data-testid="curator-notice">
              <span>{notice}</span>
            </div>
          ) : null}
          {!notice ? (
            <EmptyState
              size="compact"
              title={
                loading ? "Loading curator status…" : "Use the actions above to refresh or generate a curator report."
              }
            />
          ) : null}
        </NativeCard>
      </NativeGrid>

      <NativeGrid>
        <NativeCard
          title="Skills (ranked by usage)"
          subtitle={data ? `${data.items.length} skills · generated ${data.generatedAt}` : "Loading…"}
        >
          {loading && !data ? (
            <EmptyState size="compact" title="Loading curator status…" />
          ) : data && data.items.length > 0 ? (
            <div className="mc-next-approvals-list">
              {data.items.map((item) => (
                <div key={item.skillId} className="mc-next-directory-list-item" data-testid="curator-row">
                  <div className="mc-next-directory-list-head">
                    <strong>{item.name}</strong>
                    <span>{item.source}</span>
                  </div>
                  <div className="mc-next-approvals-chip-row">
                    <span>Usage: {item.usageCount}</span>
                    <span>Score: {item.score.mean.toFixed(2)}</span>
                    <span>Rec: {item.recommendation}</span>
                    {item.immune ? (
                      <span data-testid="curator-immune-badge">Immune: {item.immunityReason}</span>
                    ) : item.archived ? (
                      <span>Archived</span>
                    ) : (
                      <span>{item.state}</span>
                    )}
                  </div>
                  {!item.immune && !item.archived ? (
                    <div className="mc-next-runtime-actions">
                      <button
                        type="button"
                        className="gc-button subtle"
                        onClick={() => handleArchive(item)}
                        disabled={actionBusy}
                        aria-label={`Archive ${item.name}`}
                      >
                        <Archive className="h-4 w-4" />
                        Archive
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState size="compact" title="No skills found." />
          )}
        </NativeCard>
      </NativeGrid>
      <ConfirmModal
        open={pendingArchive !== null}
        title="Archive skill?"
        message={
          pendingArchive
            ? `Archive ${pendingArchive.name}? This disables the skill until you restore or re-enable it.`
            : ""
        }
        confirmLabel="Archive"
        danger
        pending={actionBusy}
        disableDismiss={actionBusy}
        onCancel={() => {
          if (!actionBusy) {
            setPendingArchive(null);
          }
        }}
        onConfirm={confirmArchive}
      />
    </NativePageFrame>
  );
}
