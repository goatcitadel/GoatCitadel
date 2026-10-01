import type { ChannelSetupRichBlock, ChannelSetupStepDefinition } from "@goatcitadel/contracts";
import type { ChannelSetupWizardFeedback } from "../../../features/native-routes/settings/channel-setup/channel-wizard-model";

export function ChannelRichBlocks({ blocks = [] }: { blocks?: ChannelSetupRichBlock[] }) {
  return (
    <div className="space-y-2 text-sm text-fg-secondary">
      {blocks.map((block, index) => {
        if (block.kind === "paragraph") return <p key={index}>{block.text}</p>;
        if (block.kind === "note")
          return (
            <aside key={index} className="rounded-md border border-line p-3">
              <strong className="text-fg">{block.title}</strong>
              <p>{block.text}</p>
            </aside>
          );
        if (block.kind === "code")
          return (
            <pre key={index} className="max-w-full overflow-auto rounded-md bg-canvas p-3 text-xs">
              <code>{block.code}</code>
            </pre>
          );
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={index} className={`ml-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
              {block.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </List>
          );
        }
        const safe = /^https?:\/\//iu.test(block.href);
        return safe ? (
          <a
            key={index}
            className="inline-block break-all text-accent underline"
            href={block.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {block.label}
          </a>
        ) : (
          <span key={index}>{block.label} (link unavailable)</span>
        );
      })}
    </div>
  );
}
export function ChannelStepHelp({ step }: { step: ChannelSetupStepDefinition }) {
  return (
    <>
      {step.successCriteria?.length ? (
        <section aria-label="Ready when" className="text-sm">
          <h4 className="font-medium">Ready when</h4>
          <ul className="ml-5 list-disc">
            {step.successCriteria.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {step.troubleshooting?.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer">Troubleshooting</summary>
          <div className="mt-2 space-y-3">
            {step.troubleshooting.map((item) => (
              <section key={item.id}>
                <h4 className="font-medium">{item.title}</h4>
                <p>{item.body}</p>
                <ul className="ml-5 list-disc">
                  {item.nextSteps?.map((next) => (
                    <li key={next}>{next}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}
export function ChannelFeedback({
  feedback,
  error,
}: {
  feedback?: ChannelSetupWizardFeedback | null;
  error?: string | null;
}) {
  return (
    <>
      {error ? (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      ) : null}
      {feedback ? (
        <section aria-label="Channel check result" className="space-y-2 rounded-md border border-line p-3 text-sm">
          <h4 className="font-medium">
            {feedback.kind === "test" ? "Live test" : "Validation"}: {feedback.status}
          </h4>
          <ul className="space-y-1">
            {feedback.issues.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
          {feedback.probe ? (
            <section aria-label="Live connection probe">
              <h5 className="font-medium">Live connection probe</h5>
              <ul className="space-y-2">
                {feedback.probe.steps.map((step) => (
                  <li key={step.key}>
                    <strong>{step.label}</strong> · {step.status}
                    <p>{step.message}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {feedback.recommendedNextAction ? <p>Next: {feedback.recommendedNextAction}</p> : null}
        </section>
      ) : null}
    </>
  );
}
