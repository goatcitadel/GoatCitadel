import { useEffect, useRef, useState } from "react";
import { publicWebAddressFor } from "@goatcitadel/contracts";
import { useMissingHosts } from "../../../../features/native-routes/settings/channel-hosts";
import { useCredentialInput } from "../../../../features/native-routes/settings/credential-input-owner";
import { channelPageHref, channelPickerHref } from "../../../app/routes";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { TimeText } from "../../../ui/TimeText";
import {
  PublicWebAddressField,
  usePublicWebAddress,
  usePublicWebAddressSettings,
} from "../../settings/PublicWebAddressField";
import { settingsChannelSetupHref } from "./channel-picker-model";
import { SetupFrame } from "./SetupFrame";
import { SetupSteps, type SetupStepView } from "./SetupSteps";
import { TurnOnStep, turnOnStatus } from "./TurnOnStep";
import { useChannelSetupHosts } from "./use-channel-picker-groups";
import { useTurnOn, type TurnOnState } from "./use-turn-on";
import { useWhatsAppSetup, type WhatsAppSetupState } from "./use-whatsapp-setup";
import { WhatsAppAddressStep } from "./WhatsAppAddressStep";
import { NO_WHATSAPP_IDS, WhatsAppDetailsStep, type WhatsAppIds } from "./WhatsAppDetailsStep";
import { WhatsAppSayHiStep } from "./WhatsAppSayHiStep";
import {
  WHATSAPP_ADDRESS_CHECKED,
  WHATSAPP_ADDRESS_CHECKED_EARLIER,
  WHATSAPP_ADDRESS_NOT_CHECKED,
  WHATSAPP_ADDRESS_WAITING,
  WHATSAPP_CATALOG_ID,
  WHATSAPP_CODE_EXPIRED,
  WHATSAPP_META_APPS_HREF,
  WHATSAPP_META_APP_STEPS,
  WHATSAPP_PUBLIC_ADDRESS_TEXT,
  WHATSAPP_TOKEN_ENDS,
  WHATSAPP_TOKEN_ENDS_ADVICE,
  WHATSAPP_TURN_ON_WORDING,
  WHATSAPP_WAITING_FOR_HI,
  whatsAppCallbackPath,
  whatsAppSaidHi,
  whatsAppSenderName,
  whatsAppTurnOnChanges,
  whatsAppWorks,
} from "./whatsapp-setup-model";

/** Where each step is done. */
const ON_THIS_PAGE = "On this page";

