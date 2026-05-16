import { useEffect, useState } from "react";
import { Archive, Play, RefreshCw, ShieldCheck } from "lucide-react";
import type { CuratorSkillStatusItem, CuratorStatusResponse } from "@goatcitadel/contracts";
import { archiveCuratorSkill, fetchCuratorStatus, runCurator } from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import "../native-routes.css";

export function CuratorRoutePage({ route: _route, navigate: _navigate, activeWorkspaceId }: NativeRoutePagesProps) {
  const [data, setData] = useState<CuratorStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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

  async function handleArchive(item: CuratorSkillStatusItem) {
    if (item.immune) return;
    setActionBusy(true);
    setNotice(null);
    try {
      await archiveCuratorSkill({ skillId: item.skillId, reason: "manual archive from Mission Control" });
      setNotice(`Archived ${item.name}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRun(dryRun: boolean) {
    setActionBusy(true);
    setNotice(null);
    try {
      const result = await runCurator({ sync: true, dryRun });
      setNotice(
        `${dryRun ? "Dry run" : "Run"} complete: ${result.report?.archivedCount ?? 0} archived, ${result.report?.immuneCount ?? 0} immune`,
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  const subtitle = data ? `${data.cycleDays}-day cycle · ${data.items.length} skills` : "Autonomous skill grader";

  return (
    <NativePageFrame
      icon={ShieldCheck}
      kicker="Library"
      title="Autonomous Curator"
      description="Ranked skill status, immunity flags, and recommendations from the background curator cycle."
      loading={false}
      error={null}
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
              <button
                type="button"
                className="gc-button subtle"
                onClick={() => void handleRun(true)}
                disabled={loading || actionBusy}
              >
                <Play className="h-4 w-4" />
                Dry run
              </button>
              <button
                type="button"
                className="gc-button"
                onClick={() => void handleRun(false)}
                disabled={loading || actionBusy}
              >
                <ShieldCheck className="h-4 w-4" />
                Run now
              </button>
            </div>
          }
        >
          {error ? (
            <div className="mc-next-runtime-notice tone-warning" data-testid="curator-error">
              <span>{error}</span>
            </div>
          ) : null}
          {notice ? (
            <div className="mc-next-runtime-notice tone-success" data-testid="curator-notice">
              <span>{notice}</span>
            </div>
          ) : null}
          {!error && !notice ? (
            <p className="mc-next-directory-empty">
              {loading ? "Loading curator status…" : "Use the actions above to refresh or trigger a curator run."}
            </p>
          ) : null}
        </NativeCard>
      </NativeGrid>

      <NativeGrid>
        <NativeCard
          title="Skills (ranked by usage)"
          subtitle={data ? `${data.items.length} skills · generated ${data.generatedAt}` : "Loading…"}
        >
          {loading && !data ? (
            <p className="mc-next-directory-empty">Loading curator status…</p>
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
                        onClick={() => void handleArchive(item)}
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
            <p className="mc-next-directory-empty">No skills found.</p>
          )}
        </NativeCard>
      </NativeGrid>
    </NativePageFrame>
  );
}
