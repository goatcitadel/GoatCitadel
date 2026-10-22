import { useState } from "react";
import type { IntegrationConfigurationGuidance } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";

/** Author guidance only. Accepted fields and credential custody belong to the existing Gateway editor. */
export function ExtensionConfigurationGuidance({ guidance }: { guidance?: IntegrationConfigurationGuidance }) {
  const [copyStatus, setCopyStatus] = useState("");
  if (!guidance) return null;
  if (guidance.form.version !== "goatcitadel.extension-configuration.v1") {
    return (
      <p role="status">
        This extension's setup guidance version is unsupported. Use the connector's existing setup fields or update the
        extension.
      </p>
    );
  }
  const { form } = guidance;
  async function copySample() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(form.sampleTask!.prompt);
      setCopyStatus("Sample copied. Review it in Chat before sending; permissions and approvals still apply.");
    } catch {
      setCopyStatus("Copy is unavailable. Select the sample text and copy it manually.");
    }
  }
  return (
    <details className="space-y-3 border-t border-line-subtle pt-3">
      <summary className="min-h-9 cursor-pointer font-medium">Extension setup guidance · {guidance.pluginId}</summary>
      <p className="break-words text-sm text-fg-secondary">
        Author guidance from {guidance.pluginId} {guidance.pluginVersion}. This does not enable tools or change
        permissions. Existing connector fields, validation, defaults and saved settings remain authoritative.
      </p>
      {form.prerequisites?.length ? (
        <section aria-label="Extension prerequisites" className="space-y-2">
          <h5 className="font-medium">Before setup</h5>
          <ul className="list-inside list-disc space-y-1 text-sm">
            {form.prerequisites.map((item, index) => (
              <li className="break-words" key={index}>
                {item}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {form.fields.length ? (
        <dl className="space-y-3">
          {form.fields.map((field) => (
            <div key={field.key} className="min-w-0 text-sm">
              <dt className="break-words font-medium">
                {field.label}
                {field.required ? " · required by author" : ""}
              </dt>
              <dd className="space-y-1 break-words text-fg-secondary">
                {field.help ? <p>{field.help}</p> : null}
                <p>
                  Configuration key: <code className="break-all">{field.key}</code>.{" "}
                  {guidance.supportedFieldKeys.includes(field.key)
                    ? "Use the matching field in this editor."
                    : "Use the connector's supported setup controls for this requirement; this guidance adds no input field."}
                </p>
                {field.kind === "secret_ref" ? (
                  <p>
                    {field.referenceKind === "environment"
                      ? "Environment reference: provide only a variable name through the supported setup, never the secret value."
                      : "Credential reference: use the supported secure credential setup; do not paste a credential into general configuration or Chat."}
                  </p>
                ) : null}
                {field.kind === "choice" ? (
                  <p>
                    Author suggestions: {field.choices.map((choice) => choice.label).join(", ")}. The connector
                    determines accepted values.
                  </p>
                ) : null}
                {"defaultValue" in field && field.defaultValue !== undefined ? (
                  <p>The author declares a suggested default. It is not applied to this form or saved settings.</p>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {form.sampleTask ? (
        <section aria-label="Extension sample task" className="space-y-2">
          <h5 className="font-medium">Review a sample task</h5>
          <p className="break-words rounded-md border border-line-subtle p-2 text-sm">{form.sampleTask.prompt}</p>
          <p className="break-words text-sm text-fg-secondary">
            Expected outcome proposed by the author: {form.sampleTask.expectedOutcome}. This is not an execution result.
          </p>
          <Button size="sm" onClick={() => void copySample()}>
            Copy extension sample task
          </Button>
          {copyStatus ? (
            <p role="status" className="text-sm">
              {copyStatus}
            </p>
          ) : null}
        </section>
      ) : null}
    </details>
  );
}
