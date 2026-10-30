import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CapabilitySkillDiscoverItem, CapabilitySkillSource } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useInspector } from "../../../app/inspector";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { skillInstallQuery, skillListQuery } from "../../../data/capability-skills-query";
import { reopenSettingsApproval } from "../../settings/SettingsApprovalDialog";
import { SkillInstallPanel } from "./SkillInstallPanel";
import {
  installIdFromSearch,
  installItemHref,
  installKeyFromSource,
  skillInstallSource,
  skillItemHref,
  skillsHref,
  skillsViewFromSearch,
} from "./skill-links";
import { draftInstallKey, readSkillInstall, useSkillInstallEntry } from "./skill-install-store";
import { installOf, resetSkillInstall, startSkillInstallCheck } from "./use-skill-install";

const GIT_IMPORT_KEY = draftInstallKey("git");
const GIT_IMPORT_TITLE = "Import from Git";
/** The panel's title while the check an address names is read, and when it can't be. */
const UNNAMED_TITLE = "Install a skill";

/** The panel key of a check started from Discover, before it answers. */
function sourceDraftKey(source: CapabilitySkillSource): string {
  return draftInstallKey(source.kind === "pack" ? `pack:${source.packId}` : `git:${source.sourceRef}`);
}

export interface SkillInstallPanelOpener {
  /** Checks a Discover row's source and opens its install panel. */
  install(item: CapabilitySkillDiscoverItem): void;
  /** Opens the install a Discover row has on its way in (the check the Gateway names), at the step it reached. */
  resume(item: CapabilitySkillDiscoverItem): void;
  /** Opens the install panel with the Git address field. */
  importFromGit(): void;
}

/**
 * Connects the install panel to the inspector and the address, the way `useSkillPanel` does for a skill's panel. A check
 * that has answered is named by the address (`?item=install:<check id>`, with the view kept), so a reload opens it
 * again; a check that hasn't answered yet has no address, and its panel moves to the check's own address once it does.
 * Closing the panel clears the address. When switching on is done, the installed skill's panel takes over, through
 * `openSkill` (the skill panel's opener) when the installed list doesn't hold the skill yet.
 *
 * The inspector closes whenever the address changes, so a panel always opens after the move, never before it. A panel
 * of another kind (a skill's) can be open while the address still names an install; the address is then left alone.
 */
export function useSkillInstallPanel(openSkill: (skillId: string, name: string) => void): SkillInstallPanelOpener {
  const { open: openInspector, content } = useInspector();
  const { search, navigate } = useCockpitRoute();
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const view = skillsViewFromSearch(search);
  const linkedId = installIdFromSearch(search);
  const openKey = installKeyFromSource(content?.source);
  const linkedEntry = useSkillInstallEntry(linkedId);
  const linkedRead = useQuery({ ...skillInstallQuery(workspaceId, linkedId ?? ""), enabled: Boolean(linkedId) });
  const linkedName = installOf(linkedEntry?.state)?.name ?? linkedRead.data?.name;
  const title = linkedName ?? (linkedRead.isError || linkedRead.data === null ? UNNAMED_TITLE : undefined);
  // The panel this page last asked the inspector for (and with which inspector), and the one that has been on screen.
  const asked = useRef<{ key: string; inspectorOpen: typeof openInspector } | null>(null);
  const shown = useRef<string | null>(null);

  const move = useCallback(
    (snapshotId: string, replace: boolean) =>
      navigate(installItemHref(snapshotId, view), replace ? { replace } : undefined),
    [navigate, view],
  );

  const done = useCallback(
    (skillId: string, name: string) => {
      const listKey = skillListQuery(workspaceId).queryKey;
      void client.refetchQueries({ queryKey: listKey, exact: true }, { cancelRefetch: false }).then(() => {
        const listed = client.getQueryData(listKey)?.items.some((item) => item.skillId === skillId);
        // The install's address gives way to the skill's, so going back doesn't land on a finished install.
        if (listed) navigate(skillItemHref(skillId, view), { replace: true });
        else openSkill(skillId, name);
      });
    },
    [client, workspaceId, navigate, view, openSkill],
  );

  const show = useCallback(
    (key: string, panelTitle: string, gitImport = false) => {
      asked.current = { key, inspectorOpen: openInspector };
      openInspector({
        source: skillInstallSource(key),
        title: panelTitle,
        body: <SkillInstallPanel installKey={key} gitImport={gitImport} onMove={move} onDone={done} />,
      });
    },
    [openInspector, move, done],
  );

  useEffect(() => {
    if (openKey) {
      shown.current = openKey;
      return;
    }
    // Another panel is open (a skill's, after an install handed over to it): the address is its business.
    if (content) return;
    if (!linkedId) {
      asked.current = null;
      shown.current = null;
      return;
    }
    if (shown.current === linkedId) {
      // The install panel the address asked for was on screen and is gone: it was closed.
      shown.current = null;
      navigate(skillsHref(view), { replace: true });
      return;
    }
    const alreadyAsked = asked.current?.key === linkedId && asked.current.inspectorOpen === openInspector;
    if (title && !alreadyAsked) show(linkedId, title);
  }, [openKey, content, linkedId, title, show, openInspector, navigate, view]);

  const install = (item: CapabilitySkillDiscoverItem) => {
    if (!item.install) return;
    const key = sourceDraftKey(item.install);
    // A second press while the first check runs shows that check rather than making another.
    if (readSkillInstall(key)?.state.phase !== "checking") {
      resetSkillInstall(key);
      startSkillInstallCheck(key, item.install, { client, workspaceId });
    }
    show(key, item.name);
  };

  return {
    install,
    resume: (item) => {
      const checkId = item.installSnapshotId;
      // Every row on its way in names its check; one that doesn't (an older Gateway) is checked afresh instead.
      if (!checkId) return install(item);
      // A waiting step this page already follows opens its approval at once, as a skill row's Review button does.
      const followed = installOf(readSkillInstall(checkId)?.state);
      if (followed?.approvalId) reopenSettingsApproval(followed.approvalId);
      navigate(installItemHref(checkId, view));
    },
    importFromGit: () => {
      resetSkillInstall(GIT_IMPORT_KEY);
      show(GIT_IMPORT_KEY, GIT_IMPORT_TITLE, true);
    },
  };
}
