import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddonCatalogEntry, AddonInstalledRecord, AddonStatusRecord } from "@goatcitadel/contracts";

const apiMocks = vi.hoisted(() => ({
  fetchAddonsCatalog: vi.fn(),
  fetchInstalledAddons: vi.fn(),
  fetchAddonStatus: vi.fn(),
  installAddon: vi.fn(),
  updateAddon: vi.fn(),
  launchAddon: vi.fn(),
  stopAddon: vi.fn(),
  uninstallAddon: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchAddonsCatalog: apiMocks.fetchAddonsCatalog,
  fetchInstalledAddons: apiMocks.fetchInstalledAddons,
  fetchAddonStatus: apiMocks.fetchAddonStatus,
  installAddon: apiMocks.installAddon,
  updateAddon: apiMocks.updateAddon,
  launchAddon: apiMocks.launchAddon,
  stopAddon: apiMocks.stopAddon,
  uninstallAddon: apiMocks.uninstallAddon,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "__apiRequestError" in error),
}));
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title, subtitle, actions }: { title?: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));
vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: ({ what, when }: { what?: string; when?: string }) => (
    <section>
      <div>{what}</div>
      <div>{when}</div>
    </section>
  ),
}));
vi.mock("../components/ActionButton", () => ({
  ActionButton: ({ label, onClick, disabled }: { label: string; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onClick}>{label}</button>
  ),
}));
vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({ open, title, message }: { open?: boolean; title?: string; message?: string }) => (
    open ? <div>{title}{message}</div> : null
  ),
}));
vi.mock("../components/HelpHint", () => ({
  HelpHint: ({ label, text }: { label?: string; text?: string }) => <span>{label}{text}</span>,
}));
vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({
    primary,
    inspector,
    emptyInspector,
  }: {
    primary?: React.ReactNode;
    inspector?: React.ReactNode;
    emptyInspector?: React.ReactNode;
  }) => <div>{primary}{inspector ?? emptyInspector}</div>,
}));
vi.mock("../components/ui/GCEmptyState", () => ({
  GCEmptyState: ({
    title,
    subtitle,
    action,
    meta,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    action?: React.ReactNode;
    meta?: React.ReactNode;
  }) => <div>{title}{subtitle}{action}{meta}</div>,
}));

import { AddonsPage } from "./AddonsPage";

function makeAddon(overrides: Partial<AddonCatalogEntry> = {}): AddonCatalogEntry {
  return {
    addonId: "arena",
    label: "Arena",
    description: "Optional add-on.",
    owner: "GoatCitadel",
    repoUrl: "https://github.com/goatcitadel/arena",
    sameOwnerAsGoatCitadel: true,
    trustTier: "trusted",
    category: "fun_optional",
    runtimeType: "separate_repo_app",
    installCommands: [{ command: "pnpm", args: ["install"] }],
    webEntryMode: "external_local_url",
    requiresSeparateRepoDownload: true,
    launchUrl: "http://127.0.0.1:4173",
    healthChecks: [
      {
        key: "manifest",
        status: "pass",
        message: "Manifest loaded.",
      },
    ],
    ...overrides,
  };
}

function makeInstalled(addon: AddonCatalogEntry, overrides: Partial<AddonInstalledRecord> = {}): AddonInstalledRecord {
  return {
    addonId: addon.addonId,
    installedPath: `~/.GoatCitadel/addons/${addon.addonId}`,
    repoUrl: addon.repoUrl,
    owner: addon.owner,
    sameOwnerAsGoatCitadel: addon.sameOwnerAsGoatCitadel,
    trustTier: addon.trustTier,
    runtimeType: addon.runtimeType,
    webEntryMode: addon.webEntryMode,
    launchUrl: addon.launchUrl,
    installedAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    consentedAt: "2026-03-10T00:00:00.000Z",
    consentedBy: "operator",
    runtimeStatus: "running",
    ...overrides,
  };
}

function makeStatus(addon: AddonCatalogEntry, overrides: Partial<AddonStatusRecord> = {}): AddonStatusRecord {
  return {
    addon,
    installed: makeInstalled(addon),
    status: "running",
    healthChecks: addon.healthChecks,
    ...overrides,
  };
}

function makeNetworkError(path: string) {
  return {
    __apiRequestError: true,
    kind: "network",
    method: "GET",
    path,
    message: `Network error GET ${path}: Failed to fetch`,
  };
}

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root.find((candidate) => {
    if (candidate.type !== "button") {
      return false;
    }
    return collectText(candidate.props.children as ReactTestRendererJSON | ReactTestRendererJSON[] | string | null)
      .replace(/\s+/g, " ")
      .trim() === label;
  });
  await act(async () => {
    button.props.onClick?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
  });
}

describe("AddonsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows retry guidance for transient catalog fetch failures and recovers on retry", async () => {
    const arena = makeAddon();
    apiMocks.fetchAddonsCatalog
      .mockRejectedValueOnce(makeNetworkError("/api/v1/addons/catalog"))
      .mockResolvedValueOnce({ items: [arena] });
    apiMocks.fetchInstalledAddons
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] });
    apiMocks.fetchAddonStatus.mockResolvedValueOnce(makeStatus(arena, { installed: undefined }));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AddonsPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Add-ons data could not be loaded because the browser lost contact with the gateway.");
      expect(rendererText(renderer)).toContain("Retry");

      await clickButton(renderer, "Retry");
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Arena");
      expect(text).not.toContain("Add-ons data could not be loaded because the browser lost contact with the gateway.");
    } finally {
      renderer.unmount();
    }
  });

  it("keeps catalog content visible when some status refreshes fail", async () => {
    const arena = makeAddon();
    const forge = makeAddon({
      addonId: "forge",
      label: "Forge",
      repoUrl: "https://github.com/goatcitadel/forge",
      launchUrl: "http://127.0.0.1:4273",
    });

    apiMocks.fetchAddonsCatalog.mockResolvedValue({ items: [arena, forge] });
    apiMocks.fetchInstalledAddons.mockResolvedValue({ items: [] });
    apiMocks.fetchAddonStatus
      .mockResolvedValueOnce(makeStatus(arena, { installed: undefined }))
      .mockRejectedValueOnce(new Error("status refresh failed"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AddonsPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Arena");
      expect(text).toContain("Forge");
      expect(text).toContain("Some add-on readiness checks could not be refreshed (1/2).");
    } finally {
      renderer.unmount();
    }
  });
});
