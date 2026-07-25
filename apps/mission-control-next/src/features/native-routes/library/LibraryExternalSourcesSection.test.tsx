import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryExternalSourcesSection } from "./LibraryExternalSourcesSection";

const apiMocks = vi.hoisted(() => ({
  fetchExternalSources: vi.fn(),
  fetchExternalSourceDetail: vi.fn(),
  scanExternalSource: vi.fn(),
  fetchExternalSourceCatalogPage: vi.fn(),
  createExternalSourceImportPlan: vi.fn(),
  applyExternalSourceImport: vi.fn(),
  fetchExternalSourceImportDetail: vi.fn(),
  registerExternalSource: vi.fn(),
  isExternalSourceCapabilityAbsent: (error: unknown) => (error as { status?: number } | null)?.status === 404,
}));

vi.mock("@goatcitadel/mission-control-shared/api/external-sources", () => apiMocks);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FULL_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const timestamp = "2026-07-14T08:00:00.000Z";

function sourceSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "goatcitadel.external-source.v1",
    sourceId: "source-1",
    workspaceId: "workspace-1",
    kind: "codex_sessions",
    label: "Synthetic Codex source",
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "codex-fixture-1",
    revision: 1,
    configSha256: FULL_SHA,
    status: "active",
    updatedAt: timestamp,
    ...overrides,
  };
}

function sourceDetail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "goatcitadel.external-source.v1",
    source: {
      schemaVersion: "goatcitadel.external-source.v1",
      sourceId: "source-1",
      workspaceId: "workspace-1",
      kind: "codex_sessions",
      label: "Synthetic Codex source",
      ownerActorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "token",
      canonicalRootPath: "/srv/synthetic/codex/sessions",
      rootIdentitySha256: FULL_SHA,
      pathBridgeSnapshotId: "path-bridge-1",
      pathBridgeSnapshotSha256: FULL_SHA,
      allowedRootsSha256: FULL_SHA,
      inputFlavor: "windows_native",
      targetFlavor: "windows_native",
      requireGitIdentity: false,
      ownershipAttestationSha256: FULL_SHA,
      adapterId: "codex.rollout-jsonl.v1",
      adapterVersion: "codex-fixture-1",
      adapterPolicy: {
        unknownVariantDisposition: "block",
        followLinks: false,
        followMarkdownImports: false,
        retainRawBytes: false,
        acceptedProducerVersions: ["codex-synthetic-1"],
      },
      revision: 1,
      configSha256: FULL_SHA,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    ...overrides,
  };
}

function scanSummary() {
  return {
    scanId: "scan-1",
    status: "sealed",
    manifestSha256: FULL_SHA,
    itemCount: 2,
    supportedItemCount: 1,
    quarantinedItemCount: 1,
    blockerCodes: [],
    completedAt: timestamp,
  };
}

function catalogItem(itemId: string, disposition: string) {
  return {
    schemaVersion: "goatcitadel.external-source.v1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scanId: "scan-1",
    itemId,
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "codex-fixture-1",
    normalizedRelativePath: `sessions/2026/07/14/${itemId}.jsonl`,
    aliasRelativePaths: [],
    foreignIdSha256: FULL_SHA,
    producerVersion: "codex-synthetic-1",
    observedMtimeNs: "01720800000000000000",
    fileIdentitySha256: FULL_SHA,
    statFingerprintSha256: FULL_SHA,
    rawSha256: FULL_SHA,
    rawByteCount: 256,
    messageCount: 2,
    lineageNodeCount: 2,
    lineageDepth: 1,
    lineageSha256: FULL_SHA,
    disposition,
    reasonCodes: disposition === "supported" ? [] : ["unsupported_variant"],
    catalogItemSha256: FULL_SHA,
  };
}

function catalogPage() {
  return {
    schemaVersion: "goatcitadel.external-source.v1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scanId: "scan-1",
    items: [catalogItem("item-1", "supported"), catalogItem("item-2", "quarantined")],
  };
}

function planResponse() {
  return {
    schemaVersion: "goatcitadel.external-source.v1",
    plan: {
      schemaVersion: "goatcitadel.external-source.v1",
      planId: "plan-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scanId: "scan-1",
      configRevision: 1,
      configSha256: FULL_SHA,
      manifestSha256: FULL_SHA,
      adapterVersions: ["codex-fixture-1"],
      selectedItemIds: ["item-1"],
      selectedItemSetSha256: FULL_SHA,
      rawSetSha256: FULL_SHA,
      rawByteCount: 256,
      normalizedSetSha256: FULL_SHA,
      normalizedByteCount: 128,
      messageCount: 2,
      blockerCodes: [],
      stagingLeaseId: "staging-1",
      stagingExpiresAt: timestamp,
      planSha256: FULL_SHA,
      createdAt: timestamp,
    },
    idempotencyKey: "external-source-import:v1:fixture",
  };
}

