// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchEvidenceReceipt,
  isApiRequestError,
  verifyEvidenceReceipt,
  type EvidenceReceipt,
} from "@goatcitadel/mission-control-shared/api/client";
import { RunSignedReceipt } from "./RunSignedReceipt";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchEvidenceReceipt: vi.fn(),
  isApiRequestError: vi.fn(() => false),
  verifyEvidenceReceipt: vi.fn(),
}));

const runId = "run-a";
const receipt: EvidenceReceipt = {
  manifest: {
    schemaVersion: "evidence-receipt.v1",
    runId,
    generatedAt: "2026-09-29T12:00:00.000Z",
    lineage: {
      runId, workflowKey: "chat.turn.execute", status: "completed", attemptCount: 1,
      maxAttempts: 3, outcome: "succeeded", createdAt: "2026-09-29T11:00:00.000Z",
      updatedAt: "2026-09-29T12:00:00.000Z",
    },
    approvalEffects: [], sideEffects: [], artifacts: [], notes: [],
  },
  contentHash: "a".repeat(64), hashAlgorithm: "sha256", signatureAlgorithm: "ed25519",
  signature: "signature", publicKey: "public-key",
};

let container: HTMLDivElement;
let root: Root;
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(fetchEvidenceReceipt).mockResolvedValue(receipt);
  vi.mocked(isApiRequestError).mockReturnValue(false);
  vi.mocked(verifyEvidenceReceipt).mockResolvedValue({ valid: true, reasons: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});

function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  button.click();
}

describe("Work signed evidence receipt", () => {
  it("requests and verifies the exact run only after inspection, then exposes a portable download", async () => {
    await act(async () => root.render(<RunSignedReceipt runId={runId} />));
    expect(fetchEvidenceReceipt).not.toHaveBeenCalled();
    await act(async () => clickButton("Inspect signed receipt"));
    expect(fetchEvidenceReceipt).toHaveBeenCalledWith(runId);
    expect(verifyEvidenceReceipt).toHaveBeenCalledWith(receipt);
    expect(container.textContent).toContain("Signature valid");
    expect(container.textContent).toContain("The Gateway reported no integrity failures");
    expect(container.textContent).toContain("Download inspected receipt");

    const createObjectURL = vi.fn().mockReturnValue("blob:receipt");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => clickButton("Download inspected receipt"));
    expect(clicked).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:receipt");
    expect(container.textContent).toContain("Downloaded the inspected receipt");
  });

  it("withholds verification and download for a receipt bound to another run", async () => {
    vi.mocked(fetchEvidenceReceipt).mockResolvedValue({ ...receipt, manifest: { ...receipt.manifest, runId: "run-b" } });
    await act(async () => root.render(<RunSignedReceipt runId={runId} />));
    await act(async () => clickButton("Inspect signed receipt"));
    expect(container.textContent).toContain("receipt for another run");
    expect(verifyEvidenceReceipt).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Download inspected receipt");
  });

  it("presents a failed Gateway signature verdict as untrusted", async () => {
    vi.mocked(verifyEvidenceReceipt).mockResolvedValue({ valid: false, reasons: ["Signature mismatch"] });
    await act(async () => root.render(<RunSignedReceipt runId={runId} />));
    await act(async () => clickButton("Inspect signed receipt"));
    expect(container.textContent).toContain("Verification failed");
    expect(container.textContent).toContain("Untrusted");
    expect(container.textContent).toContain("Signature mismatch");
    expect(container.textContent).not.toContain("The Gateway reported no integrity failures");
  });

  it("does not imply integrity when Gateway rejects a receipt without a reason", async () => {
    vi.mocked(verifyEvidenceReceipt).mockResolvedValue({ valid: false, reasons: [] });
    await act(async () => root.render(<RunSignedReceipt runId={runId} />));
    await act(async () => clickButton("Inspect signed receipt"));
    expect(container.textContent).toContain("Do not rely on this receipt");
    expect(container.textContent).not.toContain("no integrity failures");
  });

  it("explains when the isolated host cannot create a signing key", async () => {
    vi.mocked(fetchEvidenceReceipt).mockRejectedValue({
      status: 503,
      body: { error: "OS keychain is unavailable, so the Evidence Receipt signing key cannot be loaded or created on this host." },
    });
    vi.mocked(isApiRequestError).mockReturnValue(true);
    await act(async () => root.render(<RunSignedReceipt runId={runId} />));
    await act(async () => clickButton("Inspect signed receipt"));
    expect(container.textContent).toContain("OS keychain is unavailable");
    expect(container.textContent).toContain("Existing receipts can still be verified offline");
    expect(container.textContent).not.toContain("Inspect to see signature");
    expect(verifyEvidenceReceipt).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Signature valid");
    expect(container.textContent).not.toContain("Download inspected receipt");
  });
});
