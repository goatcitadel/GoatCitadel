import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CapabilityPluginListItem, CapabilityPluginListResponse } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useInspector } from "../../../app/inspector";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { pluginInspectionQuery } from "../../../data/capability-plugins-query";
import { reopenSettingsApproval } from "../../settings/SettingsApprovalDialog";
import { PluginInstallPanel } from "./PluginInstallPanel";
import {
  PLUGINS_HREF,
  pluginIdFromSearch,
  pluginInspectionIdFromSearch,
  pluginInstallItemHref,
  pluginInstallKeyFromSource,
  pluginInstallSource,
  pluginItemHref,
  pluginSourceFromSearch,
  pluginSourceItemHref,
  type PluginSourceFormKind,
} from "./plugin-links";
import {
  draftPluginInstallKey,
  isDraftPluginInstallKey,
  pluginIdOfInstallKey,
  pluginInstallKey,
  readPluginInstall,
  usePluginInstallEntry,
} from "./plugin-install-store";
import { resetPluginInstall, shownOf, startPluginInspection } from "./use-plugin-install";

const FORM_TITLES: Readonly<Record<PluginSourceFormKind, string>> = {
  git: "Install from Git",
  folder: "Add from folder",
};
/** The panel's title while the check an address names is read, and when it can't be. */
const UNNAMED_TITLE = "Install a plugin";

/** The install panel an address names, and what it opens with. */
interface PanelTarget {
  key: string;
  /** Undefined while the name is still being read. */
  title?: string;
  form?: PluginSourceFormKind;
  pluginWorkspaceId?: string;
}

/**
 * Which install panel the address names: a source form (`?item=plugin-source:<kind>`), a check
 * (`?item=plugin-install:<id>`), or a plugin whose install isn't finished (`?item=plugin:<id>`, when this app session
 * follows it or the list says so). Any other plugin's address belongs to the plugin's own panel.
 */
function usePanelTarget(search: string, list: CapabilityPluginListResponse | undefined): PanelTarget | undefined {
  const form = pluginSourceFromSearch(search);
  const inspectionId = pluginInspectionIdFromSearch(search);
  const pluginId = pluginIdFromSearch(search);
  const inspectionEntry = usePluginInstallEntry(inspectionId);
  const pluginEntry = usePluginInstallEntry(pluginId ? pluginInstallKey(pluginId) : undefined);
  const inspectionRead = useQuery({
    ...pluginInspectionQuery(inspectionId ?? ""),
    enabled: inspectionId !== undefined && !inspectionEntry,
  });
  if (form) return { key: draftPluginInstallKey(form), title: FORM_TITLES[form], form };
  if (inspectionId) {
    const name = shownOf(inspectionEntry?.state)?.name || inspectionRead.data?.name;
    const known = inspectionEntry !== undefined || inspectionRead.data !== undefined || inspectionRead.isError;
    return { key: inspectionId, ...(name || known ? { title: name || UNNAMED_TITLE } : {}) };
  }
  if (!pluginId) return undefined;
  const row = list?.installed.find((item) => item.pluginId === pluginId);
  if (!pluginEntry && row?.state !== "install_not_finished") return undefined;
  return {
    key: pluginInstallKey(pluginId),
    title: shownOf(pluginEntry?.state)?.name || row?.name || UNNAMED_TITLE,
    ...(row ? { pluginWorkspaceId: row.workspaceId } : {}),
  };
}

export interface PluginInstallPanelOpener {
  /** A built-in plugin's Install: checks it and opens its install panel. */
  install(item: CapabilityPluginListItem): void;
  /** An unfinished install's Continue: opens its panel at the plugin's address, at the piece it reached. */
  resume(item: CapabilityPluginListItem): void;
  /** "Install from Git" or "Add from folder": opens that form, empty. */
  openSource(kind: PluginSourceFormKind): void;
}