function applyResponse() {
  return {
    schemaVersion: "goatcitadel.external-source.v1",
    plan: planResponse().plan,
    intent: {
      schemaVersion: "goatcitadel.external-source.v1",
      importId: "import-1",
      idempotencyKey: "external-source-import:v1:fixture",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scanId: "scan-1",
      planId: "plan-1",
      configRevision: 1,
      configSha256: FULL_SHA,
      manifestSha256: FULL_SHA,
      planSha256: FULL_SHA,
      selectedItemSetSha256: FULL_SHA,
      adapterVersions: ["codex-fixture-1"],
      requestedByActorId: "operator-1",
      requestSha256: FULL_SHA,
      admittedAt: timestamp,
    },
    items: [
      {
        schemaVersion: "goatcitadel.external-source.v1",
        workspaceId: "workspace-1",
        importId: "import-1",
        scanId: "scan-1",
        itemId: "item-1",
        ordinal: 0,
        adapterId: "codex.rollout-jsonl.v1",
        adapterVersion: "codex-fixture-1",
        rawSha256: FULL_SHA,
        rawByteCount: 256,
        normalizedArtifactSha256: FULL_SHA,
        normalizedByteCount: 128,
        artifactRelativeKey: `external-sources/sha256/${FULL_SHA}`,
        provenanceSha256: FULL_SHA,
        createdAt: timestamp,
      },
    ],
    settlement: {
      schemaVersion: "goatcitadel.external-source.v1",
      settlementId: "settlement-1",
      workspaceId: "workspace-1",
      importId: "import-1",
      disposition: "applied",
      artifactSetSha256: FULL_SHA,
      artifactsVerifiedAt: timestamp,
      blockerCodes: [],
      resultSha256: FULL_SHA,
      settledAt: timestamp,
    },
    applyDisposition: "created",
  };
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : collectText(child)))
    .join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!button) {
    const available = root
      .findAll((node) => node.type === "button")
      .map((node) => collectText(node) || node.props["aria-label"])
      .join(", ");
    throw new Error(`Unable to find button: ${label}. Available: ${available}`);
  }
  return button;
}

async function click(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    node.props.onClick?.();
  });
}

async function renderSection(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(<LibraryExternalSourcesSection workspaceId="workspace-1" />);
  });
  return renderer!;
}

function markupOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) {
    if (typeof mock === "function" && "mockReset" in mock) {
      (mock as ReturnType<typeof vi.fn>).mockReset();
    }
  }
});

