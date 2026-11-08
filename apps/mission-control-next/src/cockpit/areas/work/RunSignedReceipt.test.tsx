// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  fetchEvidenceReceipt,
  verifyEvidenceReceipt,
  type EvidenceReceipt,
} from "@goatcitadel/mission-control-shared/api/client";
import { RunSignedReceipt } from "./RunSignedReceipt";

vi.mock(import("@goatcitadel/mission-control-shared/api/client"), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchEvidenceReceipt: vi.fn(),
  verifyEvidenceReceipt: vi.fn(),
}));

const runId = "run-a";
const receipt: EvidenceReceipt = {
  manifest: {
    schemaVersion: "evidence-receipt.v1",
    runId,
    generatedAt: "2026-09-29T12:00:00.000Z",
    lineage: {
      runId,
      workflowKey: "chat.turn.execute",
      status: "completed",
      attemptCount: 1,
      maxAttempts: 3,
      outcome: "succeeded",
      createdAt: "2026-09-29T11:00:00.000Z",
      updatedAt: "2026-09-29T12:00:00.000Z",
    },
    approvalEffects: [],
    sideEffects: [],
    artifacts: [],
    notes: [],
  },
  contentHash: "a".repeat(64),
  hashAlgorithm: "sha256",
  signatureAlgorithm: "ed25519",
  signature: "signature",
  publicKey: "public-key",
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
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
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
    expect(container.textContent).toContain("GoatCitadel reported no integrity failures");
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
    vi.mocked(fetchEvidenceReceipt).mockResolvedValue({
      ...receipt,
      manifest: { ...receipt.manifest, runId: "run-b" },
    });
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
    expect(container.textContent).not.toContain("GoatCitadel reported no integrity failures");
  });

  it("does not imply integrity when Gateway rejects a receipt without a reason", async () => {
    vi.mocked(verifyEvidenceReceipt).mockResolvedValue({ valid: false, reasons: [] });
    await act(async () => root.render(<RunSignedReceipt runId={runId} />));
    await act(async () => clickButton("Inspect signed receipt"));
    expect(container.textContent).toContain("Do not rely on this receipt");
    expect(container.textContent).not.toContain("no integrity failures");
  });

  it.each([
    "OS keychain is unavailable, so the Evidence Receipt signing key cannot be loaded or created on this host.",
    "Evidence Receipt signing has no key store on this host yet, so new receipts cannot be built.",
  ])("explains when the isolated host cannot create a signing key (%s)", async (error) => {
    vi.mocked(fetchEvidenceReceipt).mockRejectedValue(
      new ApiRequestError("API error 503", {
        kind: "http",
        method: "POST",
        path: `/api/v1/runs/${runId}/evidence-receipt`,
        status: 503,
        body: { error },
      }),
    );
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
