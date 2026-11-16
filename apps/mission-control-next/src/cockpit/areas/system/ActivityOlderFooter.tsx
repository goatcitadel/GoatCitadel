import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

/** Under the activity list: a way to read older signals while more exist, and a plain end when none remain. */
export function ActivityOlderFooter({
  hasMore,
  capped,
  cap,
  busy,
  error,
  onLoad,
}: {
  hasMore: boolean;
  /** The page stopped keeping older signals at `cap`: more may exist, and none are dropped without saying so. */
  capped: boolean;
  cap: number;
  busy: boolean;
  error: string | undefined;
  onLoad: () => void;
}) {
  return (
    <div className="grid gap-2 text-sm">
      {error ? (
        <Callout tone="error" announce={false}>
          Could not load older signals. {error}
        </Callout>
      ) : null}
      {capped ? (
        <p className="text-fg-muted">
          This page stops at the most recent {plural(cap, "older signal")}. Runs are listed in full in Work history.{" "}
          <NativeOwnerLink href="/work/history" scope="activity-work-history">
            Open Work history
          </NativeOwnerLink>
        </p>
      ) : hasMore ? (
        <Button className="self-start" loading={busy} loadingLabel="Loading older signals…" onClick={onLoad}>
          Load older signals
        </Button>
      ) : (
        <p className="text-fg-muted">
          That is everything this installation keeps. Runs are listed in full in Work history.{" "}
          <NativeOwnerLink href="/work/history" scope="activity-work-history">
            Open Work history
          </NativeOwnerLink>
        </p>
      )}
    </div>
  );
}
