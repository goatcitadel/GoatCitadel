import { useState } from "react";
import type { CapabilityConnectorItem, CapabilityConnectorReason } from "@goatcitadel/contracts";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { Section } from "../../../ui/Section";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { ConnectorInstallProgress, installSteps } from "./ConnectorInstallProgress";
import { ChatBlockNote, ConnectionLines, ConnectorHeader, HiddenNote, TechnicalRows } from "./ConnectorPanelParts";
import { REMOTE_LINE } from "./WhatAsksFirst";
import { connectorSettingsHref } from "./connector-links";
import { isActiveInstallState } from "./connector-install-store";
import type { ConnectorInstall } from "./use-connector-install";

/** What the install sets (R73): saved with "Reading is free", which Manage can change later. */
const ASKS_FIRST_LINE =
  "Reads run on their own. Anything that creates or changes something asks you first. You can change this later.";

/** Templates that are set up in Settings instead: no path here takes their key or their sign-in setup yet. */
const SET_UP_ELSEWHERE: Readonly<Partial<Record<CapabilityConnectorReason, string>>> = {
  needs_api_key: "Needs an API key.",
  missing_sign_in_setup: "Sign-in isn't set up for this app yet.",
};

/**
 * The panel of an MCP template that isn't installed yet: what it lets GoatCitadel do (with the template's own risk
 * notes), how it connects and the hosts the install allows, what will ask first, and the one button that installs it
 * through a reviewed change, then signs in, switches it on and connects. When Chat can't use connectors because MCP in
 * Chat is off, a pre-ticked box turns that on with the install. An app that needs an API key or a sign-in setup is sent
 * to Settings instead, and says nothing about what an install here would do.
 */
export function ConnectorInstallPanel({
  item,
  install,
  reliefAvailable,
}: {
  item: CapabilityConnectorItem;
  install: ConnectorInstall;
  reliefAvailable: boolean;
}) {
  const [chatToo, setChatToo] = useState(true);
  const { state } = install;
  const elsewhere = SET_UP_ELSEWHERE[item.reason];
  const offerChat = !elsewhere && !item.chat.available && item.chat.blockedBy === "mcp_in_chat_off";
  const label = state.phase === "failed" ? "Try again" : item.auth === "oauth" ? "Sign in and install" : "Install";
  // Done, the panel waits for the list to show the saved server; installing again would only be refused.
  const action =
    state.phase === "done"
      ? undefined
      : { label, run: () => install.start({ enableChatConnectors: offerChat && chatToo }) };
  return (
    <div className="space-y-4">
      <ConnectorHeader item={item} />

      <Section title="What it lets GoatCitadel do" headingLevel={3}>
        <div className="space-y-2 text-sm text-fg-secondary">
          {item.description ? <p>{item.description}</p> : null}
          {item.riskNotes?.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      </Section>

      <Section title="How it connects" headingLevel={3}>
        <ConnectionLines item={item}>
          {!elsewhere && item.networkHosts.length > 0 ? (
            <p>Installing adds {item.networkHosts.join(", ")} to your network allowlist.</p>
          ) : null}
        </ConnectionLines>
      </Section>

      {elsewhere ? null : (
        <Section title="What asks first" headingLevel={3}>
          <p className="text-sm text-fg-secondary">{reliefAvailable ? ASKS_FIRST_LINE : REMOTE_LINE}</p>
        </Section>
      )}

      {offerChat ? (
        <label className="flex items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={chatToo}
            disabled={isActiveInstallState(state)}
            className="mt-0.5 shrink-0"
            onChange={(event) => setChatToo(event.target.checked)}
          />
          Also let Chat use connectors
        </label>
      ) : item.chat.available ? null : (
        <ChatBlockNote item={item} />
      )}
      <HiddenNote item={item} />

      {elsewhere ? (
        <p className="text-sm text-fg-secondary">
          {elsewhere}{" "}
          <NativeOwnerLink scope={item.id} href={connectorSettingsHref(item)}>
            Set up in Settings
          </NativeOwnerLink>
        </p>
      ) : (
        <ConnectorInstallProgress
          install={install}
          scope={item.id}
          steps={installSteps(item)}
          doneLine="Installed."
          action={action}
        />
      )}

      <NativeOwnerLink scope={item.id} href={connectorSettingsHref(item)} className="text-sm">
        Advanced setup in Settings
      </NativeOwnerLink>

      <TechnicalDetails>
        <TechnicalRows
          item={item}
          extra={[["Install plan", state.phase === "waiting_inbox" ? state.planId : undefined]]}
        />
      </TechnicalDetails>
    </div>
  );
}
