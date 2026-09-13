import { useEffect, useState } from "react";
import { Archive, RefreshCw, ShieldCheck } from "lucide-react";
import type { CuratorSkillStatusItem, CuratorStatusResponse } from "@goatcitadel/contracts";
import { archiveCuratorSkill, fetchCuratorStatus, runCurator } from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { DetailInspector } from "../../../components/DetailInspector";
import { getRouteReleaseScope, routeKicker } from "@next/app/route-model";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { formatDateTime, humanizeEnumToken } from "../shared/native-helpers";
import type { NativeRoutePagesProps } from "../types";
import "../native-routes.css";

export function CuratorRoutePage({ route, navigate: _navigate, activeWorkspaceId }: NativeRoutePagesProps) {
  const [data, setData] = useState<CuratorStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState("usage");
  const selected = data?.items.find((item) => item.skillId === selectedId);
  const ranked = [...(data?.items ?? [])].sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "score" ? b.score.mean - a.score.mean : b.usageCount - a.usageCount);
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
    void load();
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
        `Report complete: ${result.report?.proposalCount ?? "Unavailable"} archive proposals, ${result.report?.immuneCount ?? "Unavailable"} immune`,
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
      loading={loading && !data}
      error={error}
      onRetry={() => void load()}
      releaseStatus={getRouteReleaseScope(route).status}
    >
      <NativeGrid className="mc-next-calm-directory">
        <NativeCard
          title="Actions"
          subtitle={subtitle}
          actions={
            <div className="mc-next-runtime-actions">
              <NativeButton
                variant="outline"
                className="subtle"
                onClick={() => void load()}
                disabled={loading || actionBusy}
              >
                <RefreshCw size={16} />
                Refresh
              </NativeButton>
              <NativeButton variant="outline" className="subtle" onClick={handleRun} disabled={loading || actionBusy}>
                <ShieldCheck size={16} />
                Generate report
              </NativeButton>
            </div>
          }
        >
          {notice ? (
            <div data-testid="curator-notice">
              <NoticeBanner tone="success" message={notice} />
            </div>
          ) : null}
        </NativeCard>
      </NativeGrid>

      <NativeGrid className="mc-next-calm-directory">
        <NativeCard
          title="Skills (ranked by usage)"
          subtitle={data ? `${data.items.length} skills · generated ${formatDateTime(data.generatedAt)}` : "Loading…"}
        >
          <label className="mc-next-mason-field"><span>Sort skills</span><select className="mc-next-settings-input" value={sort} onChange={(event) => setSort(event.target.value)}><option value="usage">Usage</option><option value="score">Score</option><option value="name">Name</option></select></label>
          {data && data.items.length > 0 ? (
            <div className="mc-next-approvals-list">
              {ranked.map((item) => (
                <div key={item.skillId} className="mc-next-directory-list-item" data-testid="curator-row">
                  <div className="mc-next-directory-list-head">
                    <NativeButton variant="ghost" onClick={() => setSelectedId(item.skillId)}>{item.name}</NativeButton>
                    <span>{item.source}</span>
                  </div>
                  <p>{item.usageCount} uses · {humanizeEnumToken(item.recommendation)} · {item.immune ? <span data-testid="curator-immune-badge">Immune: {item.immunityReason}</span> : item.archived ? "Archived" : humanizeEnumToken(item.state)}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              size="compact"
              title="No skills found."
              primaryAction={
                <NativeButton variant="outline" className="subtle" onClick={handleRun} disabled={loading || actionBusy}>
                  <ShieldCheck size={16} />
                  Generate report
                </NativeButton>
              }
            />
          )}
        </NativeCard>
      </NativeGrid>
      <DetailInspector open={Boolean(selected)} title={selected?.name ?? "Skill review"} onClose={() => setSelectedId(null)}>
        {selected ? <>
          <dl className="mc-next-native-facts"><div><dt>Source</dt><dd>{selected.source}</dd></div><div><dt>Usage</dt><dd>{selected.usageCount}</dd></div><div><dt>Score</dt><dd>{selected.score.mean.toFixed(2)}</dd></div><div><dt>Recommendation</dt><dd>{humanizeEnumToken(selected.recommendation)}</dd></div><div><dt>Status</dt><dd>{selected.immune ? `Immune: ${selected.immunityReason}` : selected.archived ? "Archived" : humanizeEnumToken(selected.state)}</dd></div></dl>
          <details className="mc-next-inline-disclosure"><summary>Usage and review evidence</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details>
          {!selected.immune && !selected.archived ? <NativeButton variant="destructive" onClick={() => handleArchive(selected)} disabled={actionBusy}><Archive size={16} /> Archive</NativeButton> : null}
        </> : null}
      </DetailInspector>
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
