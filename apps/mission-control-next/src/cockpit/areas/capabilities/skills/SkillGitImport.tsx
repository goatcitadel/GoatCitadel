import { useState, type FormEvent } from "react";
import type { CapabilitySkillSource } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";

const NOT_HTTPS = "Enter an https address, like https://github.com/name/repo.";
const HAS_CREDENTIALS = "Leave your user name and token out of the address, like https://github.com/name/repo.";

/**
 * The address the browser may send, or why it won't: an `https:` URL that parses, with no user name or token in it,
 * since those must never leave the browser. Which hosts are allowed is the Gateway's.
 */
function sendableAddress(value: string): { sourceRef: string } | { refusal: string } {
  const address = value.trim();
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { refusal: NOT_HTTPS };
  }
  if (url.protocol !== "https:") return { refusal: NOT_HTTPS };
  if (url.username !== "" || url.password !== "") return { refusal: HAS_CREDENTIALS };
  return { sourceRef: address };
}

/**
 * "Import from Git": a Git repository address and a Check button. The browser only refuses what isn't an https
 * address or carries a user name or token; GoatCitadel's checks decide the rest, and a refusal shows under the field
 * (`error`) only while the field still holds the address it was about (spaces around it aside), so editing the
 * address clears it.
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
  // Why the browser won't send the address in the field, until it is edited.
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  // The address the last check was sent for: a refusal is about that one.
  const [checked, setChecked] = useState<string | undefined>(undefined);
  const refusal = error && checked !== undefined && value.trim() === checked ? error : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = sendableAddress(value);
    if ("refusal" in address) {
      setInvalid(address.refusal);
      return;
    }
    setInvalid(undefined);
    setChecked(address.sourceRef);
    onCheck({ kind: "git", sourceRef: address.sourceRef });
  };
  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <Field
        label="Git repository address"
        help="From GitHub, GitLab, Bitbucket or Codeberg"
        {...(invalid ? { error: invalid } : refusal ? { error: refusal } : {})}
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
              setInvalid(undefined);
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
