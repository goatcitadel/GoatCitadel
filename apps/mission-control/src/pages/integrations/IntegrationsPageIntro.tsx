import type { ReactNode } from "react";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";

type IntegrationsPageIntroProps = {
  isChannelsView: boolean;
  headerTitle: string;
  headerSubtitle: string | undefined;
  headerHint: string;
  headerActions: ReactNode;
  error: string | null;
  isRefreshing: boolean;
  connectionSummary: {
    total: number;
    connected: number;
    paused: number;
    error: number;
    disabled: number;
  };
};

export function IntegrationsPageIntro({
  isChannelsView,
  headerTitle,
  headerSubtitle,
  headerHint,
  headerActions,
  error,
  isRefreshing,
  connectionSummary,
}: IntegrationsPageIntroProps) {
  return (
    <>
      <PageHeader
        eyebrow="Integrate"
        title={headerTitle}
        subtitle={headerSubtitle}
        hint={headerHint}
        density="compact"
        actions={headerActions}
      />
      <Panel
        title="How Connections Work"
        subtitle="Catalog entries define the shape. Connections hold config and activate only when a page or workflow needs them."
        collapsible
        defaultExpanded={false}
      >
        {error ? <p className="error">{error}</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing integrations...</p> : null}
        <ol>
          <li>
            {isChannelsView
              ? "Pick a channel adapter from the catalog."
              : "Pick a catalog entry to define what you are connecting."}
          </li>
          <li>
            {isChannelsView
              ? "Use guided fields first so default targets and auth expectations stay visible."
              : "Fill guided fields (recommended), then save the connection."}
          </li>
          <li>
            {isChannelsView
              ? "Validate delivery in Channel Test Bench before you trust the adapter live."
              : "Leave it connected for live use, or pause it until needed."}
          </li>
        </ol>
        <div className="token-row">
          <span className="token-chip">Configured: {connectionSummary.total}</span>
          <span className="token-chip token-chip-active">Ready: {connectionSummary.connected}</span>
          <span className="token-chip">Paused: {connectionSummary.paused}</span>
          <span className="token-chip">Errors: {connectionSummary.error}</span>
          <span className="token-chip">Disabled: {connectionSummary.disabled}</span>
        </div>
      </Panel>
    </>
  );
}
