import type { OutsideRootWriteMode } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
import type { WriteAccessReview } from "./FilesystemWriteAccessParts";
import { outsideRootWriteMode } from "./filesystem-write-access";
import type { FilesystemWriteAccess } from "./use-filesystem-write-access";

const ASK_CONSEQUENCE =
  "When Chat's fs.write, fs.patch, fs.copy, fs.move or file-output tools target a folder outside every write root, Chat asks you instead of failing. You can approve that one write, or open one offered folder for that tool for 15 minutes to 8 hours. Deletes outside the roots, GoatCitadel's own runtime folders, network shares and delegated sessions stay blocked, and deny rules and Citadel Wards still win.";

/**
 * The outside-root write mode: block writes outside every write root (the default), or let Chat ask
 * through an approval. Turning asking on is reviewed first; turning it off is saved directly and makes
 * existing folder grants inert.
 */
export function OutsideRootWriteModeControl({
  control,
  reviewOpen,
  onReview,
}: {
  control: FilesystemWriteAccess;
  reviewOpen: boolean;
  onReview: (review: WriteAccessReview) => void;
}) {
  const { settings, locked, submit, setNotice } = control;
  const revision = settings.data?.revision ?? 0;
  const mode = outsideRootWriteMode(settings.data);
  const asking = mode === "approval_required";

  async function save(next: OutsideRootWriteMode, baseRevision: number) {
    const outcome = await submit({ kind: "mode", mode: next }, baseRevision);
    if (outcome.kind === "rejected")
      setNotice({ tone: "failed", message: `The outside-root write setting was not saved. ${outcome.message}` });
    if (outcome.kind === "saved")
      setNotice({
        tone: "done",
        message:
          next === "approval_required"
            ? "Chat now asks before writing outside the write roots."
            : "Writes outside the write roots are blocked again. Folders opened from approvals stop working.",
      });
  }

  function change() {
    if (asking) {
      void save("deny", revision);
      return;
    }
    onReview({
      title: "Let Chat ask to write outside the write roots?",
      description: ASK_CONSEQUENCE,
      confirmLabel: "Let Chat ask",
      danger: true,
      revision,
      run: () => save("approval_required", revision),
    });
  }

  return (
    <section aria-labelledby="outside-root-writes-title" className="mt-5">
      <h4 id="outside-root-writes-title" className="text-sm font-semibold text-fg">
        Writes outside the write roots
      </h4>
      <p className="mt-1 text-sm text-fg-secondary">
        {asking
          ? "Chat asks first. An approval can allow one write or open one folder for a limited time."
          : "Blocked. Chat's filesystem tools fail when they target a folder outside every write root."}
      </p>
      <Button size="sm" className="mt-2" disabled={locked || reviewOpen} onClick={change}>
        {asking ? "Block outside-root writes" : "Let Chat ask instead"}
      </Button>
    </section>
  );
}
