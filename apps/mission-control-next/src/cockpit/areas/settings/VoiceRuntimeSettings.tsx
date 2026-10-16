import { useQuery } from "@tanstack/react-query";
import { fetchVoiceRuntimeStatus } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { VoiceRuntimeControls } from "../../../features/native-routes/settings/VoiceRuntimeControls";
import { Button } from "../../ui/Button";

export function VoiceRuntimeSettings() {
  const runtime = useQuery({ queryKey: ["settings", "voice-runtime"], queryFn: fetchVoiceRuntimeStatus });
  return (
    <section
      id="voice-runtime"
      aria-labelledby="voice-runtime-title"
      className="mt-4 space-y-3 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 id="voice-runtime-title" className="text-base font-semibold text-fg">
          Local voice runtime
        </h3>
        <Button size="sm" disabled={runtime.isFetching} onClick={() => void runtime.refetch()}>
          Refresh voice runtime
        </Button>
      </div>
      {runtime.isLoading ? <p role="status">Loading voice runtime…</p> : null}
      {runtime.isError ? <p role="alert">{describeApiError(runtime.error).summary}</p> : null}
      <VoiceRuntimeControls
        cockpit
        buttonComponent={Button}
        status={runtime.data}
        available={!runtime.isError && !runtime.isFetching}
        reload={() => runtime.refetch()}
      />
    </section>
  );
}
