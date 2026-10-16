import { presentProviderSecretField } from "../../../../cockpit/areas/settings/settings-vocabulary";
import { SettingsField } from "../SettingsShared";

/** The field where a replacement provider secret is pasted; wording follows the provider's credential mode. */
export function ProviderSecretField({
  authMode,
  value,
  onChange,
}: {
  authMode: string | null | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  const copy = presentProviderSecretField(authMode);
  return (
    <SettingsField label={copy.label}>
      <input
        className="mc-next-settings-input"
        type="password"
        value={value}
        placeholder={copy.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {copy.help ? <p className="mc-next-settings-field-note">{copy.help}</p> : null}
    </SettingsField>
  );
}
