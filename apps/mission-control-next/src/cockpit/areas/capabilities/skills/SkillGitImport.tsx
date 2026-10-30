import { useState, type FormEvent } from "react";
import type { CapabilitySkillSource } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";

const NOT_HTTPS = "Enter an https address, like https://github.com/name/repo.";

/** Whether the browser can send an address at all: an `https:` URL that parses. Which hosts are allowed is the Gateway's. */
function httpsAddress(value: string): string | undefined {
  const address = value.trim();
  try {
    return new URL(address).protocol === "https:" ? address : undefined;
  } catch {
    return undefined;
  }
}

/**
 * "Import from Git": a Git repository address and a Check button. The browser only refuses what isn't an https
 * address; GoatCitadel's checks decide the rest, and a refusal shows under the field (`error`) only while the field
 * still holds the address it was about (spaces around it aside), so editing the address clears it.
 */
export function SkillGitImport({
  checking,
  error,
  onCheck,
}: {
  checking: boolean;
  /** Why the last check of an address was refused, in plain words. */
  error?: string;
  onCheck: (source: CapabilitySkillSource) => void;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  // The address the last check was sent for: a refusal is about that one.
  const [checked, setChecked] = useState<string | undefined>(undefined);
  const refusal = error && checked !== undefined && value.trim() === checked ? error : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const sourceRef = httpsAddress(value);
    setInvalid(!sourceRef);
    if (!sourceRef) return;
    setChecked(sourceRef);
    onCheck({ kind: "git", sourceRef });
  };
  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <Field
        label="Git repository address"
        help="From GitHub, GitLab, Bitbucket or Codeberg"
        {...(invalid ? { error: NOT_HTTPS } : refusal ? { error: refusal } : {})}
        required
      >
        {(props) => (
          <input
            {...props}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setInvalid(false);
            }}
            className={cockpitInputClass}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" loading={checking} loadingLabel="Checking…">
        Check
      </Button>
    </form>
  );
}