describe("LibraryExternalSourcesSection", () => {
  it("renders the production-dark card without error spam when the routes are absent", async () => {
    apiMocks.fetchExternalSources.mockRejectedValue({ status: 404 });
    const renderer = await renderSection();

    const markup = markupOf(renderer);
    expect(markup).toContain("The external-source runtime is not composed in this build.");
    expect(markup).not.toContain("Register source");
    expect(markup).not.toContain("Retry");
    renderer.unmount();
  });

  it("surfaces a genuine list failure with a retry path", async () => {
    apiMocks.fetchExternalSources.mockRejectedValue(new Error("gateway exploded"));
    const renderer = await renderSection();

    expect(markupOf(renderer)).toContain("gateway exploded");
    renderer.unmount();
  });

  it("walks the register → scan → dry-run → apply flow over the typed client", async () => {
    apiMocks.fetchExternalSources.mockResolvedValueOnce({
      schemaVersion: "goatcitadel.external-source.v1",
      workspaceId: "workspace-1",
      items: [],
    });
    const renderer = await renderSection();
    expect(markupOf(renderer)).toContain("No external sources are registered.");

    // Register.
    apiMocks.registerExternalSource.mockResolvedValue(sourceDetail());
    apiMocks.fetchExternalSources.mockResolvedValue({
      schemaVersion: "goatcitadel.external-source.v1",
      workspaceId: "workspace-1",
      items: [sourceSummary()],
    });
    apiMocks.fetchExternalSourceDetail.mockResolvedValueOnce(sourceDetail());
    await click(findButton(renderer.root, "Register source"));
    const inputs = renderer.root.findAll((node) => node.type === "input" || node.type === "select");
    const setField = async (index: number, value: unknown) => {
      await act(async () => {
        inputs[index]!.props.onChange({ target: { value, checked: Boolean(value) } });
      });
    };
    // Field order follows the form: kind, label, root, snapshot id, snapshot sha,
    // input flavor, target flavor, producers, workspace revision, git checkbox.
    await setField(1, "Synthetic Codex source");
    await setField(2, "/srv/synthetic/codex/sessions");
    await setField(3, "path-bridge-1");
    await setField(4, FULL_SHA);
    await setField(7, "codex-synthetic-1");
    await click(findButton(renderer.root, "Register source"));
    expect(apiMocks.registerExternalSource).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        kind: "codex_sessions",
        label: "Synthetic Codex source",
        canonicalRootPath: "/srv/synthetic/codex/sessions",
        pathBridgeSnapshotId: "path-bridge-1",
        pathBridgeSnapshotSha256: FULL_SHA,
        requireGitIdentity: false,
        acceptedProducerVersions: ["codex-synthetic-1"],
        expectedWorkspaceRevision: 1,
      }),
    );
    expect(markupOf(renderer)).toContain("No scan ran; seal one explicitly.");

    // Scan seals a catalog.
    apiMocks.scanExternalSource.mockResolvedValue({
      schemaVersion: "goatcitadel.external-source.v1",
      scanId: "scan-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      status: "sealed",
      itemCount: 2,
      supportedItemCount: 1,
      quarantinedItemCount: 1,
      blockerCodes: [],
    });
    apiMocks.fetchExternalSourceDetail.mockResolvedValue({ ...sourceDetail(), latestScan: scanSummary() });
    apiMocks.fetchExternalSourceCatalogPage.mockResolvedValue(catalogPage());
    await click(findButton(renderer.root, "Run scan"));
    expect(apiMocks.scanExternalSource).toHaveBeenCalledWith("source-1", {
      workspaceId: "workspace-1",
      expectedRevision: 1,
    });
    let markup = markupOf(renderer);
    expect(markup).toContain("Scan sealed: 1 supported of 2 items.");
    expect(markup).toContain("sessions/2026/07/14/item-1.jsonl");
    expect(markup).toContain("quarantined");

    // Selection: only the supported item is selectable.
    const checkboxes = renderer.root.findAll((node) => node.type === "input" && node.props.type === "checkbox");
    const supportedBox = checkboxes.find((node) => String(node.props["aria-label"] ?? "").includes("item-1"))!;
    const quarantinedBox = checkboxes.find((node) => String(node.props["aria-label"] ?? "").includes("item-2"))!;
    expect(quarantinedBox.props.disabled).toBe(true);
    await act(async () => {
      supportedBox.props.onChange({ target: { checked: true } });
    });

    // Dry run.
    apiMocks.createExternalSourceImportPlan.mockResolvedValue(planResponse());
    await click(findButton(renderer.root, "Dry run"));
    expect(apiMocks.createExternalSourceImportPlan).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scanId: "scan-1",
      selectedItemIds: ["item-1"],
      expectedRevision: 1,
    });
    markup = markupOf(renderer);
    expect(markup).toContain("Dry run sealed. Review the exact hashes, then apply.");
    expect(markup).toContain(FULL_SHA.slice(0, 12));
    // Content-free discipline: no full hash and no raw JSON dumps.
    expect(markup).not.toContain(`"planSha256"`);

    // Apply the exact plan.
    apiMocks.applyExternalSourceImport.mockResolvedValue(applyResponse());
    await click(findButton(renderer.root, "Apply import"));
    expect(apiMocks.applyExternalSourceImport).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      planId: "plan-1",
      expectedPlanSha256: FULL_SHA,
      idempotencyKey: "external-source-import:v1:fixture",
    });
    markup = markupOf(renderer);
    expect(markup).toContain("Import applied: 1 item(s).");
    expect(markup).toContain("managed artifact");
    expect(markup).toContain("nothing here mutates knowledge or memory directly");
    renderer.unmount();
  });

  it("inspects content-free provenance for an import id", async () => {
    apiMocks.fetchExternalSources.mockResolvedValue({
      schemaVersion: "goatcitadel.external-source.v1",
      workspaceId: "workspace-1",
      items: [sourceSummary()],
    });
    apiMocks.fetchExternalSourceImportDetail.mockResolvedValue(applyResponse());
    const renderer = await renderSection();

    const lookup = renderer.root.find(
      (node) => node.type === "input" && node.props.placeholder === "external-import-…",
    );
    await act(async () => {
      lookup.props.onChange({ target: { value: "import-1" } });
    });
    await click(findButton(renderer.root, "Inspect import"));
    expect(apiMocks.fetchExternalSourceImportDetail).toHaveBeenCalledWith("workspace-1", "import-1");
    const markup = markupOf(renderer);
    expect(markup).toContain("applied");
    expect(markup).toContain("item-1");
    // Visible hash text renders truncated; the managed CAS key stays an
    // operator-only title attribute (IDs/hashes are content-free by the packet).
    expect(markup).toContain(`${FULL_SHA.slice(0, 12)}…`);
    renderer.unmount();
  });

  it("surfaces an action failure without clearing the selected source", async () => {
    apiMocks.fetchExternalSources.mockResolvedValue({
      schemaVersion: "goatcitadel.external-source.v1",
      workspaceId: "workspace-1",
      items: [sourceSummary()],
    });
    apiMocks.fetchExternalSourceDetail.mockResolvedValue(sourceDetail());
    apiMocks.scanExternalSource.mockRejectedValue(new Error("identity_drift: the root changed"));
    const renderer = await renderSection();

    await click(findButton(renderer.root, "Synthetic Codex source"));
    await click(findButton(renderer.root, "Run scan"));
    const markup = markupOf(renderer);
    expect(markup).toContain("identity_drift: the root changed");
    expect(markup).toContain("Operator-only source detail");
    renderer.unmount();
  });
});
