import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CuratorSkillStatusItem } from "@goatcitadel/contracts";
import {
  archiveCuratorSkill,
  fetchCuratorStatus,
  listCuratorArchived,
  runCurator,
} from "@goatcitadel/mission-control-shared/api/platform";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { RiskBadge } from "../../ui/RiskBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { catalogHref } from "./capability-catalog-route";
import { useLibraryOperation } from "./use-library-operation";

type Sort = "usage" | "score" | "name";
type Outcome = { error: boolean; text: string };
const ARCHIVE_REASON = "manual archive from Mission Control";
const CARD = "grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-line p-3";

const humanize = (value: string) => value.replaceAll("_", " ");
const formatTime = (iso?: string) => {
  const date = iso ? new Date(iso) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : undefined;
};
const statusOf = (item: CuratorSkillStatusItem) =>
  item.immune ? `Immune: ${item.immunityReason ?? "protected"}` : item.archived ? "Archived" : humanize(item.state);

function sortSkills(items: CuratorSkillStatusItem[], sort: Sort) {
  return [...items].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "score"
        ? b.score.mean - a.score.mean
        : b.usageCount - a.usageCount,
  );
}

/** Proposal-only skill grading. Archive is the only mutation and always needs review. */
export function LibraryCurator({ workspaceId }: { workspaceId: string }) {
  const route = useCockpitRoute();
  const selectedId = new URLSearchParams(route.search).get("skillId") ?? "";
  const operation = useLibraryOperation(JSON.stringify(["curator", workspaceId]));
  const [sort, setSort] = useSessionViewState<Sort>(operation.key + ":sort", "usage");
  const [outcome, setOutcome] = useSessionViewState<Outcome | undefined>(operation.key + ":outcome", undefined);
  const [review, setReview] = useSessionViewState<CuratorSkillStatusItem | undefined>(
    operation.key + ":review",
    undefined,
  );
  const [pending, setPending] = useSessionViewState<CuratorSkillStatusItem | undefined>(
    operation.key + ":pending",
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const status = useQuery({
    queryKey: ["library", "curator", workspaceId, operation.identity],
    queryFn: () => fetchCuratorStatus(),
    staleTime: 0,
  });
  const archived = useQuery({
    queryKey: ["library", "curator-archived", workspaceId, operation.identity],
    queryFn: () => listCuratorArchived(),
    staleTime: 0,
  });
  const ranked = sortSkills(status.data?.items ?? [], sort);
  const selected = status.data?.items.find((item) => item.skillId === selectedId);
  const select = (skillId: string) => route.navigate(`/library/curator?skillId=${encodeURIComponent(skillId)}`);
  const refresh = async () => {
    await Promise.all([status.refetch(), archived.refetch()]);
  };

  async function generate() {
    if (busy || !operation.current()) return;
    setBusy(true);
    setOutcome(undefined);
    try {
      const result = await runCurator({ sync: true, dryRun: true });
      if (!operation.current()) return;
      setOutcome({
        error: false,
        text: result.report
          ? `Report ${result.runId}: ${result.report.proposalCount} archive proposals, ${result.report.immuneCount} immune. Nothing was archived.`
          : `Report ${result.runId} scheduled. Refresh to see its results. Nothing was archived.`,
      });
      await refresh();
    } catch (cause) {
      if (operation.current()) setOutcome({ error: true, text: describeApiError(cause).summary });
    } finally {
      if (operation.current()) setBusy(false);
    }
  }

  async function confirmArchive(replay = false) {
    const target = review;
    if (!target || busy || !operation.current()) return;
    if (replay ? pending?.skillId !== target.skillId || operation.attempt?.phase !== "uncertain" : operation.locked)
      return;
    setBusy(true);
    setOutcome(undefined);
    try {
      const receipt = await operation.run(
        `archive:${target.skillId}`,
        async () => undefined,
        async () => {
          if (!replay) setPending(target);
          return await archiveCuratorSkill({ skillId: target.skillId, confirm: true, reason: ARCHIVE_REASON });
        },
        (value) => {
          if (value.skillId !== target.skillId || !value.archived)
            throw new Error("The archive receipt does not confirm this skill was archived.");
        },
        replay,
      );
      if (!receipt || !operation.current()) return;
      setPending(undefined);
      setReview(undefined);
      setOutcome({
        error: false,
        text: receipt.alreadyArchived
          ? `${target.name} was already archived; nothing changed.`
          : `${target.name} archived. It is disabled until its state is changed in Skills and tools.`,
      });
      await refresh();
    } catch (cause) {
      if (operation.current()) setOutcome({ error: true, text: describeApiError(cause).summary });
    } finally {
      if (operation.current()) setBusy(false);
    }
  }

  function closeReview() {
    if (busy) return;
    const wasPending = pending && pending.skillId === review?.skillId;
    setReview(undefined);
    if (!wasPending) setOutcome({ error: false, text: "Cancelled. Nothing was archived." });
  }

  const canReplay = Boolean(review && pending?.skillId === review.skillId && operation.attempt?.phase === "uncertain");
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 overflow-y-auto p-4">
      <header className="grid min-w-0 gap-2">
        <h1 className="font-display text-xl font-semibold">Skill curator</h1>
        <p className="text-sm text-fg-secondary">
          Grades installed skills by usage and proposes archives. Reports never change a skill; archiving is a separate,
          reviewed action that disables a skill installation-wide.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || status.isFetching} onClick={() => void refresh()}>
            Refresh
          </Button>
          <Button disabled={busy || status.isError} onClick={() => void generate()}>
            Generate report
          </Button>
        </div>
        {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
        {operation.locked && pending ? (
          <div>
            <Button onClick={() => setReview(pending)}>Review pending archive</Button>
          </div>
        ) : null}
        {outcome && !review ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
        {status.isPending ? <p role="status">Reading curator status…</p> : null}
        {status.error ? <Callout tone="error">{describeApiError(status.error).summary}</Callout> : null}
      </header>
      {status.data ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
          <section className={CARD} aria-label="Curated skills">
            <h2 className="font-display text-md font-semibold">Skills, sorted by {sort}</h2>
            <p className="text-sm text-fg-secondary">
              {status.data.items.length} skills · {status.data.cycleDays}-day cycle · graded{" "}
              {formatTime(status.data.generatedAt)}
            </p>
            <Field label="Sort skills">
              {(props) => (
                <select
                  {...props}
                  className="w-full min-w-0 rounded-md border border-line bg-raised p-2"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as Sort)}
                >
                  <option value="usage">Usage</option>
                  <option value="score">Score</option>
                  <option value="name">Name</option>
                </select>
              )}
            </Field>
            {!ranked.length ? <p className="text-sm text-fg-muted">No skills are installed.</p> : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {ranked.map((item) => (
                <li key={item.skillId} data-curator-skill={item.skillId} className="min-w-0">
                  <button
                    type="button"
                    aria-current={item.skillId === selectedId ? "true" : undefined}
                    onClick={() => select(item.skillId)}
                    className="grid min-h-11 w-full min-w-0 gap-1 rounded-md border border-line p-2 text-left wrap-anywhere aria-[current=true]:border-accent"
                  >
                    <strong>{item.name}</strong>
                    <span className="text-sm text-fg-secondary">
                      {item.usageCount} uses · {humanize(item.recommendation)} · {statusOf(item)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <div className="grid min-w-0 grid-cols-1 content-start gap-4 lg:col-span-2">
            {selected ? (
              <section className={CARD} aria-label={`Skill ${selected.name}`}>
                <h2 className="font-display text-md font-semibold wrap-anywhere">{selected.name}</h2>
                <dl className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="font-medium">Status</dt>
                    <dd>{statusOf(selected)}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Recommendation</dt>
                    <dd>{humanize(selected.recommendation)}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Usage</dt>
                    <dd>
                      {selected.usageCount} uses · last used {formatTime(selected.lastUsedAt) ?? "never recorded"}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium">Score</dt>
                    <dd>
                      {selected.score.mean.toFixed(2)} · age {selected.ageDays} days
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium">Source</dt>
                    <dd>
                      {selected.source}
                      {selected.pinned ? " · pinned" : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium">Signals</dt>
                    <dd className="wrap-anywhere">{selected.signals.join(", ") || "None"}</dd>
                  </div>
                </dl>
                <TechnicalDetails label="Curator evidence record">
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-2 font-mono text-xs">
                    {JSON.stringify(selected, null, 2)}
                  </pre>
                </TechnicalDetails>
                {!selected.immune && !selected.archived ? (
                  <div>
                    <Button
                      variant="danger"
                      disabled={busy || operation.locked}
                      onClick={() => {
                        setOutcome(undefined);
                        setReview(selected);
                      }}
                    >
                      Review archive
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : selectedId ? (
              <Callout tone="warning">
                This skill is not in the current curator report. Refresh, or choose another skill.
              </Callout>
            ) : (
              <p className="rounded-lg border border-line p-3 text-sm text-fg-secondary">
                Select a skill to review its grade and evidence.
              </p>
            )}
            <section className={CARD} aria-label="Archived skills">
              <h2 className="font-display text-md font-semibold">Archived skills</h2>
              {archived.error ? <Callout tone="error">{describeApiError(archived.error).summary}</Callout> : null}
              {archived.data && !archived.data.items.length ? (
                <p className="text-sm text-fg-muted">No skills are archived by the curator.</p>
              ) : null}
              <ul className="grid min-w-0 grid-cols-1 gap-1 text-sm">
                {archived.data?.items.map((item) => (
                  <li key={item.skillId} className="wrap-anywhere">
                    {item.name} · {item.source}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      ) : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) closeReview();
        }}
        title="Review skill archive"
        description="Archiving is the only curator action that changes a skill."
      >
        {review ? (
          <div className="grid min-w-0 grid-cols-1 gap-3 text-sm wrap-anywhere">
            <p>
              <strong>Skill:</strong> {review.name} · {review.source} · {review.usageCount} uses · recommendation{" "}
              {humanize(review.recommendation)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <RiskBadge risk="caution" />
              <span>Disables this skill installation-wide, in every workspace.</span>
            </div>
            <p>
              The Gateway records the disable through its governed skill-state path and Journey. Curator has no restore:
              re-enabling is a governed state change in Skills and tools, which may need approval.
            </p>
            <NativeOwnerLink
              scope={workspaceId}
              href={catalogHref({ search: review.name, kind: "skill", status: "all", trust: "all" } as never)}
            >
              Open this skill in Skills and tools
            </NativeOwnerLink>
            {outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy} onClick={closeReview}>
                {canReplay ? "Close" : "Cancel"}
              </Button>
              {canReplay ? (
                <Button disabled={busy} onClick={() => void confirmArchive(true)}>
                  Replay exact archive request
                </Button>
              ) : (
                <Button variant="danger" disabled={busy || operation.locked} onClick={() => void confirmArchive()}>
                  Archive skill
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
