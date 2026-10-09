import {
  checkProviderMutationOutcome,
  type ProviderMutation,
} from "../../../features/native-routes/settings/sections/provider-mutation-state";
import { Button } from "../../ui/Button";

/** The provider lock after a lost response, and the one action that can settle it from the Gateway's record. */
export function ProviderOutcomeCheck({
  mutation,
  reload,
}: {
  mutation: ProviderMutation;
  reload: () => Promise<unknown>;
}) {
  if (!mutation.uncertain && !mutation.outcome) return null;
  return (
    <div className="space-y-2">
      {mutation.uncertain ? (
        <p role="alert" className="text-sm text-status-waiting">
          {mutation.uncertain}
        </p>
      ) : null}
      {mutation.outcome ? (
        <p role="status" className="text-sm text-fg-secondary">
          {mutation.outcome}
        </p>
      ) : null}
      {mutation.uncertain && mutation.checkable ? (
        <Button size="sm" disabled={mutation.checking} onClick={() => void checkProviderMutationOutcome(reload)}>
          {mutation.checking ? "Checking outcome…" : "Check outcome"}
        </Button>
      ) : null}
    </div>
  );
}
