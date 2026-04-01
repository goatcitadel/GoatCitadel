import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const apiMocks = vi.hoisted(() => ({
  fetchSkillActivationPolicies: vi.fn(),
  fetchSkillImportHistory: vi.fn(),
  fetchSkillLookup: vi.fn(),
  fetchSkillSources: vi.fn(),
  fetchSkills: vi.fn(),
  installSkillImport: vi.fn(),
  patchSkillActivationPolicies: vi.fn(),
  reloadSkills: vi.fn(),
  updateSkillState: vi.fn(),
  validateSkillImport: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchSkillActivationPolicies: apiMocks.fetchSkillActivationPolicies,
  fetchSkillImportHistory: apiMocks.fetchSkillImportHistory,
  fetchSkillLookup: apiMocks.fetchSkillLookup,
  fetchSkillSources: apiMocks.fetchSkillSources,
  fetchSkills: apiMocks.fetchSkills,
  installSkillImport: apiMocks.installSkillImport,
  patchSkillActivationPolicies: apiMocks.patchSkillActivationPolicies,
  reloadSkills: apiMocks.reloadSkills,
  updateSkillState: apiMocks.updateSkillState,
  validateSkillImport: apiMocks.validateSkillImport,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (
    _topic: string,
    callback: (signal: unknown) => Promise<void> | void,
  ) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../state/ui-preferences", () => ({
  useUiPreferences: () => ({
    mode: "default",
  }),
}));

vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>{primary}{secondary}</div>
  ),
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/HelpHint", () => ({
  HelpHint: () => <span>HelpHint</span>,
}));

vi.mock("../components/ui", () => ({
  GCSelect: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  GCSwitch: (props: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    label?: string;
  }) => (
    <label>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onCheckedChange(event.target.checked)}
      />
      {props.label}
    </label>
  ),
}));

import { SkillsPage } from "./SkillsPage";

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("SkillsPage refresh discipline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    apiMocks.fetchSkills.mockResolvedValue({
      items: [
        {
          skillId: "skill-1",
          name: "Browser Helper",
          source: "local",
          declaredTools: [],
          requires: [],
          tags: [],
          keywords: [],
          state: "disabled",
          note: "",
        },
      ],
    });
    apiMocks.fetchSkillActivationPolicies.mockResolvedValue({
      guardedAutoThreshold: 0.72,
      requireFirstUseConfirmation: true,
    });
    apiMocks.fetchSkillImportHistory.mockResolvedValue({ items: [] });
    apiMocks.fetchSkillSources.mockResolvedValue({
      items: [],
      providers: [],
    });
    apiMocks.fetchSkillLookup.mockResolvedValue({
      items: [],
      providers: [],
      bestMatch: undefined,
      parsedSource: undefined,
    });
  });

  it("skips static policy/history fetches during background refresh and preserves dirty drafts", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SkillsPage />);
      });
      await flush();

      const noteInput = renderer.root.findByProps({ placeholder: "Optional reason" });
      await act(async () => {
        noteInput.props.onChange({ target: { value: "Keep this local note" } });
      });

      expect(apiMocks.fetchSkills).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSkillActivationPolicies).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSkillImportHistory).toHaveBeenCalledTimes(1);
      expect(refreshState.callback).toBeTypeOf("function");

      await act(async () => {
        await refreshState.callback?.({
          topic: "skills",
          timestamp: Date.now(),
          reason: "test-refresh",
        });
      });
      await flush();

      expect(apiMocks.fetchSkills).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchSkillActivationPolicies).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSkillImportHistory).toHaveBeenCalledTimes(1);
      expect(renderer.root.findByProps({ placeholder: "Optional reason" }).props.value).toBe("Keep this local note");
    } finally {
      renderer.unmount();
    }
  });
});
