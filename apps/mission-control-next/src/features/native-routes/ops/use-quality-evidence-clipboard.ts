import { useEffect, useRef, useState } from "react";
import { exportOpsQualityEvidence } from "@goatcitadel/mission-control-shared/api/ops-quality";
import { exportLlmEvalProofRuns } from "@goatcitadel/mission-control-shared/api/platform";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

type ExportKind = "evaluations" | "quality" | "path";
type Notice = { error: boolean; text: string; generation: number };

/** Shared clipboard lifecycle; reads never become copy side effects after navigation. */
export function useQualityEvidenceClipboard({ includeFilename = false, scopeKey = "quality" } = {}) {
  const lifetime = useRef({ active: true, generation: 0, scopeKey });
  if (lifetime.current.scopeKey !== scopeKey) {
    lifetime.current.scopeKey = scopeKey;
    lifetime.current.generation += 1;
  }
  const lock = useRef<number | null>(null);
  const [pending, setPending] = useState<{ kind: ExportKind; generation: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    const activeLifetime = lifetime.current;
    activeLifetime.active = true;
    return () => {
      activeLifetime.active = false;
      activeLifetime.generation += 1;
    };
  }, []);
  const current = (generation: number) => lifetime.current.active && generation === lifetime.current.generation;

  async function write(kind: ExportKind, read: () => Promise<{ content: string; message: string }>) {
    const generation = lifetime.current.generation;
    if (!current(generation) || lock.current === generation) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setNotice({ generation, error: true, text: "Clipboard export is unavailable in this host." });
      return;
    }
    lock.current = generation;
    setPending({ kind, generation });
    setNotice(null);
    try {
      const result = await read();
      if (!current(generation)) return;
      await navigator.clipboard.writeText(result.content);
      if (current(generation)) setNotice({ generation, error: false, text: result.message });
    } catch (error) {
      if (current(generation))
        setNotice({ generation, error: true, text: `Evidence was not copied. ${describeApiError(error).summary}` });
    } finally {
      if (lock.current === generation) lock.current = null;
      if (current(generation)) setPending(null);
    }
  }
  const copy = (kind: "evaluations" | "quality") =>
    write(kind, async () => {
      const result =
        kind === "evaluations"
          ? await exportLlmEvalProofRuns(50)
          : await exportOpsQualityEvidence({ packLimit: 200, evalLimit: 25, format: "otel_json" });
      if (
        result.posture.readOnly !== true ||
        result.posture.sideEffectPosture !== "audit_only" ||
        typeof result.content !== "string"
      ) {
        throw new Error("The Gateway did not return a read-only evidence export.");
      }
      return {
        content: result.content,
        message: includeFilename
          ? `Copied ${kind === "evaluations" ? "eval proof export" : "Ops Quality OTel export"} ${result.filename}.`
          : kind === "evaluations"
            ? "Evaluation evidence copied."
            : "Quality transport evidence copied.",
      };
    });
  const copyPath = (path: string | undefined, packName: string) =>
    write("path", async () => {
      if (!path) throw new Error("No prompt-pack export path is recorded for the selected pack.");
      return { content: path, message: `Copied prompt-pack export path for ${packName}.` };
    });
  return {
    copy,
    copyPath,
    pending: pending && current(pending.generation) ? pending.kind : null,
    notice: notice && current(notice.generation) ? notice : null,
  };
}
