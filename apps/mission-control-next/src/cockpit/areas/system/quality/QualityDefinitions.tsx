import type { PromptPackSecurityEvalPackRecord } from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useBuiltinPromptPackImport, supportsBuiltinFirstImport } from "../../../../features/native-routes/ops/use-builtin-prompt-pack-import";
import { BuiltinPromptPackImportConfirmation } from "../../../../features/native-routes/ops/BuiltinPromptPackImportConfirmation";
import { Button } from "../../../ui/Button";
import { ClassicOwnerLink } from "../../../ui/ClassicOwnerLink";
import { QualityNotes, promptPackQualityHref } from "./QualityEvidence";

export function QualityDefinitions({ items, reload }: { items: PromptPackSecurityEvalPackRecord[]; reload: () => Promise<unknown> }) {
  const action = useBuiltinPromptPackImport({ reload });
  return <>
    <ul className="space-y-3">{items.map((item) => {
      const state = action.stateFor(item.packKey);
      const present = item.importCapability?.targetState === "present" || state?.phase === "confirmed";
      return <li key={item.packKey} className="space-y-2 rounded-md border border-line-subtle p-3">
        <h3 className="text-sm font-medium text-fg">{item.title}</h3>
        <p className="text-sm text-fg-secondary">{humanizeToken(item.status)} · {item.testCount} defined tests</p>
        <QualityNotes items={item.blockers} />
        {present ? <ClassicOwnerLink href={promptPackQualityHref(item.importedPackId ?? item.importCapability?.packId)} scope={JSON.stringify([item.packKey, item.importedPackId ?? item.importCapability?.packId])} className="inline-block text-sm text-accent hover:underline" label="Inspect saved prompt pack" />
          : <Button size="sm" disabled={!supportsBuiltinFirstImport(item) || action.locked(item.packKey)} onClick={() => void action.requestReview(item)}>
            {state?.phase === "checking" ? "Checking definition…" : state?.phase === "saving" ? "Importing definition…" : `Review import: ${item.title}`}
          </Button>}
        {!present && !supportsBuiltinFirstImport(item) ? <p className="text-xs text-fg-muted">This Gateway has not advertised a safe first import for this definition.</p> : null}
        {present && item.status !== "imported" && state?.phase !== "confirmed" ? <p className="text-xs text-fg-muted">An existing pack uses this definition key. Its contents are preserved; occupancy does not establish defensive evaluation evidence.</p> : null}
        {state?.message ? <p role={state.phase === "uncertain" ? "alert" : "status"} className="text-sm text-fg-secondary">{state.message}</p> : null}
        {state?.phase === "uncertain" ? <ClassicOwnerLink href={promptPackQualityHref(item.importCapability?.packId)} scope={JSON.stringify([item.packKey, item.importCapability?.packId])} className="inline-block text-sm text-accent hover:underline" label="Inspect definition import outcome" /> : null}
      </li>;
    })}</ul>
    <p className="text-xs text-fg-muted">Definitions do not establish executed or scored quality evidence.</p>
    {action.notice && !items.some((item) => action.stateFor(item.packKey)?.message === action.notice) ? <p role="status" className="text-sm text-fg-secondary">{action.notice}</p> : null}
    <BuiltinPromptPackImportConfirmation action={action} />
  </>;
}
