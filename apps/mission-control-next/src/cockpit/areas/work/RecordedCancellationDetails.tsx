import { TechnicalDetails } from "../../ui/TechnicalDetails";

/** The recorded cancellation text behind a sentence that words it, kept for technical details. */
export function RecordedCancellationDetails({ recorded }: { recorded: string }) {
  return (
    <TechnicalDetails label="Recorded error">
      <p className="break-all font-mono text-xs">{recorded}</p>
    </TechnicalDetails>
  );
}
