import { useEffect } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CapabilitySkillInstall } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { skillInstallQuery, skillInstallsQuery } from "../../../data/capability-skills-query";
import { Button } from "../../../ui/Button";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { SkillGitImport } from "./SkillGitImport";
import { SkillInstallAbout } from "./SkillInstallAbout";
import { SkillInstallProgress } from "./SkillInstallProgress";
import { isDraftInstallKey, useSkillInstallEntry } from "./skill-install-store";
import { installOf, takeSkillInstallMove, useSkillInstall } from "./use-skill-install";

/** Installs whose panel already handed over to the installed skill's panel, so it happens once. */
const handedOver = new Set<string>();

export interface SkillInstallPanelProps {
  /** A check's id, or the panel's own key while its check hasn't answered (from Discover, or a Git address). */
  installKey: string;
  /** Shows the Git address field: "Import from Git". */
  gitImport?: boolean;
  /** Moves to the check this panel made. `replace` when the panel showed an earlier check of its own. */
  onMove: (snapshotId: string, replace: boolean) => void;
  /** Hands over to the installed skill's panel once switching it on is done. */
  onDone: (skillId: string, name: string) => void;
}

/** A check named by the address that nothing here follows yet: read from the Gateway, or why it can't be. */
function ReadingInstall({ query }: { query: UseQueryResult<CapabilitySkillInstall | null> }) {
  if (query.isError)
    return (
      <div className="space-y-2 text-sm">
        <p className="text-fg">This install couldn&apos;t be read. {describeApiError(query.error).summary}</p>
        <Button size="sm" loading={query.isFetching} loadingLabel="Trying…" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (query.data === null) return <p className="text-sm text-fg">This install can&apos;t be found anymore.</p>;
  return <p className="text-sm text-fg-muted">Reading the install…</p>;
}

/**
 * The install panel, in the inspector: it checks a source and shows what the skill does, where it comes from, what
 * it asks for and what GoatCitadel's checks found, then installs it and switches it on from one confirmation, with
 * each step's approval in place when the operator's skip setting is off. The flow lives in a store keyed by the check,
 * so closing the panel loses nothing; after a reload, the Gateway's read of the check is the truth. Every step, blocker
 * and refusal is the Gateway's; the panel only words them.
 */
export function SkillInstallPanel({ installKey, gitImport = false, onMove, onDone }: SkillInstallPanelProps) {
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const checkKey = !isDraftInstallKey(installKey);
  const entry = useSkillInstallEntry(installKey);
  // Read only for a check nothing here follows yet, such as one an address names after a reload.
  const seed = useQuery({ ...skillInstallQuery(workspaceId, installKey), enabled: checkKey && !entry });
  const flow = useSkillInstall(installKey, seed.data);
  // Whether the operator's skip applies, for "What happens next"; unknown when it can't be read.
  const skip = useQuery(skillInstallsQuery(workspaceId)).data?.operatorApprovalSkip;
  const { state } = flow;
  const install = installOf(state);
  const name = install?.name ?? "this skill";

  useEffect(() => {
    if (!flow.movedTo) return;
    const target = takeSkillInstallMove(installKey);
    if (target) onMove(target, checkKey);
  }, [flow.movedTo, installKey, checkKey, onMove]);

  const doneSkillId = state.phase === "done" ? state.skillId : "";
  useEffect(() => {
    if (!doneSkillId || handedOver.has(installKey)) return;
    handedOver.add(installKey);
    onDone(doneSkillId, name);
  }, [doneSkillId, installKey, name, onDone]);

  if (gitImport && !install) {
    return (
      <SkillGitImport
        checking={state.phase === "checking"}
        error={state.phase === "check_failed" ? state.message : undefined}
        onCheck={flow.check}
      />
    );
  }
  if (state.phase === "idle") return <ReadingInstall query={seed} />;
  const checkAgain = flow.source ? () => flow.source && flow.check(flow.source) : undefined;
  return (
    <div className="space-y-4">
      {install ? <SkillInstallAbout install={install} skip={skip} /> : null}
      <SkillInstallProgress flow={flow} name={name} workspaceId={workspaceId} onCheckAgain={checkAgain} />
      {install ? (
        <TechnicalDetails>
          <p className="font-mono">{install.snapshotId}</p>
        </TechnicalDetails>
      ) : null}
    </div>
  );
}

export function __resetSkillInstallPanelsForTests() {
  handedOver.clear();
}
