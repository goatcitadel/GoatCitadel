import type { CapabilityPluginPieceState, CapabilityPluginPieceView } from "@goatcitadel/contracts";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";
import { StatusBadge } from "../../../ui/StatusBadge";
import { joinLabels } from "../skills/discover-view";
import {
  PLUGIN_PIECE_KIND_LABELS,
  SIGNING_SECRET_HINT,
  checkLine,
  presentPieceState,
  signingSecretProblem,
} from "./plugin-install-view";

export type ShownPiece = CapabilityPluginPieceView & { state?: CapabilityPluginPieceState };

/**
 * "What it adds": one row per piece, in the manifest's order, with its kind, its name, the Gateway's line on what it
 * does or asks first, the hosts installing it allows and its check. Once the plugin has a record, each row shows where
 * the piece is. While the install can still be confirmed (`secrets` given), a hook asks for its signing secret; the
 * value stays in the panel and goes out only with the install request.
 */
export function PluginPieceList({
  pieces,
  secrets,
  onSecret,
}: {
  pieces: readonly ShownPiece[];
  secrets?: Readonly<Record<string, string>>;
  onSecret?: (pieceId: string, value: string) => void;
}) {
  return (
    <ul className="divide-y divide-line-subtle">
      {pieces.map((piece) => (
        <li key={piece.pieceId} className="space-y-1 py-2 first:pt-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs text-fg-muted">{PLUGIN_PIECE_KIND_LABELS[piece.kind]}</span>
            <span className="min-w-0 font-medium text-fg">{piece.label}</span>
            {piece.state ? <StatusBadge status={presentPieceState(piece.state)} /> : null}
          </div>
          <p>{piece.asksFirst}</p>
          {piece.hosts && piece.hosts.length > 0 ? <p>Allows {joinLabels(piece.hosts)}</p> : null}
          <p className={piece.check.status === "blocked" ? "text-status-failed" : undefined}>
            {checkLine(piece.check, piece.kind)}
          </p>
          {piece.warnings?.map((warning) => (
            <p key={warning} className="text-fg-muted">
              {warning}
            </p>
          ))}
          {piece.needsSecret && secrets && onSecret ? (
            <SecretField
              pieceLabel={piece.label}
              value={secrets[piece.pieceId] ?? ""}
              onChange={(value) => onSecret(piece.pieceId, value)}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A hook's signing secret. The rule is GoatCitadel's own, so a secret it would refuse never enables Install. */
function SecretField({
  pieceLabel,
  value,
  onChange,
}: {
  pieceLabel: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const problem = value === "" ? undefined : signingSecretProblem(value);
  return (
    <Field label="Signing secret" help={SIGNING_SECRET_HINT} {...(problem ? { error: problem } : {})} required>
      {(props) => (
        <input
          {...props}
          // Each hook's field is named for its hook, so several are told apart; the name starts with the visible label.
          aria-label={`Signing secret for ${pieceLabel}`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cockpitInputClass}
        />
      )}
    </Field>
  );
}
