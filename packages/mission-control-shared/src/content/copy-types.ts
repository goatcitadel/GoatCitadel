export type TabId =
  | "addons"
  | "onboarding"
  | "dashboard"
  | "system"
  | "files"
  | "memory"
  | "agents"
  | "office"
  | "officeLab"
  | "activity"
  | "cron"
  | "sessions"
  | "chat"
  | "assembly"
  | "promptLab"
  | "improvement"
  | "skills"
  | "costs"
  | "settings"
  | "workspaces"
  | "tools"
  | "approvals"
  | "tasks"
  | "integrations"
  | "mcp"
  | "mesh"
  | "npu";

export type PageId = TabId | "liveFeed";

export interface GuideTerm {
  term: string;
  meaning: string;
}

export interface GuideCopy {
  what: string;
  when: string;
  mostCommonAction?: string;
  actions: string[];
  terms?: GuideTerm[];
}

export interface PageCopy {
  title: string;
  subtitle?: string;
  nextStep?: string;
  guide?: GuideCopy;
}

export interface GlobalCopy {
  guideCard: {
    title: string;
    what: string;
    when: string;
    mostCommonAction: string;
    actions: string;
    terms: string;
  };
  common: {
    save: string;
    cancel: string;
    archive: string;
    restore: string;
    deletePermanently: string;
    apply: string;
    test: string;
    loading: string;
    noPendingEdits: string;
  };
  selectOrCustom: {
    suggested: string;
    custom: string;
    selectValue: string;
    customValueHint: string;
    enterCustom: string;
  };
  commandPalette: {
    placeholder: string;
  };
  configFormBuilder: {
    noSchema: string;
    showAdvanced: string;
    hideAdvanced: string;
    enabled: string;
    envRefChip: string;
    customValue: string;
  };
  smartPathInput: {
    browse: string;
    loadingSuggestions: string;
    editedAfterAutofill: string;
  };
}
