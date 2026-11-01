import type { RealtimeEvent } from "@goatcitadel/contracts";
import { runWithIsolatedRequestAttribution } from "@goatcitadel/storage";
import type { GatewayDevDiagnosticsService } from "../dev-diagnostics/service.js";
import { OpsSavedBoardService, type OpsSavedBoardServiceStoragePort } from "./ops-saved-board-service.js";

// How the saved Ops boards reach their owners: the boards' storage as it is, and the realtime stream and the dev
// diagnostics as plain functions. A board change is published only after its write commits; a publication that fails
// is recorded as a diagnostic and the write stands.

/** The retained realtime publish, as the Gateway's own `publishRealtime` takes it. */
export type OpsSavedBoardRealtimePublish = (
  eventType: string,
  source: string,
  payload: Record<string, unknown>,
  options: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
) => Promise<unknown>;

type DevDiagnosticInput = Parameters<GatewayDevDiagnosticsService["record"]>[0];

/** Wires the saved boards to their storage, this process's realtime epoch, the realtime stream and the diagnostics. */
export function composeOpsSavedBoards(
  storage: OpsSavedBoardServiceStoragePort,
  realtimeEpoch: string,
  publishRealtime: OpsSavedBoardRealtimePublish,
  recordDevDiagnostic: (input: DevDiagnosticInput) => void,
): OpsSavedBoardService {
  return new OpsSavedBoardService(storage, {
    realtimeEpoch,
    publishChange: async (signal) => {
      await runWithIsolatedRequestAttribution({}, async () => {
        await publishRealtime(
          "ops_saved_board_changed",
          "ops_saved_boards",
          { ...signal },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: { workspaceId: signal.workspaceId },
          },
        );
      });
    },
    reportPublicationFailure: (_error, signal) => {
      recordDevDiagnostic({
        level: "warn",
        category: "ops_boards",
        event: "ops_saved_board.realtime_projection_failed",
        message: "Saved board mutation committed before retained realtime publication failed.",
        runtimeKind: "ops_saved_board.realtime",
        runtimeStatus: "degraded",
        context: {
          workspaceId: signal.workspaceId,
          boardId: signal.boardId,
          revision: signal.revision,
          epoch: signal.epoch,
          operation: signal.operation,
        },
      });
    },
  });
}
