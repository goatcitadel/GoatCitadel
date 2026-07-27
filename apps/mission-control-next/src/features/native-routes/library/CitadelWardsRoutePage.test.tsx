import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelWardsRoutePage } from "./CitadelWardsRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  listCitadelWards: vi.fn(),
  addCitadelWard: vi.fn(),
  evaluateCitadelGatehouseAction: vi.fn(),
  removeCitadelWard: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  listCitadelWards: apiMocks.listCitadelWards,
  addCitadelWard: apiMocks.addCitadelWard,
  evaluateCitadelGatehouseAction: apiMocks.evaluateCitadelGatehouseAction,
  removeCitadelWard: apiMocks.removeCitadelWard,
}));

vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: { open: boolean; title: string; confirmLabel: string; onConfirm: () => void }) =>
    props.open ? (
      <div role="dialog" aria-label={props.title}>
        <span>{props.title}</span>
        <button type="button" onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
}));

function makeProps(): NativeRoutePagesProps {
  return {
    route: { area: "library", section: "citadel-wards", theme: "library" },
    activeWorkspaceId: "default",
    activeWorkspaceName: "Acme",
    pendingApprovals: 0,
    navigate: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
  };
}

function treeString(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function instanceText(node: ReactTestInstance | string): string {
  if (typeof node === "string") {
    return node;
  }
  return (node.children ?? []).map((child) => instanceText(child)).join(" ");
}

function buttonByLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const [node] = renderer.root.findAll((n) => n.type === "button" && instanceText(n).includes(label));
  if (!node) {
    throw new Error(`No button "${label}"`);
  }
  return node;
}

function inputByPlaceholder(renderer: ReactTestRenderer, placeholder: string): ReactTestInstance {
  const [node] = renderer.root.findAll((n) => n.type === "input" && n.props?.placeholder === placeholder);
  if (!node) {
    throw new Error(`No input "${placeholder}"`);
  }
  return node;
}

describe("CitadelWardsRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listCitadelWards.mockResolvedValue([]);
    apiMocks.addCitadelWard.mockResolvedValue({
      wardId: "w1",
      citadelId: "default",
      name: "Block shell",
      actionPattern: "shell.*",
      effect: "deny",
      createdAt: "t",
    });
    apiMocks.evaluateCitadelGatehouseAction.mockResolvedValue({ action: "shell.run", effect: "deny" });
    apiMocks.removeCitadelWard.mockResolvedValue(undefined);
  });

  it("renders the Wards header", () => {
    const markup = renderToStaticMarkup(<CitadelWardsRoutePage {...makeProps()} />);
    expect(markup).toContain("Wards");
  });

  it("lists existing wards", async () => {
    apiMocks.listCitadelWards.mockResolvedValue([
      {
        wardId: "w0",
        citadelId: "default",
        name: "Seal finance",
        actionPattern: "finance.*",
        effect: "deny",
        createdAt: "t",
      },
    ]);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelWardsRoutePage {...makeProps()} />);
    });
    expect(apiMocks.listCitadelWards).toHaveBeenCalledWith("default");
    expect(treeString(renderer!)).toContain("Seal finance");
    expect(treeString(renderer!)).toContain("mc-next-native-work-pair mc-next-citadel-wards-grid");
    expect(buttonByLabel(renderer!, "Add Ward").props["data-variant"]).toBe("default");
    expect(buttonByLabel(renderer!, "Evaluate").props["data-variant"]).toBe("default");
  });

  it("adds a ward and appends it to the list", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelWardsRoutePage {...makeProps()} />);
    });
    await act(async () => {
      inputByPlaceholder(renderer!, "Block destructive shell").props.onChange({ target: { value: "Block shell" } });
    });
    await act(async () => {
      inputByPlaceholder(renderer!, "shell.*").props.onChange({ target: { value: "shell.*" } });
    });
    await act(async () => {
      buttonByLabel(renderer!, "Add Ward").props.onClick();
    });
    expect(apiMocks.addCitadelWard).toHaveBeenCalledWith("default", {
      name: "Block shell",
      actionPattern: "shell.*",
      effect: "deny",
    });
    expect(treeString(renderer!)).toContain("Block shell");
  });

  it("evaluates an action against the wards", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelWardsRoutePage {...makeProps()} />);
    });
    await act(async () => {
      inputByPlaceholder(renderer!, "shell.run").props.onChange({ target: { value: "shell.run" } });
    });
    await act(async () => {
      buttonByLabel(renderer!, "Evaluate").props.onClick();
    });
    expect(apiMocks.evaluateCitadelGatehouseAction).toHaveBeenCalledWith("default", "shell.run");
    expect(treeString(renderer!)).toContain("shell.run");
  });

  it("deletes a selected Ward only after confirmation", async () => {
    apiMocks.listCitadelWards.mockResolvedValue([
      {
        wardId: "w0",
        citadelId: "default",
        name: "Seal finance",
        actionPattern: "finance.*",
        effect: "deny",
        createdAt: "t",
      },
    ]);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelWardsRoutePage {...makeProps()} />);
    });
    await act(async () => {
      buttonByLabel(renderer!, "Delete Ward").props.onClick();
    });
    expect(treeString(renderer!)).toContain("Delete this Ward?");
    await act(async () => {
      const confirmButtons = renderer!.root.findAll(
        (node) => node.type === "button" && instanceText(node).includes("Delete Ward"),
      );
      confirmButtons.at(-1)?.props.onClick();
      await Promise.resolve();
    });
    expect(apiMocks.removeCitadelWard).toHaveBeenCalledWith("default", "w0");
    expect(treeString(renderer!)).not.toContain("Seal finance");
  });
});
