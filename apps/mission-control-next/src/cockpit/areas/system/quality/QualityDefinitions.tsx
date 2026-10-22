import type { PromptPackSecurityEvalPackRecord } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import {
  useBuiltinPromptPackImport,
  supportsBuiltinFirstImport,
} from "../../../../features/native-routes/ops/use-builtin-prompt-pack-import";
import { BuiltinPromptPackImportConfirmation } from "../../../../features/native-routes/ops/BuiltinPromptPackImportConfirmation";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { QualityNotes, usePromptPackQualityHref } from "./QualityEvidence";
import { EVAL_PACK_STATUS } from "../system-vocabulary";

export function QualityDefinitions({
  items,
  reload,
}: {
  items: PromptPackSecurityEvalPackRecord[];
  reload: () => Promise<unknown>;
}) {
  const promptPackHref = usePromptPackQualityHref();
  const action = useBuiltinPromptPackImport({ reload });
  return (
    <>
      <ul className="divide-y divide-line-subtle">
        {items.map((item) => {
          const state = action.stateFor(item.packKey);
          const present = item.importCapability?.targetState === "present" || state?.phase === "confirmed";
          return (
            <li key={item.packKey} className="space-y-2 py-3">
              <h3 className="text-sm font-medium text-fg">{item.title}</h3>
              <p className="text-sm text-fg-secondary">
                {EVAL_PACK_STATUS[item.status] ?? "Unknown status"} · {plural(item.testCount, "defined test")}
              </p>
              <QualityNotes items={item.blockers} />
              {present ? (
                <NativeOwnerLink
                  href={promptPackHref(item.importedPackId ?? item.importCapability?.packId)}
                  scope={JSON.stringify([item.packKey, item.importedPackId ?? item.importCapability?.packId])}
                  className="inline-block text-sm text-accent hover:underline"
                >
                  Inspect saved prompt pack
                </NativeOwnerLink>
              ) : (
                <Button
                  size="sm"
                  disabled={!supportsBuiltinFirstImport(item) || action.locked(item.packKey)}
                  onClick={() => void action.requestReview(item)}
                >
                  {state?.phase === "checking"
                    ? "Checking definition…"
                    : state?.phase === "saving"
                      ? "Importing definition…"
                      : `Review import: ${item.title}`}
                </Button>
              )}
              {!present && !supportsBuiltinFirstImport(item) ? (
                <p className="text-xs text-fg-muted">
                  GoatCitadel does not offer a safe first import for this definition.
                </p>
              ) : null}
              {present && item.status !== "imported" && state?.phase !== "confirmed" ? (
                <p className="text-xs text-fg-muted">
                  An existing pack uses this definition key. Its contents are preserved; this does not mean the pack has
                  been evaluated.
                </p>
              ) : null}
              {state?.message ? (
                <p role={state.phase === "uncertain" ? "alert" : "status"} className="text-sm text-fg-secondary">
                  {state.message}
                </p>
              ) : null}
              {state?.phase === "uncertain" ? (
                <NativeOwnerLink
                  href={promptPackHref(item.importCapability?.packId)}
                  scope={JSON.stringify([item.packKey, item.importCapability?.packId])}
                  className="inline-block text-sm text-accent hover:underline"
                >
                  Inspect definition import outcome
                </NativeOwnerLink>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-muted">Definitions are not run or scored quality checks.</p>
      {action.notice && !items.some((item) => action.stateFor(item.packKey)?.message === action.notice) ? (
        <p role="status" className="text-sm text-fg-secondary">
          {action.notice}
        </p>
      ) : null}
      <BuiltinPromptPackImportConfirmation action={action} />
    </>
  );
}
