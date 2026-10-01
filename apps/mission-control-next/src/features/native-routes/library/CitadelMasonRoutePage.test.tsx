import { resetMasonAttemptsForTests } from "./mason-session-state";
import { masonSession, masonBlueprint, masonSummary } from "./mason.test-support";
import { __resetSessionDraftsForTests } from "./session-drafts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { act, create as createRenderer, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelMasonRoutePage } from "./CitadelMasonRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  getMasonSetupQuestions: vi.fn(),
  getMasonSession: vi.fn(),
  createMasonSession: vi.fn(),
  sendMasonMessage: vi.fn(),
  draftBlueprintFromMasonSession: vi.fn(),
  reviewMasonBlueprint: vi.fn(), draftMasonBlueprint: vi.fn(), updateMasonSessionAnswers: vi.fn(), getCitadelStructureSnapshot: vi.fn(), stageMasonBlueprint: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  getMasonSetupQuestions: apiMocks.getMasonSetupQuestions,
  getMasonSession: apiMocks.getMasonSession,
  createMasonSession: apiMocks.createMasonSession,
  sendMasonMessage: apiMocks.sendMasonMessage,
  draftBlueprintFromMasonSession: apiMocks.draftBlueprintFromMasonSession,
  reviewMasonBlueprint: apiMocks.reviewMasonBlueprint, draftMasonBlueprint: apiMocks.draftMasonBlueprint, updateMasonSessionAnswers: apiMocks.updateMasonSessionAnswers, getCitadelStructureSnapshot: apiMocks.getCitadelStructureSnapshot, stageMasonBlueprint: apiMocks.stageMasonBlueprint,
}));

const renderers: ReactTestRenderer[] = [];
function create(element: Parameters<typeof createRenderer>[0]) { const renderer = createRenderer(element); renderers.push(renderer); return renderer; }
afterEach(async () => { await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); }); });
const baseProps: NativeRoutePagesProps = {
  route: { area: "library", section: "citadel", theme: "library" },
  activeWorkspaceId: "default",
  activeWorkspaceName: "Default",
  pendingApprovals: 0,
  navigate: vi.fn(),
  setActiveWorkspaceId: vi.fn(),
};

function treeString(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

/** Gather the visible text of a node by walking only its string children (avoids circular React refs). */
function instanceText(node: ReactTestInstance | string): string {
  if (typeof node === "string") {
    return node;
  }
  const children = node.children ?? [];
  return children.map((child) => instanceText(child)).join(" ");
}

function findButtonByLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const [first] = renderer.root.findAll((node) => node.type === "button" && instanceText(node).includes(label));
  if (!first) {
    throw new Error(`No button found containing "${label}"`);
  }
  return first;
}

describe("CitadelMasonRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSessionDraftsForTests(); __resetSessionViewStateForTests();
    apiMocks.getMasonSetupQuestions.mockResolvedValue(["What is this Citadel for?", "What must stay sealed?"]);
    resetMasonAttemptsForTests();
    let owner = masonSession();
    apiMocks.createMasonSession.mockImplementation(async () => structuredClone(owner));
    apiMocks.getMasonSession.mockImplementation(async () => structuredClone(owner));
    apiMocks.sendMasonMessage.mockImplementation(async () => { owner = { ...owner, answers: { kind: "company", purpose: "Run the company" } }; return structuredClone(owner); });
    apiMocks.draftMasonBlueprint.mockResolvedValue(masonBlueprint);
    apiMocks.draftBlueprintFromMasonSession.mockResolvedValue(masonBlueprint);
    apiMocks.reviewMasonBlueprint.mockResolvedValue(masonSummary);
  });

  it("renders the Mason header even while questions load", () => {
    const markup = renderToStaticMarkup(<CitadelMasonRoutePage {...baseProps} />);
    expect(markup).toContain("Citadel setup");
  });

  it("loads the setup questions after mount", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelMasonRoutePage {...baseProps} />);
    });
    expect(apiMocks.getMasonSetupQuestions).toHaveBeenCalledOnce();
    expect(treeString(renderer!)).toContain("What is this Citadel for?");
    expect(treeString(renderer!)).toContain("Start setup");
    expect(treeString(renderer!)).toContain("Blueprint progress");
    expect(treeString(renderer!)).toContain("Draft only · nothing activates yet");
    expect(treeString(renderer!)).toContain("Activation remains unavailable");
  });

  it("starts a session and reveals the message field", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelMasonRoutePage {...baseProps} />);
    });

    await act(async () => {
      findButtonByLabel(renderer!, "Start setup").props.onClick();
    });

    expect(apiMocks.createMasonSession).toHaveBeenCalledOnce();
    expect(renderer!.root.findAllByType("textarea").some(node => node.props.placeholder?.startsWith("e.g."))).toBe(true);
  });

  it("interprets a freeform message through the Mason and shows the captured answers", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelMasonRoutePage {...baseProps} />);
    });
    await act(async () => {
      findButtonByLabel(renderer!, "Start setup").props.onClick();
    });

    await act(async () => {
      renderer!.root.findAllByType("textarea").find(node => node.props.placeholder?.startsWith("e.g."))!.props.onChange({ target: { value: "I run a small company" } });
    });
    await act(async () => {
      findButtonByLabel(renderer!, "Send to the Mason").props.onClick();
    });

    expect(apiMocks.sendMasonMessage).toHaveBeenCalledWith("session-one", "I run a small company");
    expect(treeString(renderer!)).toContain("Run the company");
  });
});
