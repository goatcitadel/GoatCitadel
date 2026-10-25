import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SHIPPED_SKILL_PACKS, type ShippedSkillPack } from "@goatcitadel/contracts";
import {
  createSkillHubOperatorApproval,
  fetchSkillHubOperator,
  reviewSkillHubPack,
  type SkillHubOperatorAction,
  type SkillHubOperatorItem,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";

/** The newest Skill Hub snapshot reviewed from this pack's shipped directory, if any. */
export function findSkillPackItem(pack: ShippedSkillPack, items: readonly SkillHubOperatorItem[]) {
  return items
    .filter(
      (item) =>
        item.snapshot.sourceType === "local_path" &&
        item.snapshot.sourceRef.replaceAll("\\", "/").endsWith(`/import-packs/${pack.packId}`),
    )
    .sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt))[0];
}

type PackStep =
  | { kind: "review" }
  | { kind: "blocked"; codes: string[] }
  | { kind: "waiting"; approvalId: string }
  | { kind: "action"; action: SkillHubOperatorAction; label: string }
  | { kind: "active" }
  | { kind: "stalled"; reason: string };

/** What the operator can do next for a pack, derived only from the Gateway's Skill Hub projection. */
export function nextSkillPackStep(item: SkillHubOperatorItem | undefined): PackStep {
  if (!item) return { kind: "review" };
  if (item.snapshot.trustDisposition === "blocked" || item.snapshot.blockerCodes.length)
    return { kind: "blocked", codes: item.snapshot.blockerCodes };
  if (item.runtime.callable && item.runtime.activeVersion) return { kind: "active" };
  if (item.latestApproval?.status === "pending") return { kind: "waiting", approvalId: item.latestApproval.approvalId };
  if (item.actions.activate?.allowed) return { kind: "action", action: "activate", label: "Request activation" };
  if (item.actions.install_inactive?.allowed)
    return { kind: "action", action: "install_inactive", label: "Install inactive" };
  const blockers = [...(item.actions.activate?.blockers ?? []), ...(item.actions.install_inactive?.blockers ?? [])];
  return { kind: "stalled", reason: blockers[0] ?? "No lifecycle action is available for this review." };
}

function stepStatus(step: PackStep): string {
  switch (step.kind) {
    case "review":
      return "Not reviewed";
    case "blocked":
      return `Blocked by review: ${step.codes.join(", ") || "blocked"}`;
    case "waiting":
      return "Waiting for your approval in Inbox";
    case "action":
      return step.action === "activate" ? "Installed, not active" : "Reviewed, not installed";
    case "active":
      return "Active";
    case "stalled":
      return step.reason;
  }
}

export function LibrarySkillPacks({ workspaceId }: { workspaceId: string }) {
  const hub = useQuery({
    queryKey: ["library", "skill-packs", workspaceId],
    queryFn: () => fetchSkillHubOperator({ workspaceId, limit: 100 }),
    retry: false,
  });
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string }>();
  const items = hub.data?.items ?? [];

  async function run(pack: ShippedSkillPack, step: PackStep, item: SkillHubOperatorItem | undefined) {
    setBusy(pack.packId);
    setNotice(undefined);
    try {
      if (step.kind === "review") {
        const result = await reviewSkillHubPack({
          workspaceId,
          packId: pack.packId,
          idempotencyKey: crypto.randomUUID(),
        });
        setNotice({
          tone: "info",
          text: result.snapshot.blockerCodes.length
            ? `${pack.label} review found blockers: ${result.snapshot.blockerCodes.join(", ")}.`
            : `${pack.label} reviewed. Install it inactive next; nothing is callable yet.`,
        });
      } else if (step.kind === "action" && item) {
        const result = await createSkillHubOperatorApproval({
          workspaceId,
          snapshotId: item.snapshotId,
          operationKind: step.action,
        });
        setNotice({ tone: "info", text: result.operatorMessage });
      }
      await hub.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: `${pack.label}: ${describeApiError(error).summary}` });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section aria-labelledby="library-skill-packs" className="space-y-3">
      <header>
        <h3 id="library-skill-packs" className="text-md font-semibold text-fg">
          Integration skill packs
        </h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Skills adapted from OpenClaw that drive a command-line tool you install and sign in to yourself. Each goes
          through Skill Hub review, an approval to install it inactive, and an approval to activate it. Every command it
          runs still needs shell approval.
        </p>
      </header>
      {notice ? <Callout tone={notice.tone === "error" ? "error" : "info"}>{notice.text}</Callout> : null}
      {hub.isError ? <p role="alert">Skill Hub unavailable: {describeApiError(hub.error).summary}</p> : null}
      {hub.isPending ? <p role="status">Reading Skill Hub…</p> : null}
      <ul className="divide-y divide-line-subtle">
        {SHIPPED_SKILL_PACKS.map((pack) => {
          const item = hub.isSuccess ? findSkillPackItem(pack, items) : undefined;
          const step = nextSkillPackStep(item);
          const actionable = hub.isSuccess && (step.kind === "review" || step.kind === "action");
          return (
            <li key={pack.packId} className="space-y-2 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold text-fg">{pack.label}</p>
                {hub.isSuccess ? <p className="text-xs text-fg-muted">{stepStatus(step)}</p> : null}
              </div>
              <p className="text-fg-secondary">{pack.summary}</p>
              <p className="text-xs text-fg-muted">
                Needs the{" "}
                <a href={pack.setupUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                  {pack.requiresCli}
                </a>{" "}
                CLI on the Gateway host · From {pack.upstream} ({pack.license})
              </p>
              {step.kind === "waiting" ? (
                <a href="/inbox" className="text-sm text-accent underline">
                  Open Inbox to review the approval
                </a>
              ) : null}
              {actionable ? (
                <Button size="sm" disabled={Boolean(busy)} onClick={() => void run(pack, step, item)}>
                  {busy === pack.packId
                    ? "Working…"
                    : step.kind === "review"
                      ? `Review ${pack.label}`
                      : `${step.label}: ${pack.label}`}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
