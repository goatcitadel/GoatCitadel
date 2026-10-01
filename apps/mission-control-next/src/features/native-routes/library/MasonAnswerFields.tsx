import { useId } from "react";
import type { MasonAnswers } from "@goatcitadel/contracts";
import { MASON_KINDS, MASON_POSTURES } from "./mason-session-binding";

/** Semantic fields shared by classic and native presentations. These contain no secrets. */
export function MasonAnswerFields({
  value,
  disabled,
  onChange,
}: {
  value: Partial<MasonAnswers>;
  disabled: boolean;
  onChange: <K extends keyof MasonAnswers>(key: K, value: MasonAnswers[K]) => void;
}) {
  const id = useId(),
    fieldClass = "mt-1 block w-full min-w-0 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg";
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-sm font-medium text-fg">Structured answers</legend>
      <label htmlFor={`${id}-kind`} className="block text-sm text-fg-secondary">
        Kind
        <select
          id={`${id}-kind`}
          className={fieldClass}
          value={value.kind ?? ""}
          onChange={(event) => onChange("kind", event.target.value as MasonAnswers["kind"])}
        >
          <option value="" disabled>
            Choose a kind
          </option>
          {MASON_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      {(["name", "purpose"] as const).map((key) => (
        <label key={key} htmlFor={`${id}-${key}`} className="block text-sm text-fg-secondary">
          {key === "name" ? "Blueprint name" : "Purpose"}
          <input
            id={`${id}-${key}`}
            className={fieldClass}
            value={value[key] ?? ""}
            onChange={(event) => onChange(key, event.target.value)}
          />
        </label>
      ))}
      {(
        [
          ["goals", "Goals"],
          ["sensitiveAreas", "Sensitive areas"],
          ["boundaries", "Boundaries"],
          ["successDefinition", "Success criteria"],
        ] as const
      ).map(([key, label]) => (
        <label key={key} htmlFor={`${id}-${key}`} className="block text-sm text-fg-secondary">
          {label} (one per line)
          <textarea
            id={`${id}-${key}`}
            rows={2}
            className={fieldClass}
            value={value[key]?.join("\n") ?? ""}
            onChange={(event) => onChange(key, event.target.value.split("\n"))}
          />
        </label>
      ))}
      <label htmlFor={`${id}-risk`} className="block text-sm text-fg-secondary">
        Risk posture
        <select
          id={`${id}-risk`}
          className={fieldClass}
          value={value.riskPosture ?? ""}
          onChange={(event) => onChange("riskPosture", event.target.value as MasonAnswers["riskPosture"])}
        >
          <option value="" disabled>Use the chosen kind's default</option>
          {MASON_POSTURES.map((posture) => (
            <option key={posture} value={posture}>
              {posture.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm text-fg-secondary">
        <input
          type="checkbox"
          checked={value.preferLocalForSensitive ?? false}
          onChange={(event) => onChange("preferLocalForSensitive", event.target.checked)}
        />
        Prefer local AI for sensitive work
      </label>
    </fieldset>
  );
}
