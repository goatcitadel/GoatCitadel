import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { CitadelVaultRoutePage } from "./CitadelVaultRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  listCitadelVaultSecrets: vi.fn(),
  storeCitadelVaultSecret: vi.fn(),
  revealCitadelVaultSecret: vi.fn(),
  deleteCitadelVaultSecret: vi.fn(),
  isApiRequestError: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  listCitadelVaultSecrets: apiMocks.listCitadelVaultSecrets,
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
    vi.clearAllMocks();
    apiMocks.listCitadelVaultSecrets.mockResolvedValue([
      { secretId: "s1", secretName: "stripe", createdAt: "t", updatedAt: "t" },
    ]);
    apiMocks.storeCitadelVaultSecret.mockResolvedValue({ secretId: "s2", secretName: "openai", createdAt: "t", updatedAt: "t" });
    apiMocks.revealCitadelVaultSecret.mockResolvedValue("sk-live-REVEALED");
    apiMocks.deleteCitadelVaultSecret.mockResolvedValue(undefined);
    apiMocks.isApiRequestError.mockReturnValue(false);
  });

  it("renders the Vault header", () => {
    apiMocks.listCitadelVaultSecrets.mockReturnValue(new Promise(() => {}));
    const markup = renderToStaticMarkup(<CitadelVaultRoutePage {...makeProps()} />);
    expect(markup).toContain("Vault");
  });

  it("lists stored secrets by name (not value)", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });
    expect(apiMocks.listCitadelVaultSecrets).toHaveBeenCalledWith("default");
    expect(treeString(renderer!)).toContain("stripe");
  });

  it("reveals a secret value only on request", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });
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
    await act(async () => {
      inputByPlaceholder(renderer!, "stripe-secret-key").props.onChange({ target: { value: "openai" } });
    });
    await act(async () => {
      inputByPlaceholder(renderer!, "sk-live-…").props.onChange({ target: { value: "sk-secret" } });
    });
    await act(async () => {
      buttonByLabel(renderer!, "Seal & store").props.onClick();
    });
    expect(apiMocks.storeCitadelVaultSecret).toHaveBeenCalledWith("default", "openai", "sk-secret");
  });

  // P0-4 governance/safety regression: deleting a Vault secret is irreversible, so the
  // row Delete must NOT call the API directly — it must route through the ConfirmModal.
  it("does not delete the secret directly when the row Delete is clicked", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });

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

    await act(async () => {
      deleteButtonFor(renderer!, "stripe").props.onClick();
    });
    expect(apiMocks.deleteCitadelVaultSecret).not.toHaveBeenCalled();

    await act(async () => {
      await deleteSecretModal(renderer!).props.onConfirm();
    });

    expect(apiMocks.deleteCitadelVaultSecret).toHaveBeenCalledTimes(1);
    expect(apiMocks.deleteCitadelVaultSecret).toHaveBeenCalledWith("default", "s1");
    // Confirming closes the modal again.
    expect(deleteSecretModal(renderer!).props.open).toBe(false);
  });

  it("cancelling the confirm modal leaves the secret untouched", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelVaultRoutePage {...makeProps()} />);
    });

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
