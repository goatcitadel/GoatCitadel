import type { CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "./session-drafts";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelWardsRoutePage } from "./CitadelWardsRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  listCitadelWards: vi.fn(),
  getCitadelAccessSnapshot: vi.fn(),
  addCitadelWard: vi.fn(),
  evaluateCitadelGatehouseAction: vi.fn(),
  removeCitadelWard: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  listCitadelWards: apiMocks.listCitadelWards,
  getCitadelAccessSnapshot: apiMocks.getCitadelAccessSnapshot,
  isApiRequestError: (error: { status?: number }) => typeof error?.status === "number",
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

const revision = "a".repeat(64);
function snapshot(items: CitadelAccessSnapshot["wards"] = [], rev = revision, citadelId = "default"): CitadelAccessSnapshot {
  return { citadelId, revision: rev, structure: { citadelId, revision: "s".repeat(64), charter: null, chambers: [] }, council: [], passages: [], members: [], integrations: [], wards: items };
}

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
  const node = renderer.root.findAll((n) => n.type === "button" && instanceText(n).includes(label)).at(-1);
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
    __resetSessionDraftsForTests();
    apiMocks.listCitadelWards.mockResolvedValue([]);
    apiMocks.getCitadelAccessSnapshot.mockImplementation(async (id: string) => snapshot(await apiMocks.listCitadelWards(id), revision, id));
    apiMocks.addCitadelWard.mockResolvedValue(snapshot([{
      wardId: "w1",
      citadelId: "default",
      name: "Block shell",
      actionPattern: "shell.*",
      effect: "deny",
      createdAt: "t",
    }], "b".repeat(64)));
    apiMocks.evaluateCitadelGatehouseAction.mockResolvedValue({ action: "shell.run", effect: "deny" });
    apiMocks.removeCitadelWard.mockResolvedValue(snapshot([], "b".repeat(64)));
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
    expect(treeString(renderer!)).toContain("mc-next-calm-directory");
    expect(buttonByLabel(renderer!, "Add Ward").props["data-variant"]).toBe("default");
    expect(renderer!.root.findAllByType("input")).toHaveLength(0);
  });

  it("adds a ward and appends it to the list", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelWardsRoutePage {...makeProps()} />);
    });
    await act(async () => { buttonByLabel(renderer!, "Add Ward").props.onClick(); });
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
      expectedRevision: revision,
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
    await act(async () => { buttonByLabel(renderer!, "Test an action").props.onClick(); });
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
    await act(async () => { buttonByLabel(renderer!, "Seal finance").props.onClick(); });
    await act(async () => {
      buttonByLabel(renderer!, "Delete Ward").props.onClick();
    });
    expect(treeString(renderer!)).toContain("Delete this Ward?");
    await act(async () => {
      const confirmButtons = renderer!.root.findAll(
        (node) => node.type === "button" && instanceText(node).includes("Confirm delete Ward"),
      );
      confirmButtons.at(-1)?.props.onClick();
      await Promise.resolve();
    });
    expect(apiMocks.removeCitadelWard).toHaveBeenCalledWith("default", "w0", revision);
    expect(treeString(renderer!)).not.toContain("Seal finance");
  });

  it("retains the Ward draft on conflict and requires current-rule review before an explicit retry", async () => {
    const peer = snapshot([{ wardId: "peer", citadelId: "default", name: "Peer deny", actionPattern: "file.*", effect: "deny", createdAt: "t" }], "b".repeat(64));
    apiMocks.getCitadelAccessSnapshot.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(peer);
    apiMocks.addCitadelWard.mockRejectedValueOnce(Object.assign(new Error("Changed"), { status: 409 }));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelWardsRoutePage {...makeProps()} />); });
    await act(async () => { buttonByLabel(renderer, "Add Ward").props.onClick(); });
    await act(async () => {
      inputByPlaceholder(renderer, "Block destructive shell").props.onChange({ target: { value: "Keep draft" } });
      inputByPlaceholder(renderer, "shell.*").props.onChange({ target: { value: "shell.*" } });
    });
    await act(async () => { await buttonByLabel(renderer, "Add Ward").props.onClick(); });
    expect(inputByPlaceholder(renderer, "Block destructive shell").props.value).toBe("Keep draft");
    expect(treeString(renderer)).toContain("Peer deny");
    expect(buttonByLabel(renderer, "Add Ward").props.disabled).toBe(true);
    await act(async () => { await buttonByLabel(renderer, "Add Ward").props.onClick(); });
    expect(apiMocks.addCitadelWard).toHaveBeenCalledTimes(1);
    await act(async () => { buttonByLabel(renderer, "Use current access review").props.onClick(); });
    expect(buttonByLabel(renderer, "Add Ward").props.disabled).toBe(false);
    expect(apiMocks.addCitadelWard).toHaveBeenCalledTimes(1);
    await act(async () => { await buttonByLabel(renderer, "Add Ward").props.onClick(); });
    expect(apiMocks.addCitadelWard).toHaveBeenLastCalledWith("default", { name: "Keep draft", actionPattern: "shell.*", effect: "deny", expectedRevision: peer.revision });
    expect(apiMocks.getCitadelAccessSnapshot).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it("keeps edits made during a save and accepts only its own acknowledgement", async () => {
    let resolve!: (value: CitadelAccessSnapshot) => void;
    apiMocks.addCitadelWard.mockReturnValueOnce(new Promise<CitadelAccessSnapshot>((done) => { resolve = done; }));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelWardsRoutePage {...makeProps()} />); });
    await act(async () => { buttonByLabel(renderer, "Add Ward").props.onClick(); });
    await act(async () => {
      inputByPlaceholder(renderer, "Block destructive shell").props.onChange({ target: { value: "Submitted" } });
      inputByPlaceholder(renderer, "shell.*").props.onChange({ target: { value: "shell.*" } });
    });
    await act(async () => { void buttonByLabel(renderer, "Add Ward").props.onClick(); });
    await act(async () => { inputByPlaceholder(renderer, "Block destructive shell").props.onChange({ target: { value: "Keep newer draft" } }); });
    const saved = snapshot([{ wardId: "own", citadelId: "default", name: "Submitted", actionPattern: "shell.*", effect: "deny", createdAt: "t" }], "b".repeat(64));
    await act(async () => { resolve(saved); });
    expect(inputByPlaceholder(renderer, "Block destructive shell").props.value).toBe("Keep newer draft");
    expect(apiMocks.getCitadelAccessSnapshot).toHaveBeenCalledTimes(1);
    expect(treeString(renderer)).toContain("Submitted");
    act(() => renderer.unmount());
  });

  it("ignores a late write acknowledgement after the Citadel changes", async () => {
    let resolve!: (value: CitadelAccessSnapshot) => void;
    apiMocks.addCitadelWard.mockReturnValueOnce(new Promise<CitadelAccessSnapshot>((done) => { resolve = done; }));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelWardsRoutePage {...makeProps()} />); });
    await act(async () => { buttonByLabel(renderer, "Add Ward").props.onClick(); });
    await act(async () => {
      inputByPlaceholder(renderer, "Block destructive shell").props.onChange({ target: { value: "Old scope" } });
      inputByPlaceholder(renderer, "shell.*").props.onChange({ target: { value: "shell.*" } });
    });
    await act(async () => { void buttonByLabel(renderer, "Add Ward").props.onClick(); });
    await act(async () => { renderer.update(<CitadelWardsRoutePage {...makeProps()} activeCitadelId="foreign" />); });
    await act(async () => { resolve(snapshot([{ wardId: "old", citadelId: "default", name: "Old scope", actionPattern: "shell.*", effect: "deny", createdAt: "t" }], "b".repeat(64))); });
    expect(treeString(renderer)).not.toContain("Old scope");
    expect(apiMocks.getCitadelAccessSnapshot).toHaveBeenLastCalledWith("foreign");
    act(() => renderer.unmount());
  });
});
