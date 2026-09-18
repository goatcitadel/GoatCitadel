import { __resetSessionDraftsForTests } from "./session-drafts";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { CitadelVaultRoutePage } from "./CitadelVaultRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  getCitadelVaultSnapshot: vi.fn(),
  storeCitadelVaultSecret: vi.fn(),
  revealCitadelVaultSecret: vi.fn(),
  deleteCitadelVaultSecret: vi.fn(),
  isApiRequestError: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  getCitadelVaultSnapshot: apiMocks.getCitadelVaultSnapshot,
  storeCitadelVaultSecret: apiMocks.storeCitadelVaultSecret,
  revealCitadelVaultSecret: apiMocks.revealCitadelVaultSecret,
  deleteCitadelVaultSecret: apiMocks.deleteCitadelVaultSecret,
  isApiRequestError: apiMocks.isApiRequestError,
}));

function makeProps(): NativeRoutePagesProps {
  return {
    route: { area: "library", section: "citadel-vault", theme: "library" },
    activeWorkspaceId: "default",
    activeWorkspaceName: "Acme",
    pendingApprovals: 0,
    navigate: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
  };
}

function vaultSnapshot(revision = "a", citadelId = "default") {
  return { citadelId, revision: revision.repeat(64), items: [{ secretId: "s1", secretName: "stripe", createdAt: "t", updatedAt: revision }] };
}

async function openDraft(renderer: ReactTestRenderer, name = "new-secret", value = "synthetic-draft") {
  await act(async () => { buttonByLabel(renderer, "Store secret").props.onClick(); });
  await act(async () => { inputByPlaceholder(renderer, "stripe-secret-key").props.onChange({ target: { value: name } }); });
  await act(async () => { inputByPlaceholder(renderer, "sk-live-…").props.onChange({ target: { value } }); });
}

async function mountVault(props = makeProps()) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<CitadelVaultRoutePage {...props} />); });
  return renderer;
}