/** Opens the install panel in the inspector, and moves the address with the panel as its flow moves. */
function usePanelShow() {
  const { open: openInspector, content } = useInspector();
  const { navigate } = useCockpitRoute();
  // The panel this page last asked the inspector for, and with which inspector.
  const asked = useRef<{ key: string; inspectorOpen: typeof openInspector } | null>(null);

  const move = useCallback(
    (from: string, to: string) => {
      const pluginId = pluginIdOfInstallKey(to);
      // A check's own address replaces the one it moves from, so going back doesn't land on a finished step.
      const replace = !isDraftPluginInstallKey(from);
      navigate(pluginId ? pluginItemHref(pluginId) : pluginInstallItemHref(to), replace ? { replace } : undefined);
    },
    [navigate],
  );

  const show = useCallback(
    (key: string, title: string, panel: Omit<PanelTarget, "key" | "title"> = {}) => {
      asked.current = { key, inspectorOpen: openInspector };
      openInspector({
        source: pluginInstallSource(key),
        title,
        body: <PluginInstallPanel installKey={key} {...panel} onMove={(to) => move(key, to)} />,
      });
    },
    [openInspector, move],
  );
  return { show, asked, openInspector, content };
}

/** Opens the panel the address names, once per inspector, and clears the address when that panel is closed. */
function useAddressPanel(target: PanelTarget | undefined, panels: ReturnType<typeof usePanelShow>) {
  const { navigate } = useCockpitRoute();
  const { show, asked, openInspector, content } = panels;
  const openKey = pluginInstallKeyFromSource(content?.source);
  // The install panel that has been on screen.
  const shown = useRef<string | null>(null);
  const targetKey = target?.key;
  const targetTitle = target?.title;
  const targetForm = target?.form;
  const targetWorkspaceId = target?.pluginWorkspaceId;

  useEffect(() => {
    if (openKey) {
      shown.current = openKey;
      return;
    }
    // Another panel is open: the address is its business.
    if (content) return;
    if (!targetKey) {
      asked.current = null;
      shown.current = null;
      return;
    }
    if (shown.current === targetKey) {
      // The panel the address asked for was on screen and is gone: it was closed.
      shown.current = null;
      navigate(PLUGINS_HREF, { replace: true });
      return;
    }
    const alreadyAsked = asked.current?.key === targetKey && asked.current.inspectorOpen === openInspector;
    if (!targetTitle || alreadyAsked) return;
    show(targetKey, targetTitle, {
      ...(targetForm ? { form: targetForm } : {}),
      ...(targetWorkspaceId ? { pluginWorkspaceId: targetWorkspaceId } : {}),
    });
  }, [openKey, content, targetKey, targetTitle, targetForm, targetWorkspaceId, show, asked, openInspector, navigate]);
}

/**
 * Connects the install panel to the inspector and the address, as the Skills tab's install panel does. A source form
 * and a check have addresses of their own, so a reload opens them again; a built-in plugin's check that hasn't answered
 * has none, and its panel moves to the check's address once it does. Once the plugin has a record, the panel moves to
 * the plugin's own address (`?item=plugin:<id>`), where Continue and a reload find it. Closing the panel clears the
 * address. The inspector closes whenever the address changes, so a panel always opens after the move, never before.
 */
export function usePluginInstallPanel(list: CapabilityPluginListResponse | undefined): PluginInstallPanelOpener {
  const { search, navigate } = useCockpitRoute();
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const panels = usePanelShow();
  useAddressPanel(usePanelTarget(search, list), panels);

  return {
    install: (item) => {
      const key = draftPluginInstallKey(`built_in:${item.pluginId}`);
      // A second press while the first check runs shows that check rather than making another.
      if (readPluginInstall(key)?.state.phase !== "checking") {
        resetPluginInstall(key);
        startPluginInspection(key, { kind: "built_in", pluginId: item.pluginId }, { client, workspaceId });
      }
      panels.show(key, item.name);
    },
    resume: (item) => {
      // A waiting approval this page already follows opens at once.
      const followed = readPluginInstall(pluginInstallKey(item.pluginId))?.state;
      if (followed?.phase === "following" && followed.waitingApprovalId) {
        reopenSettingsApproval(followed.waitingApprovalId);
      }
      navigate(pluginItemHref(item.pluginId));
    },
    openSource: (kind) => {
      resetPluginInstall(draftPluginInstallKey(kind));
      navigate(pluginSourceItemHref(kind));
    },
  };
}
