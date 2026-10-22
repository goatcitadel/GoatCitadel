import { presentErrorText } from "../lib/present-error";
import { TechnicalDetails } from "./TechnicalDetails";

/**
 * The recorded text behind a presented error (see presentErrorText), for technical details. Renders nothing when the
 * summary already is the recorded text or the operator preference is off.
 */
export function RecordedErrorDetails({ error }: { error: string | null | undefined }) {
  const { detail } = presentErrorText(error);
  if (!detail) return null;
  return (
    <TechnicalDetails label="Recorded error">
      <p className="break-all font-mono text-xs">{detail}</p>
    </TechnicalDetails>
  );
}
