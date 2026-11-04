// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceDesignContextSettings } from "./WorkspaceDesignContextSettings";

const api = vi.hoisted(() => ({
  fetchWorkspaceGuidance: vi.fn(),
  updateWorkspaceGuidance: vi.fn(),
  fetchChatGeneratedArtifacts: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchWorkspaceGuidance: api.fetchWorkspaceGuidance,
  updateWorkspaceGuidance: api.updateWorkspaceGuidance,
  fetchChatGeneratedArtifacts: api.fetchChatGeneratedArtifacts,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.resetAllMocks();
});

function guidanceDoc(docType: "product" | "design", content: string, workspaceId = "ws-1") {
  return {
    docType,
    scope: "workspace",
    workspaceId,
    fileName: docType === "design" ? "DESIGN.md" : "PRODUCT.md",
    absolutePath: `/runtime/workspaces/${workspaceId}/${docType === "design" ? "DESIGN.md" : "PRODUCT.md"}`,
    exists: content.length > 0,
    content,
  };
}

async function mount() {
  api.fetchWorkspaceGuidance.mockResolvedValue({
    workspaceId: "ws-1",
    global: [],
    workspace: [guidanceDoc("product", "# Product\n"), guidanceDoc("design", "# Design\n")],
  });
  api.fetchChatGeneratedArtifacts.mockResolvedValue({
    items: [
      {
        artifactId: "artifact-1",
        workspaceId: "ws-1",
        title: "Design system draft",
        kind: "markdown",
        content: "# Design\n\n```brand\nname: Acme\n```\n",
        contentHash: "hash-1",
      },
      {
        artifactId: "artifact-redacted",
        workspaceId: "ws-1",
        title: "Redacted draft",
        kind: "markdown",
        content: "# Design\n\n[redacted]\n",
        contentHash: "hash-2",
        publicProjection: {
          contentRedacted: true,
          redactionCount: 1,
          redactedPaths: ["content"],
          canonicalContentHashRefersToStoredArtifact: true,
        },
      },
    ],
  });
  api.updateWorkspaceGuidance.mockImplementation(
    async (_workspaceId: string, docType: "product" | "design", content: string) => guidanceDoc(docType, content),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await renderWorkspace("ws-1");
  await vi.waitFor(() => expect(textarea("DESIGN.md").value).toBe("# Design\n"));
}

async function renderWorkspace(workspaceId: string) {
  await act(async () =>
    root!.render(<WorkspaceDesignContextSettings key={`design-context:${workspaceId}`} workspaceId={workspaceId} />),
  );
}

function deferDesignSave() {
  const saved = guidanceDoc("design", "# Draft A\n");
  let resolve!: (record: typeof saved) => void;
  const pending = new Promise<typeof saved>((settle) => {
    resolve = settle;
  });
  api.updateWorkspaceGuidance.mockReturnValueOnce(pending);
  return async () => {
    await act(async () => resolve(saved));
  };
}

function textarea(label: string): HTMLTextAreaElement {
  const labelElement = [...container!.querySelectorAll("label")].find((node) => node.textContent?.trim() === label);
  const id = labelElement?.getAttribute("for");
  return container!.querySelector(`#${CSS.escape(id ?? "")}`) as HTMLTextAreaElement;
}

function button(name: string): HTMLButtonElement {
  return [...container!.querySelectorAll("button")].find((node) => node.textContent?.trim() === name)!;
}

function type(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("WorkspaceDesignContextSettings", () => {
  it("loads both workspace docs into editors and saves an edited DESIGN.md", async () => {
    await mount();

    expect(textarea("PRODUCT.md").value).toBe("# Product\n");
    expect(api.fetchWorkspaceGuidance).toHaveBeenCalledWith("ws-1");

    await act(async () => type(textarea("DESIGN.md"), "# Design\n\n```brand\nname: Acme\n```\n"));
    await act(async () => button("Save DESIGN.md").click());

    expect(api.updateWorkspaceGuidance).toHaveBeenCalledWith(
      "ws-1",
      "design",
      "# Design\n\n```brand\nname: Acme\n```\n",
    );
    await vi.waitFor(() => expect(container!.textContent).toContain("Saved DESIGN.md"));
  });

  it("preserves and can save newer edits after a pending DESIGN.md save succeeds", async () => {
    await mount();
    const finishSave = deferDesignSave();
    try {
      await act(async () => type(textarea("DESIGN.md"), "# Draft A"));
      await act(async () => button("Save DESIGN.md").click());
      expect(api.updateWorkspaceGuidance).toHaveBeenCalledExactlyOnceWith("ws-1", "design", "# Draft A");
      expect(button("Save DESIGN.md").disabled).toBe(true);
      expect(textarea("DESIGN.md").disabled).toBe(false);

      await act(async () => type(textarea("DESIGN.md"), "# Draft B"));
      expect(textarea("DESIGN.md").value).toBe("# Draft B");
    } finally {
      await finishSave();
    }

    expect(textarea("DESIGN.md").value).toBe("# Draft B");
    expect(container!.textContent).toContain("Your newer edits are unsaved.");
    expect(button("Save DESIGN.md").disabled).toBe(false);
    await act(async () => button("Save DESIGN.md").click());
    expect(api.updateWorkspaceGuidance).toHaveBeenNthCalledWith(2, "ws-1", "design", "# Draft B");
  });

  it("adopts normalized DESIGN.md from an untouched save while PRODUCT.md remains editable", async () => {
    await mount();
    const finishSave = deferDesignSave();
    try {
      await act(async () => type(textarea("DESIGN.md"), "# Draft A"));
      await act(async () => button("Save DESIGN.md").click());
      expect(api.updateWorkspaceGuidance).toHaveBeenCalledExactlyOnceWith("ws-1", "design", "# Draft A");
      await act(async () => type(textarea("PRODUCT.md"), "# Product draft"));
    } finally {
      await finishSave();
    }

    expect(textarea("DESIGN.md").value).toBe("# Draft A\n");
    expect(container!.textContent).toContain("Saved DESIGN.md");
    expect(textarea("PRODUCT.md").value).toBe("# Product draft");
  });

  it("keeps a late save response in the workspace that submitted it", async () => {
    await mount();
    const finishSave = deferDesignSave();
    try {
      await act(async () => type(textarea("DESIGN.md"), "# Draft A"));
      await act(async () => button("Save DESIGN.md").click());
      expect(api.updateWorkspaceGuidance).toHaveBeenCalledExactlyOnceWith("ws-1", "design", "# Draft A");

      api.fetchWorkspaceGuidance.mockResolvedValue({
        workspaceId: "ws-2",
        global: [],
        workspace: [guidanceDoc("design", "# Other workspace\n", "ws-2")],
      });
      api.fetchChatGeneratedArtifacts.mockResolvedValue({ items: [] });
      await renderWorkspace("ws-2");
      await vi.waitFor(() => expect(textarea("DESIGN.md").value).toBe("# Other workspace\n"));
      await act(async () => type(textarea("DESIGN.md"), "# Other workspace draft"));
    } finally {
      await finishSave();
    }

    expect(textarea("DESIGN.md").value).toBe("# Other workspace draft");
    expect(container!.textContent).not.toContain("Saved DESIGN.md");
    expect(button("Save DESIGN.md").disabled).toBe(false);
  });

  it("loads a generated artifact into the DESIGN.md editor with its hash recorded, saving only on Save", async () => {
    await mount();
    await vi.waitFor(() => expect(container!.querySelector("select")?.options.length).toBeGreaterThan(0));

    await act(async () => button("Apply as DESIGN.md").click());

    const applied =
      "<!-- applied from generated artifact artifact-1 contentHash hash-1 -->\n# Design\n\n```brand\nname: Acme\n```\n";
    expect(textarea("DESIGN.md").value).toBe(applied);
    expect(api.updateWorkspaceGuidance).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("Review the DESIGN.md editor, then save");

    await act(async () => button("Save DESIGN.md").click());

    expect(api.updateWorkspaceGuidance).toHaveBeenCalledWith("ws-1", "design", applied);
  });

  it("does not offer redacted artifacts", async () => {
    await mount();
    await vi.waitFor(() => expect(container!.querySelector("select")?.options.length).toBeGreaterThan(0));

    const options = [...container!.querySelectorAll("option")].map((option) => option.value);
    expect(options).toEqual(["artifact-1"]);
  });

  it("keeps Save and Apply disabled until the workspace docs have loaded", async () => {
    api.fetchWorkspaceGuidance.mockReturnValue(new Promise(() => undefined));
    api.fetchChatGeneratedArtifacts.mockReturnValue(new Promise(() => undefined));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<WorkspaceDesignContextSettings workspaceId="ws-1" />));

    expect(button("Save DESIGN.md").disabled).toBe(true);
    expect(button("Save PRODUCT.md").disabled).toBe(true);
    expect(textarea("DESIGN.md").disabled).toBe(true);
  });

  it("keeps Save disabled after the workspace docs failed to load", async () => {
    api.fetchWorkspaceGuidance.mockRejectedValue(new Error("gateway unavailable"));
    api.fetchChatGeneratedArtifacts.mockResolvedValue({ items: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<WorkspaceDesignContextSettings workspaceId="ws-1" />));
    await vi.waitFor(() => expect(container!.textContent).toContain("Workspace documents unavailable"));

    expect(button("Save DESIGN.md").disabled).toBe(true);
    expect(textarea("DESIGN.md").disabled).toBe(true);
  });

  it("explains the brand block and that the docs are workspace-only", async () => {
    await mount();

    expect(container!.textContent).toContain("```brand");
    expect(container!.textContent).toContain("only this workspace");
  });
});
