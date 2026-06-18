import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
