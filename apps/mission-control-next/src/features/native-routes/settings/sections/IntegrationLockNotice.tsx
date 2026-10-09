import { useState } from "react";
import type { useIntegrationConnectionMutation } from "../integration-connection-mutation";
import { NativeButton } from "../../primitives";
import { SettingsNotice } from "../SettingsShared";

/**
 * An integration write lock and, when its lost attempt is identified, the check that can settle it. `readback` must be
 * the lock owner's own canonical read (which throws on failure); the section's reload then refreshes the view.
 */
export function IntegrationLockNotice({
  mutation,
  readback,
  reload,
}: {
  mutation: ReturnType<typeof useIntegrationConnectionMutation>;
  readback: () => Promise<unknown>;
  reload: () => Promise<unknown> | void;
}) {
  const [settled, setSettled] = useState<string | null>(null);
  if (mutation.phase !== "uncertain")
    return settled ? <SettingsNotice notice={{ tone: "info", message: settled }} /> : null;
  return (
    <>
      <SettingsNotice notice={{ tone: "warning", message: mutation.message! }} />
      {mutation.transport ? (
        <NativeButton
          variant="outline"
          disabled={mutation.checking}
          onClick={() =>
            void mutation
              .checkOutcome(async () => {
                await readback();
                await reload();
              })
              .then((message) => {
                if (message) setSettled(message);
              })
          }
        >
          {mutation.checking ? "Checking outcome…" : "Check outcome"}
        </NativeButton>
      ) : null}
    </>
  );
}