function replaceSecretModal(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(ConfirmModal).find((modal) => modal.props.title === "Replace secret?")!;
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

function deleteButtonFor(renderer: ReactTestRenderer, secretName: string): ReactTestInstance {
  const [node] = renderer.root.findAll(
    (n) => n.type === "button" && n.props?.["aria-label"] === `Delete ${secretName}`,
  );
  if (!node) {
    throw new Error(`No delete button for "${secretName}"`);
  }
  return node;
}

function deleteSecretModal(renderer: ReactTestRenderer): ReactTestInstance {
  // Mirror CuratorRoutePage.test.tsx: locate the secret-delete ConfirmModal by its
  // title so the assertion stays correct even if other ConfirmModals are added later.
  const modal = renderer.root.findAllByType(ConfirmModal).find((m) => m.props.title === "Delete secret?");
  if (!modal) {
    throw new Error('No ConfirmModal titled "Delete secret?"');
  }
  return modal;
}

describe("CitadelVaultRoutePage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetSessionDraftsForTests();
    apiMocks.getCitadelVaultSnapshot.mockResolvedValue(vaultSnapshot());
    apiMocks.storeCitadelVaultSecret.mockResolvedValue(vaultSnapshot("b"));
    apiMocks.revealCitadelVaultSecret.mockResolvedValue("sk-live-REVEALED");
    apiMocks.deleteCitadelVaultSecret.mockResolvedValue({ ...vaultSnapshot("b"), items: [] });
    apiMocks.isApiRequestError.mockImplementation((error) => typeof error?.status === "number");
  });

  it("renders the Vault header", () => {
    apiMocks.getCitadelVaultSnapshot.mockReturnValue(new Promise(() => {}));
    const markup = renderToStaticMarkup(<CitadelVaultRoutePage {...makeProps()} />);
    expect(markup).toContain("Vault");
  });

  it("retains a conflicted draft and requires explicit metadata review before retry", async () => {
    const renderer = await mountVault();
    await openDraft(renderer);
    apiMocks.storeCitadelVaultSecret.mockRejectedValueOnce(Object.assign(new Error("Changed"), { status: 409 }));
    apiMocks.getCitadelVaultSnapshot.mockResolvedValue(vaultSnapshot("b"));
    await act(async () => { buttonByLabel(renderer, "Seal & store").props.onClick(); });
    expect(inputByPlaceholder(renderer, "sk-live-…").props.value).toBe("synthetic-draft");
    expect(buttonByLabel(renderer, "Seal & store").props.disabled).toBe(true);
    expect(apiMocks.storeCitadelVaultSecret).toHaveBeenCalledTimes(1);
    const review = renderer.root.findByProps({ "aria-label": "Current Vault review" });
    expect(instanceText(review)).toContain("stripe");
    expect(instanceText(review)).not.toContain("synthetic-draft");
    await act(async () => { buttonByLabel(renderer, "Use current Vault review").props.onClick(); });
    expect(apiMocks.storeCitadelVaultSecret).toHaveBeenCalledTimes(1);
    await act(async () => { buttonByLabel(renderer, "Seal & store").props.onClick(); });
    expect(apiMocks.storeCitadelVaultSecret).toHaveBeenLastCalledWith("default", "new-secret", "synthetic-draft", "b".repeat(64));
    expect(apiMocks.revealCitadelVaultSecret).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("requires replacement confirmation and acknowledges only the submitted input", async () => {
    const renderer = await mountVault();
    await openDraft(renderer, " stripe ");
    await act(async () => { buttonByLabel(renderer, "Seal & store").props.onClick(); });
    expect(apiMocks.storeCitadelVaultSecret).not.toHaveBeenCalled();
    expect(replaceSecretModal(renderer).props.open).toBe(true);
    expect(replaceSecretModal(renderer).props.message).not.toContain("synthetic-draft");
    await act(async () => { inputByPlaceholder(renderer, "sk-live-…").props.onChange({ target: { value: "synthetic-newer" } }); });
    await act(async () => { replaceSecretModal(renderer).props.onConfirm(); });
    expect(apiMocks.storeCitadelVaultSecret).toHaveBeenCalledExactlyOnceWith("default", "stripe", "synthetic-draft", "a".repeat(64));
    expect(inputByPlaceholder(renderer, "sk-live-…").props.value).toBe("synthetic-newer");
    expect(apiMocks.getCitadelVaultSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it("requires a new deletion confirmation after a peer replacement", async () => {
    const renderer = await mountVault();
    await act(async () => { buttonByLabel(renderer, "stripe").props.onClick(); });
    await act(async () => { deleteButtonFor(renderer, "stripe").props.onClick(); });
    apiMocks.deleteCitadelVaultSecret.mockRejectedValueOnce(Object.assign(new Error("Replaced"), { status: 409 }));
    apiMocks.getCitadelVaultSnapshot.mockResolvedValue(vaultSnapshot("b"));
    await act(async () => { deleteSecretModal(renderer).props.onConfirm(); });
    expect(deleteSecretModal(renderer).props.open).toBe(false);
    expect(apiMocks.deleteCitadelVaultSecret).toHaveBeenCalledTimes(1);
    await act(async () => { buttonByLabel(renderer, "Use current Vault review").props.onClick(); });
    await act(async () => { buttonByLabel(renderer, "stripe").props.onClick(); });
    await act(async () => { deleteButtonFor(renderer, "stripe").props.onClick(); });
    expect(apiMocks.deleteCitadelVaultSecret).toHaveBeenCalledTimes(1);
    await act(async () => { deleteSecretModal(renderer).props.onConfirm(); });
    expect(apiMocks.deleteCitadelVaultSecret).toHaveBeenLastCalledWith("default", "s1", "b".repeat(64));
    await act(async () => renderer.unmount());
  });

  it.each([409, 503])("retains the form after error %s even if the review refresh fails", async (status) => {
    const renderer = await mountVault();
    await openDraft(renderer);
    apiMocks.storeCitadelVaultSecret.mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status }));
    apiMocks.getCitadelVaultSnapshot.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => { buttonByLabel(renderer, "Seal & store").props.onClick(); });
    expect(inputByPlaceholder(renderer, "sk-live-…").props.value).toBe("synthetic-draft");
    expect(apiMocks.storeCitadelVaultSecret).toHaveBeenCalledTimes(1);
    if (status === 409) expect(buttonByLabel(renderer, "Seal & store").props.disabled).toBe(true);
    else expect(treeString(renderer)).toContain("Vault unavailable");
    await act(async () => renderer.unmount());
  });

  it("suppresses double submits and ignores an old Citadel's acknowledgement", async () => {
    const renderer = await mountVault();
    await openDraft(renderer);
    let finish!: (value: ReturnType<typeof vaultSnapshot>) => void;
    apiMocks.storeCitadelVaultSecret.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await act(async () => { const click = buttonByLabel(renderer, "Seal & store").props.onClick; click(); click(); });
    expect(apiMocks.storeCitadelVaultSecret).toHaveBeenCalledTimes(1);
    apiMocks.getCitadelVaultSnapshot.mockResolvedValue(vaultSnapshot("c", "other"));
    await act(async () => { renderer.update(<CitadelVaultRoutePage {...makeProps()} activeCitadelId="other" />); });
    await act(async () => { finish({ ...vaultSnapshot("b"), items: [{ secretId: "late", secretName: "Late acknowledgement", createdAt: "t", updatedAt: "t" }] }); });
    expect(treeString(renderer)).not.toContain("Late acknowledgement");
    await openDraft(renderer, "other-name", "other-synthetic");
    expect(inputByPlaceholder(renderer, "sk-live-…").props.value).toBe("other-synthetic");
    await act(async () => renderer.unmount());
  });

  it("reloads failed conflict metadata without losing the draft or approving a write", async () => {
    const renderer = await mountVault();
    await openDraft(renderer);
    apiMocks.storeCitadelVaultSecret.mockRejectedValueOnce(Object.assign(new Error("Changed"), { status: 409 }));
    apiMocks.getCitadelVaultSnapshot.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => { buttonByLabel(renderer, "Seal & store").props.onClick(); });
    apiMocks.getCitadelVaultSnapshot.mockResolvedValue(vaultSnapshot("b"));
    await act(async () => { buttonByLabel(renderer, "Reload Vault review").props.onClick(); });
    expect(inputByPlaceholder(renderer, "sk-live-…").props.value).toBe("synthetic-draft");
    expect(buttonByLabel(renderer, "Seal & store").props.disabled).toBe(true);
    expect(apiMocks.storeCitadelVaultSecret).toHaveBeenCalledTimes(1);
    await act(async () => { buttonByLabel(renderer, "Use current Vault review").props.onClick(); });
    expect(buttonByLabel(renderer, "Seal & store").props.disabled).toBe(false);
    await act(async () => renderer.unmount());
  });

  it.each(["resolve", "reject"])("ignores a late reveal %s after switching Citadels", async (outcome) => {
    const renderer = await mountVault();
    await act(async () => { buttonByLabel(renderer, "stripe").props.onClick(); });
    let finish!: () => void;
    apiMocks.revealCitadelVaultSecret.mockReturnValueOnce(new Promise((resolve, reject) => {
      finish = () => outcome === "resolve" ? resolve("late-synthetic-value") : reject(new Error("late-reveal-error"));
    }));
    await act(async () => { buttonByLabel(renderer, "Reveal").props.onClick(); });
    apiMocks.getCitadelVaultSnapshot.mockResolvedValue(vaultSnapshot("b", "other"));
    await act(async () => { renderer.update(<CitadelVaultRoutePage {...makeProps()} activeCitadelId="other" />); });
    await act(async () => { finish(); });
    await act(async () => { buttonByLabel(renderer, "stripe").props.onClick(); });
    expect(treeString(renderer)).not.toMatch(/late-synthetic-value|late-reveal-error/);
    await act(async () => renderer.unmount());
  });

  it("lists stored secrets by name (not value)", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });
    expect(apiMocks.getCitadelVaultSnapshot).toHaveBeenCalledWith("default");
    expect(treeString(renderer!)).toContain("stripe");
  });

  it("reveals a secret value only on request", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });
    await act(async () => { buttonByLabel(renderer!, "stripe").props.onClick(); });
    expect(treeString(renderer!)).not.toContain("sk-live-REVEALED");

    await act(async () => {
      buttonByLabel(renderer!, "Reveal").props.onClick();
    });
    expect(apiMocks.revealCitadelVaultSecret).toHaveBeenCalledWith("default", "s1");
    expect(treeString(renderer!)).toContain("sk-live-REVEALED");
  });

  it("seals and stores a new secret", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });
    await act(async () => { buttonByLabel(renderer!, "Store secret").props.onClick(); });
    await act(async () => {
      inputByPlaceholder(renderer!, "stripe-secret-key").props.onChange({ target: { value: "openai" } });
    });
    await act(async () => {
      inputByPlaceholder(renderer!, "sk-live-…").props.onChange({ target: { value: "sk-secret" } });
    });
    await act(async () => {
      buttonByLabel(renderer!, "Seal & store").props.onClick();
    });
    expect(apiMocks.storeCitadelVaultSecret).toHaveBeenCalledWith("default", "openai", "sk-secret", "a".repeat(64));
  });

  // P0-4 governance/safety regression: deleting a Vault secret is irreversible, so the
  // row Delete must NOT call the API directly — it must route through the ConfirmModal.
  it("does not delete the secret directly when the row Delete is clicked", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });
    await act(async () => { buttonByLabel(renderer!, "stripe").props.onClick(); });

    expect(deleteSecretModal(renderer!).props.open).toBe(false);

    await act(async () => {
      deleteButtonFor(renderer!, "stripe").props.onClick();
    });

    // The destructive API call is gated: clicking Delete only arms the modal.
    expect(apiMocks.deleteCitadelVaultSecret).not.toHaveBeenCalled();
    expect(deleteSecretModal(renderer!).props.open).toBe(true);
  });

  it("deletes the secret only after the confirm modal is confirmed", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });
    await act(async () => { buttonByLabel(renderer!, "stripe").props.onClick(); });

    await act(async () => {
      deleteButtonFor(renderer!, "stripe").props.onClick();
    });
    expect(apiMocks.deleteCitadelVaultSecret).not.toHaveBeenCalled();

    await act(async () => {
      await deleteSecretModal(renderer!).props.onConfirm();
    });

    expect(apiMocks.deleteCitadelVaultSecret).toHaveBeenCalledTimes(1);
    expect(apiMocks.deleteCitadelVaultSecret).toHaveBeenCalledWith("default", "s1", "a".repeat(64));
    // Confirming closes the modal again.
    expect(deleteSecretModal(renderer!).props.open).toBe(false);
  });

  it("cancelling the confirm modal leaves the secret untouched", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });
    await act(async () => { buttonByLabel(renderer!, "stripe").props.onClick(); });

    await act(async () => {
      deleteButtonFor(renderer!, "stripe").props.onClick();
    });
    expect(deleteSecretModal(renderer!).props.open).toBe(true);

    await act(async () => {
      deleteSecretModal(renderer!).props.onCancel();
    });

    expect(apiMocks.deleteCitadelVaultSecret).not.toHaveBeenCalled();
    expect(deleteSecretModal(renderer!).props.open).toBe(false);
  });
});
