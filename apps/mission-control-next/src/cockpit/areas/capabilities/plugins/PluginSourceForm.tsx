import { useState, type FormEvent } from "react";
import type { PluginSource } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";
import { sendableAddress } from "../skills/SkillGitImport";
import { GIT_SOURCE_HINT } from "./plugin-format-view";
import type { PluginSourceFormKind } from "./plugin-links";

const NO_FOLDER = "Enter the folder's full path.";

/** What the form would send, or why the browser won't send it. Which hosts and folders are allowed is the Gateway's. */
function sendableSource(kind: PluginSourceFormKind, address: string, ref: string): PluginSource | { refusal: string } {
  if (kind === "folder") {
    const path = address.trim();
    return path ? { kind: "folder", path } : { refusal: NO_FOLDER };
  }
  const checked = sendableAddress(address);
  if ("refusal" in checked) return checked;
  // A blank commit, branch or tag is left out: the route takes 1 to 256 characters when one is sent at all.
  const pinned = ref.trim();
  return { kind: "git", url: checked.sourceRef, ...(pinned ? { ref: pinned } : {}) };
}

/**
 * "Install from Git" (a repository address, https only and with no user name or token, and an optional commit, branch
 * or tag) or "Add from folder" (a folder path), with one Check button. The browser refuses only what it must never
 * send; GoatCitadel's checks decide the rest, and a refusal (`error`) shows under the field only while the fields still
 * hold what it was about (spaces around them aside), so editing clears it.
 */
export function PluginSourceForm({
  kind,
  checking,
  error,
  onCheck,
}: {
  kind: PluginSourceFormKind;
  checking: boolean;
  /** Why the last check of these fields was refused, in plain words. */
  error?: string;
  onCheck: (source: PluginSource) => void;
}) {
  const [address, setAddress] = useState("");
  const [ref, setRef] = useState("");
  // Why the browser won't send what the fields hold, until they are edited.
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  // What the last check was sent for: a refusal is about that.
  const [checked, setChecked] = useState<string | undefined>(undefined);
  const current = JSON.stringify([address.trim(), ref.trim()]);
  const refusal = error && checked === current ? error : undefined;
  const fieldError = invalid ?? refusal;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const source = sendableSource(kind, address, ref);
    if ("refusal" in source) return setInvalid(source.refusal);
    setInvalid(undefined);
    setChecked(current);
    onCheck(source);
  };
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setInvalid(undefined);
  };
  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <SourceFields
        kind={kind}
        address={address}
        gitRef={ref}
        error={fieldError}
        onAddress={edit(setAddress)}
        onRef={edit(setRef)}
      />
      <Button type="submit" variant="primary" loading={checking} loadingLabel="Checking…">
        Check
      </Button>
    </form>
  );
}

/** The fields of one source: a Git address and its optional commit, branch or tag, or a folder path. */
function SourceFields({
  kind,
  address,
  gitRef,
  error,
  onAddress,
  onRef,
}: {
  kind: PluginSourceFormKind;
  address: string;
  gitRef: string;
  error: string | undefined;
  onAddress: (value: string) => void;
  onRef: (value: string) => void;
}) {
  const shown = error ? { error } : {};
  if (kind === "folder") {
    return (
      <Field label="Folder path" help="A folder on the computer GoatCitadel runs on." {...shown} required>
        {(props) => <TextInput {...props} value={address} onValue={onAddress} />}
      </Field>
    );
  }
  return (
    <>
      <p className="text-sm text-fg-secondary">{GIT_SOURCE_HINT}</p>
      <Field label="Git repository address" help="From GitHub, GitLab, Bitbucket or Codeberg" {...shown} required>
        {(props) => <TextInput {...props} url value={address} onValue={onAddress} />}
      </Field>
      <Field label="Commit, branch or tag">{(props) => <TextInput {...props} value={gitRef} onValue={onRef} />}</Field>
    </>
  );
}

function TextInput({
  url = false,
  value,
  onValue,
  ...props
}: {
  id: string;
  url?: boolean;
  value: string;
  onValue: (value: string) => void;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}) {
  return (
    <input
      {...props}
      type={url ? "url" : "text"}
      {...(url ? { inputMode: "url" as const } : {})}
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(event) => onValue(event.target.value)}
      className={cockpitInputClass}
    />
  );
}