function MakeMetaApp() {
  return (
    <div className="space-y-2 text-sm text-fg-secondary">
      <ol className="list-decimal space-y-1 pl-5">
        {WHATSAPP_META_APP_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <a
        href={WHATSAPP_META_APPS_HREF}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-accent underline-offset-2 hover:underline"
      >
        Open Meta for Developers
      </a>
    </div>
  );
}

/** What the details that checked out found, and a calm note when the token will stop working. */
function DetailsWork({ setup }: { setup: WhatsAppSetupState }) {
  const { number, tokenExpiresAt } = setup;
  if (!number) return null;
  return (
    <div className="space-y-2">
      <p>{whatsAppWorks(number)}</p>
      {tokenExpiresAt ? (
        <Callout tone="warning" announce={false}>
          <p>
            {WHATSAPP_TOKEN_ENDS} <TimeText value={tokenExpiresAt} />. {WHATSAPP_TOKEN_ENDS_ADVICE}
          </p>
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * What the page tells a screen reader after each thing happens: the one status line, latest first. Everything it says
 * is also on the page, in the step it belongs to.
 */
function statusLine(setup: WhatsAppSetupState, checking: boolean, turnOn: TurnOnState): string | undefined {
  if (setup.error) return setup.error;
  if (checking) return "Checking your details…";
  const turningOn = turnOnStatus(turnOn, WHATSAPP_TURN_ON_WORDING);
  if (turningOn) return turningOn;
  if (setup.busy) return "Working…";
  if (setup.sender) return whatsAppSaidHi(whatsAppSenderName(setup.sender));
  if (setup.codeExpired) return WHATSAPP_CODE_EXPIRED;
  if (setup.code) return WHATSAPP_WAITING_FOR_HI;
  if (!setup.number) return undefined;
  if (!setup.addressCheckedAt) return WHATSAPP_ADDRESS_WAITING;
  // "Just now" only for a check this page session saw arrive; read back from the draft, or after the details were
  // checked anew, it is the same fact with no time in it.
  return setup.addressCheckedHere ? WHATSAPP_ADDRESS_CHECKED : WHATSAPP_ADDRESS_CHECKED_EARLIER;
}

/**
 * WhatsApp's setup: give GoatCitadel a public web address, make a Meta app and copy its five details, point Meta at
 * GoatCitadel and wait for it to check the address, say hi from a phone, turn it on. Each step checks itself and the
 * next opens when it has; the Meta app is open all along, so it can be made while the address is set. Saying hi makes
 * the person who does it the bot's only allowed sender; turning on finishes the setup in place.
 */
export function WhatsAppSetupPage({
  workspaceId,
  resumeDraftId,
}: {
  workspaceId: string;
  /** The unfinished setup to go on with, when the page was sent to one; else the newest made on this page. */
  resumeDraftId?: string;
}) {
  const setup = useWhatsAppSetup(workspaceId, resumeDraftId);
  const turnOn = useTurnOn(workspaceId, setup.draft?.draftId);
  const publicWebAddress = usePublicWebAddress();
  const publicSettings = usePublicWebAddressSettings();
  const [checking, setChecking] = useState(false);
  const [ids, setIds] = useState<WhatsAppIds>(NO_WHATSAPP_IDS);
  // Half-typed secrets are not work worth a leave review.
  const accessToken = useCredentialInput(`channel:${workspaceId}:whatsapp:access-token`, "", undefined, {
    label: "WhatsApp access token",
    active: false,
  });
  const appSecret = useCredentialInput(`channel:${workspaceId}:whatsapp:app-secret`, "", undefined, {
    label: "WhatsApp App secret",
    active: false,
  });
  const { discard: discardAccessToken } = accessToken;
  const { discard: discardAppSecret } = appSecret;
  const { number, busy, draft, sender, addressCheckedAt, appSubscribed, newCode } = setup;

  // Each step opens when the one before is done. Done is read from what is true now, never from an event that may fire
  // again: the address from the settings, the rest from what Meta and the person who says hi have shown.
  const addressSet = publicWebAddress !== undefined;
  const detailsWork = number !== null;
  const addressDone = detailsWork && addressCheckedAt !== undefined && appSubscribed;
  const readyForHi = addressSet && addressDone;
  const saidHi = readyForHi && sender !== null;
  const turnedOn = turnOn.state === "done";
  const detailsState = !addressSet ? "locked" : detailsWork ? "done" : "current";
  const addressState = !addressSet || !detailsWork ? "locked" : addressDone ? "done" : "current";
  const sayHiState = !readyForHi ? "locked" : sender ? "done" : "current";
  const turnOnState = !saidHi ? "locked" : turnedOn ? "done" : "current";

  const requiredHosts = useChannelSetupHosts(WHATSAPP_CATALOG_ID, draft);
  const hosts = useMissingHosts(requiredHosts, saidHi);

  const discardSecrets = () => {
    discardAccessToken();
    discardAppSecret();
  };
  // Both secrets are stored securely once the details work, so what was typed is dropped. Details that failed stay, to fix.
  useEffect(() => {
    if (detailsWork) {
      discardAccessToken();
      discardAppSecret();
    }
  }, [detailsWork, discardAccessToken, discardAppSecret]);
  // Nothing typed outlives the page.
  useEffect(
    () => () => {
      discardAccessToken();
      discardAppSecret();
    },
    [discardAccessToken, discardAppSecret],
  );

  // Step 5 opens with a code to send. It is asked for once per setup: if saving it fails, the step offers a button
  // instead of trying again on every draw. Someone who said hi on an earlier visit needs no code.
  const codeAsked = useRef(false);
  const saidHiAlready = sender !== null;
  useEffect(() => {
    if (!readyForHi) {
      codeAsked.current = false;
      return;
    }
    if (codeAsked.current || !draft || busy || saidHiAlready) return;
    codeAsked.current = true;
    void newCode();
  }, [readyForHi, draft, busy, saidHiAlready, newCode]);

  const checkDetails = async () => {
    setChecking(true);
    try {
      await setup.checkDetails({ ...ids, appSecret: appSecret.value, accessToken: accessToken.value });
    } finally {
      setChecking(false);
    }
  };
  const startOver = async () => {
    discardSecrets();
    setIds(NO_WHATSAPP_IDS);
    await setup.startOver();
  };

  const name = sender ? whatsAppSenderName(sender) : "";
  const callbackUrl = draft ? publicWebAddressFor(publicWebAddress, whatsAppCallbackPath(draft.draftId)) : undefined;
  const turnOnStep = saidHi ? (
    <TurnOnStep
      changes={whatsAppTurnOnChanges({ name, missingHosts: hosts.missing })}
      turnOn={turnOn}
      onTurnOn={() => {
        if (draft && requiredHosts && hosts.known) {
          const target = { draftId: draft.draftId, catalogId: WHATSAPP_CATALOG_ID };
          void turnOn.turnOn({ ...target, requiredHosts, shownHosts: hosts.missing });
        }
      }}
      doneHref={turnedOn && draft ? channelPageHref(draft.draftId) : undefined}
      disabled={!requiredHosts || !hosts.known}
      workspaceId={workspaceId}
      wording={WHATSAPP_TURN_ON_WORDING}
    />
  ) : undefined;

  // The details step shows a failure beside its fields while it is open, and the address step shows the wait that ran
  // out beside the button that waits again. A failure of anything else (the verify token, the subscription, the code,
  // Start over) would be heard but not seen, so it shows below the steps instead. Never both.
  const shownInStep =
    detailsState === "current" ||
    (addressState === "current" && setup.addressExpired && setup.error === WHATSAPP_ADDRESS_NOT_CHECKED);
  const pageError = shownInStep ? undefined : setup.error;

  const steps: SetupStepView[] = [
    {
      id: "address",
      title: "Give GoatCitadel a public web address",
      place: ON_THIS_PAGE,
      state: addressSet ? "done" : "current",
      result: addressSet ? <span className="break-all font-mono text-fg">{publicWebAddress}</span> : undefined,
      children: (
        <>
          <p className="text-sm text-fg-secondary">{WHATSAPP_PUBLIC_ADDRESS_TEXT}</p>
          <PublicWebAddressField settings={publicSettings} />
        </>
      ),
    },
    {
      id: "meta-app",
      title: "Make your Meta app",
      place: "In Meta",
      state: detailsState === "done" ? "done" : "current",
      children: <MakeMetaApp />,
    },
    {
      id: "details",
      title: "Paste your WhatsApp details",
      place: "In Meta, then on this page",
      waitsFor: "Opens when your public web address is set.",
      state: detailsState,
      result: detailsWork ? <DetailsWork setup={setup} /> : undefined,
      children: (
        <WhatsAppDetailsStep
          ids={ids}
          appSecret={appSecret.value}
          accessToken={accessToken.value}
          onId={(key, value) => setIds((held) => ({ ...held, [key]: value }))}
          onAppSecret={appSecret.setValue}
          onAccessToken={accessToken.setValue}
          busy={busy}
          checking={checking}
          error={setup.error}
          onCheck={() => void checkDetails()}
        />
      ),
    },
    {
      id: "point-meta",
      title: "Point Meta at GoatCitadel",
      place: "In Meta",
      waitsFor: "Opens when Meta accepts your details.",
      state: addressState,
      // What stays on screen carries no time: it would be wrong an hour from now.
      result: addressDone ? WHATSAPP_ADDRESS_CHECKED_EARLIER : undefined,
      children: callbackUrl ? (
        <WhatsAppAddressStep
          callbackUrl={callbackUrl}
          verifyToken={setup.verifyToken}
          addressCheckedAt={addressCheckedAt}
          addressExpired={setup.addressExpired}
          appSubscribed={appSubscribed}
          busy={busy}
          onNewVerifyToken={() => void setup.newVerifyToken()}
          onCheckAgain={setup.checkAddressAgain}
          onSubscribe={() => void setup.subscribeApp()}
        />
      ) : undefined,
    },
    {
      id: "say-hi",
      title: "Say hi from your phone",
      place: "On your phone",
      waitsFor: "Opens when Meta has checked your address and the app is subscribed.",
      state: sayHiState,
      result: sender ? whatsAppSaidHi(name) : undefined,
      children: number ? <WhatsAppSayHiStep displayNumber={number.displayNumber} setup={setup} /> : undefined,
    },
    {
      id: "turn-on",
      title: "Turn on",
      place: ON_THIS_PAGE,
      waitsFor: "Opens when you've said hi from your phone.",
      state: turnOnState,
      result: turnedOn ? turnOnStep : undefined,
      children: turnOnStep,
    },
  ];

  return (
    <SetupFrame
      title="Set up WhatsApp"
      back={{ href: channelPickerHref(), label: "Back to channels" }}
      workspaceId={workspaceId}
    >
      <SetupSteps steps={steps} status={statusLine(setup, checking, turnOn)} />
      {pageError ? (
        <Callout tone="error" announce={false}>
          <p>{pageError}</p>
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-subtle pt-4">
        {/* Nothing to start over from once it is on: the setup is finished, and the draft is the channel. */}
        {turnedOn ? null : (
          <Button variant="ghost" disabled={busy || turnOn.state === "working"} onClick={() => void startOver()}>
            Start over
          </Button>
        )}
        {/* Settings keeps WhatsApp's own steps, which also set it up. */}
        <NativeOwnerLink href={settingsChannelSetupHref(WHATSAPP_CATALOG_ID)} scope={workspaceId} className="text-sm">
          More options in Settings
        </NativeOwnerLink>
      </div>
    </SetupFrame>
  );
}
