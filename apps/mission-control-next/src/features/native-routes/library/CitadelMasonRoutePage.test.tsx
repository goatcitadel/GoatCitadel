import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelMasonRoutePage } from "./CitadelMasonRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  getMasonSetupQuestions: vi.fn(),
  createMasonSession: vi.fn(),
  sendMasonMessage: vi.fn(),
  draftBlueprintFromMasonSession: vi.fn(),
  reviewMasonBlueprint: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  getMasonSetupQuestions: apiMocks.getMasonSetupQuestions,
  createMasonSession: apiMocks.createMasonSession,
  sendMasonMessage: apiMocks.sendMasonMessage,
  draftBlueprintFromMasonSession: apiMocks.draftBlueprintFromMasonSession,
  reviewMasonBlueprint: apiMocks.reviewMasonBlueprint,
}));

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
  const [first] = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).includes(label),
  );
  if (!first) {
    throw new Error(`No button found containing "${label}"`);
  }
  return first;
}

describe("CitadelMasonRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getMasonSetupQuestions.mockResolvedValue([
      "What is this Citadel for?",
      "What must stay sealed?",
    ]);
    apiMocks.createMasonSession.mockResolvedValue({
      sessionId: "s1",
      answers: {},
      status: "collecting",
      createdAt: "t",
      updatedAt: "t",
    });
    apiMocks.sendMasonMessage.mockResolvedValue({
      sessionId: "s1",
      answers: { kind: "company", purpose: "Run the company" },
      status: "collecting",
      createdAt: "t",
      updatedAt: "t",
    });
    apiMocks.draftBlueprintFromMasonSession.mockResolvedValue({ schemaVersion: "goatcitadel.blueprint.v1" });
    apiMocks.reviewMasonBlueprint.mockResolvedValue({
      name: "Acme",
      kind: "company",
      chamberCount: 3,
      sealedChamberCount: 1,
      boundaries: [],
      riskNotes: [],
      lines: ["Staging only — nothing is connected or activated until you confirm."],
    });
  });

  it("renders the Mason header even while questions load", () => {
    const markup = renderToStaticMarkup(<CitadelMasonRoutePage {...baseProps} />);
    expect(markup).toContain("The Mason");
  });

  it("loads the setup questions after mount", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelMasonRoutePage {...baseProps} />);
    });
    expect(apiMocks.getMasonSetupQuestions).toHaveBeenCalledOnce();
    expect(treeString(renderer!)).toContain("What is this Citadel for?");
    expect(treeString(renderer!)).toContain("Start setup");
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
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(1);
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
      renderer!.root.findByType("textarea").props.onChange({ target: { value: "I run a small company" } });
    });
    await act(async () => {
      findButtonByLabel(renderer!, "Send to the Mason").props.onClick();
    });

    expect(apiMocks.sendMasonMessage).toHaveBeenCalledWith("s1", "I run a small company");
    expect(treeString(renderer!)).toContain("Run the company");
  });
});
