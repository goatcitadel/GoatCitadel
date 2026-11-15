// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillInstallProgress } from "./SkillInstallProgress";
import type { SkillInstall } from "./use-skill-install";

const state = vi.hoisted(() => ({ skillsInChat: false as boolean | undefined, summaries: [] as string[] }));
vi.mock("../../settings/feature-switches", async (original) => ({
  ...(await original<object>()),
  useFeatureSwitchOn: () => state.skillsInChat,
}));
vi.mock("../../settings/SettingsApprovalDialog", () => ({
  SettingsApprovalDialog: ({ summary }: { summary: string }) => {
    state.summaries.push(summary);
    return <p data-testid="summary">{summary}</p>;
  },
}));

const flow = {
  state: {
    phase: "following",
    install: { step: "waiting_switch_on", approvalId: "approval-1", name: "Planner", blockers: [] },
  },
  asking: false,
  chain: false,
  declined: false,
  unreadable: false,
  workspaceId: "ws-1",
  checkNow: vi.fn(),
  confirm: vi.fn(),
  check: vi.fn(),
} as unknown as SkillInstall;

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  state.summaries = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const summary = async (skillsInChat: boolean | undefined) => {
  state.skillsInChat = skillsInChat;
  await act(async () => root.render(<SkillInstallProgress flow={flow} name="Planner" />));
  return container.querySelector('[data-testid="summary"]')?.textContent;
};

it("tells the switch-on approval that Chat needs Skills in Chat while that switch is off", async () => {
  expect(await summary(false)).toBe(
    "Lets the AI use Planner in new chats once Skills in Chat is turned on in Settings › Advanced.",
  );
});

it("keeps the plain sentence once Skills in Chat is on, or before it has been read", async () => {
  expect(await summary(true)).toBe("Lets the AI use Planner in new chats.");
  expect(await summary(undefined)).toBe("Lets the AI use Planner in new chats.");
});
