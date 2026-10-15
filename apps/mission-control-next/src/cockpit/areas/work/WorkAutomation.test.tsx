// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkAutomation } from "./WorkAutomation";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import {
  draftAutomationRecipe,
  exportActivepiecesWorkflowTemplate,
  exportN8nWorkflowTemplate,
} from "@goatcitadel/mission-control-shared/api/client";
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  draftAutomationRecipe: vi.fn(),
  exportActivepiecesWorkflowTemplate: vi.fn(),
  exportN8nWorkflowTemplate: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "default" }),
}));
const workspaceNames = vi.hoisted(() => ({
  byId: { default: "Default workspace" } as Record<string, string | undefined>,
}));
vi.mock("../../data/use-workspace-name", () => ({
  useWorkspaceName: (_citadelId: string | undefined, workspaceId: string | undefined) =>
    workspaceNames.byId[workspaceId ?? ""],
}));
const preview = {
  recipe: { name: "Recipe", goal: "Summarize", scheduleIntent: "annual" },
  plan: { planId: "advisory" },
  estimatedLimits: { maxRuntimeMinutes: 10, maxIterations: 3 },
  proofChecklist: ["Review capabilities"],
  missingCapabilities: ["tool:unavailable"],
};
const template = (status = "ready") => ({
  filename: "template.json",
  content: "export content",
  contentType: "application/json",
  contentSha256: "hash",
  evidence: { planId: "advisory", status: "advisory", actionNeeded: "Operator import" },
  posture: { execution: "Operator only" },
  validation: { status, nativeImportCompatibility: "unverified", checks: [] },
});
let renderer: ReactTestRenderer;
const copy = vi.fn();
beforeEach(async () => {
  window.history.replaceState(
    { evidence: "automation-schedule-context" },
    "",
    "/work/automation?workspaceId=old-workspace&citadelId=current-citadel&runId=run-context&sessionId=session-context&filter=retained&shell=cockpit&shellScope=visit#schedule-evidence",
  );
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetSessionViewStateForTests();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  vi.mocked(draftAutomationRecipe).mockResolvedValue(preview as never);
  vi.mocked(exportActivepiecesWorkflowTemplate).mockResolvedValue(template() as never);
  vi.mocked(exportN8nWorkflowTemplate).mockResolvedValue(template() as never);
  await act(async () => {
    renderer = create(<WorkAutomation />);
  });
});
afterEach(() => act(() => renderer.unmount()));
async function click(label: string) {
  const button = renderer.root.findAllByType("button").find((node) => node.children.join("") === label);
  expect(button).toBeDefined();
  await act(async () => button!.props.onClick());
}
async function draft() {
  await act(async () =>
    renderer.root.findAllByType("textarea")[0]!.props.onChange({ target: { value: "Summarize evidence" } }),
  );
  await click("Preview automation recipe");
}
it("drafts through the Gateway and exercises both template export callbacks without scheduling", async () => {
  await draft();
  expect(draftAutomationRecipe).toHaveBeenCalledWith(
    expect.objectContaining({ taskDescription: "Summarize evidence", workspaceId: "default" }),
  );
  expect(JSON.stringify(renderer.toJSON())).toContain("tool:unavailable");
  await click("Copy Activepieces template");
  await click("Copy n8n template");
  expect(exportActivepiecesWorkflowTemplate).toHaveBeenCalledWith({ recipe: preview.recipe });
  expect(exportN8nWorkflowTemplate).toHaveBeenCalledWith({ recipe: preview.recipe });
  expect(copy).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(renderer.toJSON())).toContain("Operator import is required");
  for (const link of renderer.root.findAllByType("a")) {
    const destination = new URL(link.props.href, "http://cockpit.invalid");
    expect(destination.pathname).toBe("/work/schedules");
    expect(destination.searchParams.get("workspaceId")).toBe("default");
    expect(destination.searchParams.get("citadelId")).toBe("current-citadel");
    expect(destination.searchParams.get("runId")).toBe("run-context");
    expect(destination.searchParams.get("sessionId")).toBe("session-context");
    expect(destination.searchParams.get("filter")).toBe("retained");
    expect(destination.searchParams.get("shell")).toBe("cockpit");
    expect(destination.searchParams.has("shellScope")).toBe(false);
    expect(destination.hash).toBe("#schedule-evidence");
  }
  expect(renderer.root.findAllByType("a")).toHaveLength(2);
  expect(window.history.state).toMatchObject({ evidence: "automation-schedule-context" });
});
it("shows blocked validation and failed exports without copying success", async () => {
  await draft();
  vi.mocked(exportActivepiecesWorkflowTemplate).mockResolvedValue(template("blocked") as never);
  await click("Copy Activepieces template");
  expect(copy).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain("export is blocked");
  vi.mocked(exportN8nWorkflowTemplate).mockRejectedValue(new Error("Export owner unavailable"));
  await click("Copy n8n template");
  expect(copy).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain("Export owner unavailable");
});
it("withholds a late advisory preview after editing the draft", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(draftAutomationRecipe).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  await act(async () => renderer.root.findAllByType("textarea")[0]!.props.onChange({ target: { value: "First" } }));
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.join("") === "Preview automation recipe")!;
  let pending!: Promise<void>;
  await act(async () => {
    pending = button.props.onClick();
  });
  await act(async () => renderer.root.findAllByType("textarea")[0]!.props.onChange({ target: { value: "Second" } }));
  await act(async () => {
    finish(preview);
    await pending;
  });
  expect(renderer.root.findAllByType("button").some((node) => node.children.join("") === "Copy n8n template")).toBe(
    false,
  );
});

// react-test-renderer keeps interpolated text as separate children; headings are read joined.
const headings = () => renderer.root.findAllByType("h2").map((node) => node.children.join(""));

it("keeps the previewed recipe and both export results across navigation, without asking the Gateway again", async () => {
  await draft();
  await click("Copy Activepieces template");
  await click("Copy n8n template");
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(<WorkAutomation />);
  });
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("Recipe");
  expect(headings()).toEqual(
    expect.arrayContaining(["Activepieces export validation: ready", "n8n export validation: ready"]),
  );
  expect(draftAutomationRecipe).toHaveBeenCalledOnce();
});

it("shows both platforms' export results side by side", async () => {
  await draft();
  await click("Copy Activepieces template");
  await click("Copy n8n template");
  expect(headings()).toEqual(
    expect.arrayContaining(["Activepieces export validation: ready", "n8n export validation: ready"]),
  );
});

it("hides a kept preview once the draft changes", async () => {
  await draft();
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(<WorkAutomation />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("tool:unavailable");
  await act(async () =>
    renderer.root.findAllByType("textarea")[0]!.props.onChange({ target: { value: "Something else" } }),
  );
  expect(JSON.stringify(renderer.toJSON())).not.toContain("tool:unavailable");
});
it("names the workspace in the designer intro and keeps its id as a technical title", async () => {
  const scope = () => renderer.root.findByProps({ title: "default" });
  expect(scope().children.join("")).toBe("Default workspace");
  workspaceNames.byId = {};
  await act(async () => {
    renderer.update(<WorkAutomation />);
  });
  expect(scope().children.join("")).toBe("workspace default");
  workspaceNames.byId = { default: "Default workspace" };
});
