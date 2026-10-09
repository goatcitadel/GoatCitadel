import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useRef, useState } from "react";
import {
  fetchEvidenceReceipt,
  isApiRequestError,
  verifyEvidenceReceipt,
  type EvidenceReceipt,
  type EvidenceReceiptVerification,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";

interface Inspection {
  receipt: EvidenceReceipt;
  verification: EvidenceReceiptVerification;
}

export function RunSignedReceipt({ runId }: { runId: string }) {
  const loading = useRef(false);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const inspect = async () => {
    if (loading.current) return;
    loading.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setInspection(null);
    try {
      const receipt = await fetchEvidenceReceipt(runId);
      if (receipt.manifest.runId !== runId || receipt.manifest.lineage.runId !== runId) {
        throw new Error("The Gateway returned a receipt for another run.");
      }
      const verification = await verifyEvidenceReceipt(receipt);
      setInspection({ receipt, verification });
    } catch (cause) {
      const responseError = isApiRequestError(cause) && cause.status === 503 && cause.body && typeof cause.body === "object"
        ? (cause.body as { error?: unknown }).error
        : undefined;
      setError(typeof responseError === "string" && responseError.startsWith("OS keychain is unavailable, so the Evidence Receipt signing key")
        ? "This host cannot build a signed receipt because its OS keychain is unavailable. Existing receipts can still be verified offline."
        : describeApiError(cause).summary);
    } finally {
      loading.current = false;
      setBusy(false);
    }
  };

  const download = () => {
    if (!inspection) return;
    if (typeof URL.createObjectURL !== "function") {
      setError("Receipt download is unavailable in this environment.");
      return;
    }
    let objectUrl: string | null = null;
    try {
      const filename = `evidence-receipt-${runId}.json`;
      objectUrl = URL.createObjectURL(new Blob([JSON.stringify(inspection.receipt, null, 2)], {
        type: "application/json",
      }));
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setError(null);
      setNotice(`Downloaded the inspected receipt as ${filename}.`);
    } catch (cause) {
      setError(describeApiError(cause).summary);
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  };

  const { receipt, verification } = inspection ?? {};
  return <section aria-label="Signed evidence receipt" className="rounded-lg border border-line bg-raised p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-display text-lg font-semibold text-fg">Signed evidence receipt</h2>
        <p className="mt-1 text-sm text-fg-muted">Build and verify a portable snapshot of this run through the Gateway.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void inspect()} disabled={busy}>
          {busy ? "Verifying receipt…" : "Inspect signed receipt"}
        </Button>
        {inspection ? <Button size="sm" onClick={download}>Download inspected receipt</Button> : null}
      </div>
    </div>
    {busy ? <p role="status" className="mt-3 text-sm text-fg-muted">Checking the Gateway signature…</p> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-status-failed">{error}</p> : null}
    {notice ? <p role="status" className="mt-3 text-sm text-status-done">{notice}</p> : null}
    {receipt && verification ? <div className="mt-4 grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line-subtle bg-sunken p-3">
        <p className="text-sm font-medium text-fg">{verification.valid ? "Signature valid" : "Verification failed"}</p>
        <StatusBadge status={{ label: verification.valid ? "Verified" : "Untrusted", tone: verification.valid ? "done" : "failed" }} />
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-fg-muted">Outcome</dt><dd className="font-medium text-fg">{humanizeToken(receipt.manifest.lineage.outcome)}</dd></div>
        <div><dt className="text-fg-muted">Approval effects</dt><dd className="font-medium text-fg">{receipt.manifest.approvalEffects.length}</dd></div>
        <div><dt className="text-fg-muted">Side effects</dt><dd className="font-medium text-fg">{receipt.manifest.sideEffects.length}</dd></div>
        <div><dt className="text-fg-muted">Artifacts</dt><dd className="font-medium text-fg">{receipt.manifest.artifacts.length}</dd></div>
      </dl>
      <p className="text-xs text-fg-muted">Generated {receipt.manifest.generatedAt} · {receipt.signatureAlgorithm} signature</p>
      {verification.reasons.length ? <ul className="list-disc pl-5 text-sm text-status-failed">{verification.reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ul>
        : verification.valid ? <p className="text-sm text-fg-secondary">The Gateway reported no integrity failures for this receipt.</p>
          : <p className="text-sm text-status-failed">The Gateway did not provide a verification reason. Do not rely on this receipt.</p>}
      <TechnicalDetails label="Receipt technical details">
        <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-line-subtle bg-sunken p-3 text-xs">{JSON.stringify(receipt, null, 2)}</pre>
      </TechnicalDetails>
    </div> : !busy && !error ? <p className="mt-3 text-sm text-fg-muted">Inspect to see signature, lineage, effects, and artifact counts.</p> : null}
  </section>;
}
