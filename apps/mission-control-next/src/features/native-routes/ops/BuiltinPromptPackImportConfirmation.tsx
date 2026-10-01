import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import type { useBuiltinPromptPackImport } from "./use-builtin-prompt-pack-import";

export function BuiltinPromptPackImportConfirmation({ action }: { action: ReturnType<typeof useBuiltinPromptPackImport> }) {
  const definition = action.review?.definition;
  return <ConfirmModal open={Boolean(definition)} title="Import defensive definition?"
    message={`Create ${definition?.title ?? "this definition"} with ${definition?.testCount ?? 0} tests for this installation. An existing pack is preserved. Importing does not run evaluations, call providers, or score results.`}
    confirmLabel="Import reviewed definition" cancelLabel="Keep definitions unchanged" pending={action.pending}
    confirmDisabled={action.pending} onCancel={action.cancel} onConfirm={() => void action.confirm()} />;
}
