import type { CitadelTemplateSnapshot } from "@goatcitadel/contracts";
import { presentChamberSensitivity, presentModelPolicy, presentRiskPosture } from "./citadel-vocabulary";
import { Button } from "../../ui/Button";

export function TemplateCard({
  template,
  disabled,
  onReview,
}: {
  template: CitadelTemplateSnapshot;
  disabled: boolean;
  onReview: () => void;
}) {
  return (
    <article className="space-y-2 rounded-md border border-line-subtle bg-sunken p-3">
      <h4 className="break-words text-sm font-medium text-fg">{template.name}</h4>
      <p className="text-sm text-fg-secondary">{template.description}</p>
      <details className="text-sm text-fg-secondary">
        <summary className="cursor-pointer">Template contents</summary>
        <TemplateContents template={template} />
      </details>
      <Button disabled={disabled} onClick={onReview}>
        Review template
      </Button>
    </article>
  );
}
export function TemplateContents({ template }: { template: CitadelTemplateSnapshot }) {
  return (
    <dl className="mt-2 space-y-2 text-sm text-fg-secondary">
      {[
        ["Purpose", template.purpose],
        ["Goals", template.goals.join(" · ")],
        ["Boundaries", template.boundaries.join(" · ")],
        ["Success", template.successDefinition.join(" · ")],
        ["Risk posture", presentRiskPosture(template.riskPosture ?? "balanced")],
        ["Model policy", presentModelPolicy(template.modelPolicyDefault ?? "hybrid_guarded")],
        [
          "Chambers",
          template.chambers
            .map(
              (chamber) =>
                `${chamber.name} (${presentChamberSensitivity(chamber.sensitivity ?? "private")}${chamber.sealed ? ", sealed" : ""})`,
            )
            .join(" · "),
        ],
      ].map(([label, value]) => (
        <div key={label}>
          <dt className="font-medium">{label}</dt>
          <dd className="break-words">{value || "None recorded"}</dd>
        </div>
      ))}
    </dl>
  );
}
