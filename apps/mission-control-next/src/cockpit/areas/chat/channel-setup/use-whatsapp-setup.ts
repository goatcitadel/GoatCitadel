import { useCallback, useEffect, useRef } from "react";
import type { ChannelSetupDraft, WhatsAppSetupCheckResult, WhatsAppSetupCodeSender } from "@goatcitadel/contracts";
import {
  checkWhatsAppSetup,
  discardChannelSetupDraft,
  fetchChannelSetupDrafts,
  submitChannelSetupDraftSecrets,
  subscribeWhatsAppSetupApp,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { listenForHi } from "./listen-for-hi";
import { createSetupCode } from "./setup-code";
import { chatSetupToResume, latestDraft } from "./setup-draft-session";
import { useSetupState } from "./use-setup-state";
import { askWhatHeard, hasWhatsAppDetails, saveWhatsAppDraft, storeWhatsAppDetails } from "./whatsapp-choices";
import {
  WHATSAPP_ADDRESS_NOT_CHECKED,
  WHATSAPP_CATALOG_ID,
  WHATSAPP_CHECK_FAILED,
  WHATSAPP_LISTEN_POLL_MS,
  createVerifyToken,
  savedAddressCheckedAt,
  savedWhatsAppSender,
  trimmedWhatsAppDetails,
  whatsAppDetailsProblem,
  whatsAppDraftWithSender,
  whatsAppFailure,
  type WhatsAppDetails,
} from "./whatsapp-setup-model";

export { WHATSAPP_CATALOG_ID } from "./whatsapp-setup-model";

export interface WhatsAppSetupState {
  /** The setup in progress, or null before there is one. */
  draft: ChannelSetupDraft | null;
  /** The business number the access token belongs to, once Meta has accepted all five details. */
  number: { displayNumber: string; verifiedName: string } | null;
  /** When the access token stops working. Absent when it never does, and before the details are checked. */
  tokenExpiresAt?: string;
  /**
   * The verify token Meta is to be given, while the page holds it. It is held in this page's memory and the draft's
   * secure store and nowhere else. Null after a reload, when only `newVerifyToken` can show one.
   */
  verifyToken: string | null;
  /** When Meta checked the address: heard while the page waited, or noted on the draft by an earlier visit. */
  addressCheckedAt?: string;
  /**
   * This page session saw Meta's check arrive (while it waited, or with the details' own check): the one moment the page
   * may say it came "just now". False when the check was read back from the draft, as on a later visit, and after the
   * details are checked anew, so a page never calls an old check new.
   */
  addressCheckedHere: boolean;
  /** Ten minutes passed without Meta's check. `error` also says so, until the wait starts again. */
  addressExpired: boolean;
  /** Meta delivers the account's messages to this app. */
  appSubscribed: boolean;
  /** Who said hi with the code. Once they have, GoatCitadel has stopped listening. */
  sender: WhatsAppSetupCodeSender | null;
  /** The code the operator sends the business number, while GoatCitadel is listening for it or after it expired. */
  code: string | null;
  /** The code ran out before anyone sent it. */
  codeExpired: boolean;
  busy: boolean;
  error?: string;
  /**
   * Stores all five details on the draft, then asks Meta about them. Starts the draft when there is none, marked as made
   * on this page before any secret is stored. A verify token is made and stored with them only when the draft has none
   * and the page holds none, so a check after a typo never breaks an address Meta already checked. Once Meta accepts
   * them, the page waits for Meta to check the address.
   */
  checkDetails(details: WhatsAppDetails): Promise<void>;
  /** Stores a new verify token and shows it, in place of any before. Not once Meta has checked the address. */
  newVerifyToken(): Promise<void>;
  /** Subscribes the app to the account's messages. Only when Meta says it isn't subscribed already. */
  subscribeApp(): Promise<void>;
  /** Starts the wait for Meta's check again, after it ran out. */
  checkAddressAgain(): void;
  /** Saves a fresh code on the draft and listens for it, in place of any code before it. */
  newCode(): Promise<void>;
  /** Discards the draft and its stored details. */
  startOver(): Promise<void>;
}

type Actions = "checkDetails" | "newVerifyToken" | "subscribeApp" | "checkAddressAgain" | "newCode" | "startOver";
type Core = Omit<WhatsAppSetupState, Actions>;
type Setter = (patch: Partial<Core>) => void;
type BusinessNumber = NonNullable<Core["number"]>;

/** Nobody said hi and no code: what goes with details that have just been checked. */
const NO_HI = { sender: null, code: null, codeExpired: false } as const;

const EMPTY: Core = {
  draft: null,
  number: null,
  tokenExpiresAt: undefined,
  verifyToken: null,
  addressCheckedAt: undefined,
  addressCheckedHere: false,
  addressExpired: false,
  appSubscribed: false,
  busy: false,
  error: undefined,
  ...NO_HI,
};

/**
 * WhatsApp's setup: the draft being built, the number its details belong to, the verify token Meta is given, whether
 * Meta has checked the address, and who said hi. Everything the draft holds is GoatCitadel's; this keeps the latest copy
 * it returned, because every write to a draft must carry the version the last one returned. The access token, the app
 * secret and the verify token go to the draft's secure store and no further: only the verify token is kept in memory,
 * for the operator to copy, and nothing the page reads from here quotes the other two.
 *
 * A setup made on this page goes on where it was left (`chatSetupToResume`): a draft Settings made is Settings'. When
 * all five details are stored, the page asks Meta about them again, so a token that has run out since is seen as it is
 * now. The address Meta checked, and who said hi, come back from the draft, so neither is asked for again.
 *
 * Waiting for Meta: once the details work, and until the draft notes that Meta checked the address, the page asks every
 * few seconds what GoatCitadel has heard. Nothing goes to Meta for that. When Meta has checked, the draft is saved once
 * with the time and the asking stops. It also stops after ten minutes (`addressExpired`; `checkAddressAgain` starts it
 * again), when the details are checked again, and when the page goes. A question that fails is asked again with the
 * next, and says nothing.
 *
 * Saying hi: `newCode` saves a one-time code on the draft and asks the same way whether anyone has sent it to the
 * business number. When they have, the draft is saved once with them as the only allowed sender and an owner, with their
 * WhatsApp as where it posts, and the asking stops. The two waits never overlap: a code opens only once Meta has checked
 * the address.
 */
export function useWhatsAppSetup(workspaceId: string, resumeDraftId?: string): WhatsAppSetupState {
  const { view, current, begin, reset } = useSetupState<Core>(EMPTY);
  // Counts the times what was going on was dropped (the page went, the workspace changed, the operator started over,
  // checked the details anew or asked for another wait), so a reply to something asked before changes nothing and
  // nothing more is asked or written for it.
  const generation = useRef(0);
  const stopAsking = useRef<(() => void) | null>(null);

  const invalidate = useCallback(() => {
    generation.current += 1;
    stopAsking.current?.();
    stopAsking.current = null;
  }, []);
  /** Starts following what is going on now: the returned function says whether it still is. */
  const follow = useCallback(() => {
    const mine = generation.current;
    return () => generation.current === mine;
  }, []);

  /** Notes on the draft that Meta checked the address, once, and stops waiting for it. */
  const noteAddress = useCallback(
    async (checkedAt: string, set: Setter, live: () => boolean) => {
      const draft = current().draft;
      // Never under a write that is going on: the draft's version would move on under this one.
      if (!draft || current().busy) return;
      const outcome = await saveWhatsAppDraft(draft, { ...draft.draft, webhookCheckedAt: checkedAt });
      if (!live()) return;
      if (outcome.kind === "failed") {
        // Meta's check stays known for 15 minutes. A wait that is running asks again with its next question and finds it,
        // so the note is tried again from the draft as it is now; `showCheck` starts a wait when none was running.
        set({ ...(outcome.latest ? { draft: outcome.latest } : {}), error: outcome.error });
        return;
      }
      invalidate();
      set({
        draft: outcome.draft,
        addressCheckedAt: checkedAt,
        addressCheckedHere: true,
        addressExpired: false,
        error: undefined,
      });
    },
    [current, invalidate],
  );

  /** Asks whether Meta has checked the address until it has, ten minutes pass, or listening stops. */
  const listenForAddress = useCallback(
    (set: Setter, live: () => boolean) => {
      const ask = async () => {
        const draft = current().draft;
        // Never under a write that is going on: the draft's version would move on under the question.
        if (!draft || current().busy || !live()) return;
        const heard = await askWhatHeard(draft);
        if (!live()) return;
        if (heard.addressCheckedAt) await noteAddress(heard.addressCheckedAt, set, live);
      };
      stopAsking.current = listenForHi(
        () => ask().catch(() => undefined),
        () => {
          if (!live()) return;
          invalidate();
          set({ addressExpired: true, error: WHATSAPP_ADDRESS_NOT_CHECKED });
        },
        WHATSAPP_LISTEN_POLL_MS,
      );
    },
    [current, invalidate, noteAddress],
  );

  /** Asks about `code` until it is heard, runs out, or listening stops. */
  const listenForCode = useCallback(
    (code: string, set: Setter, live: () => boolean) => {
      const hear = async (sender: WhatsAppSetupCodeSender) => {
        const draft = current().draft;
        if (!draft || current().busy) return;
        const outcome = await saveWhatsAppDraft(draft, whatsAppDraftWithSender(draft.draft, sender));
        if (!live()) return;
        if (outcome.kind === "failed") {
          // The next question finds the same hi and tries again, from the draft as it is now.
          set({ ...(outcome.latest ? { draft: outcome.latest } : {}), error: outcome.error });
          return;
        }
        invalidate();
        set({ draft: outcome.draft, sender, error: undefined });
      };
      const ask = async () => {
        const draft = current().draft;
        if (!draft || current().busy || !live()) return;
        const heard = await askWhatHeard(draft, code);
        if (!live()) return;
        if (heard.sender) await hear(heard.sender);
      };
      stopAsking.current = listenForHi(
        () => ask().catch(() => undefined),
        () => {
          if (!live()) return;
          invalidate();
          set({ codeExpired: true });
        },
        WHATSAPP_LISTEN_POLL_MS,
      );
    },
    [current, invalidate],
  );

  /** Shows what a check that worked found, then goes on to wait for Meta's check of the address if it has not come. */
  const showCheck = useCallback(
    async (
      draft: ChannelSetupDraft,
      number: BusinessNumber,
      check: WhatsAppSetupCheckResult,
      set: Setter,
      live: () => boolean,
    ) => {
      const noted = savedAddressCheckedAt(draft.draft) ?? current().addressCheckedAt;
      set({
        draft,
        number,
        tokenExpiresAt: check.tokenExpiresAt,
        appSubscribed: check.appSubscribed === true,
        ...(noted ? { addressCheckedAt: noted } : {}),
        busy: false,
        error: undefined,
      });
      if (noted || !live()) return;
      if (!check.addressCheckedAt) {
        listenForAddress(set, live);
        return;
      }
      await noteAddress(check.addressCheckedAt, set, live);
      // A note that failed leaves no wait running, and this one has to start it: its next question finds Meta's check
      // again and tries the note again. A note that went through has stopped waiting (it dropped `live`), and so has a
      // page that went or an action that took over, so nothing starts for those.
      if (live() && !current().addressCheckedAt) listenForAddress(set, live);
    },
    [current, listenForAddress, noteAddress],
  );

  useEffect(() => {
    const live = follow();
    const set = begin();
    void (async () => {
      set({ busy: true });
      let found: ChannelSetupDraft | null;
      try {
        const drafts = await fetchChannelSetupDrafts({ catalogId: WHATSAPP_CATALOG_ID });
        found = chatSetupToResume(drafts.items, WHATSAPP_CATALOG_ID, resumeDraftId);
      } catch {
        // Nothing to resume; the operator starts fresh. A draft left behind is found next time.
        set({ busy: false });
        return;
      }
      if (!live()) return;
      if (!found) {
        set({ busy: false });
        return;
      }
      set({ draft: found });
      if (!hasWhatsAppDetails(found)) {
        set({ busy: false });
        return;
      }
      let check: WhatsAppSetupCheckResult;
      try {
        check = await checkWhatsAppSetup({ draftId: found.draftId, expectedRevision: found.revision, askMeta: true });
      } catch (error) {
        if (live()) set({ busy: false, error: whatsAppFailure(error) });
        return;
      }
      if (!live()) return;
      if (!check.number) {
        set({ busy: false, error: WHATSAPP_CHECK_FAILED });
        return;
      }
      // Who said hi on an earlier visit comes back from the draft, so no new code is asked for.
      set({ sender: savedWhatsAppSender(found.draft) });
      await showCheck(found, check.number, check, set, live);
    })();
    return () => {
      invalidate();
      reset();
    };
  }, [workspaceId, resumeDraftId, begin, reset, follow, invalidate, showCheck]);

  const checkDetails = useCallback(
    async (details: WhatsAppDetails) => {
      if (current().busy) return;
      const clean = trimmedWhatsAppDetails(details);
      const problem = whatsAppDetailsProblem(clean);
      if (problem) {
        begin()({ error: problem });
        return;
      }
      invalidate();
      const live = follow();
      const set = begin();
      set({
        number: null,
        tokenExpiresAt: undefined,
        appSubscribed: false,
        addressCheckedHere: false,
        addressExpired: false,
        ...NO_HI,
        busy: true,
        error: undefined,
      });
      // A verify token is made only for a draft that has none, and only when the page does not hold one: the one Meta
      // may already have been given stays, and is not sent again.
      const held = current();
      const needsToken = !held.verifyToken && !held.draft?.secretState?.webhookVerifyToken?.configured;
      let draft: ChannelSetupDraft;
      let check: WhatsAppSetupCheckResult;
      try {
        draft = await storeWhatsAppDetails(held.draft, clean, needsToken ? createVerifyToken() : null, set);
        check = await checkWhatsAppSetup({ draftId: draft.draftId, expectedRevision: draft.revision, askMeta: true });
      } catch (error) {
        // The details may have been stored before the failure, which moved the draft's version on.
        const id = current().draft?.draftId;
        const latest = id ? await latestDraft(id) : null;
        set({ ...(latest ? { draft: latest } : {}), busy: false, error: whatsAppFailure(error) });
        return;
      }
      if (!check.number) {
        set({ draft, busy: false, error: WHATSAPP_CHECK_FAILED });
        return;
      }
      await showCheck(draft, check.number, check, set, live);
    },
    [begin, current, follow, invalidate, showCheck],
  );

  const newVerifyToken = useCallback(async () => {
    const { draft, addressCheckedAt, busy } = current();
    // After Meta's check, a new token would break an address that works.
    if (!draft || addressCheckedAt || busy) return;
    // The wait for Meta's check stops while the token is written, so its ten minutes ending can't drop the write's own
    // answer and leave the page busy. It starts again below.
    const waiting = stopAsking.current !== null;
    invalidate();
    const live = follow();
    const set = begin();
    const token = createVerifyToken();
    set({ busy: true, error: undefined });
    try {
      const stored = await submitChannelSetupDraftSecrets(draft.draftId, {
        expectedRevision: draft.revision,
        values: { webhookVerifyToken: token },
      });
      if (!live()) return;
      set({ draft: stored, verifyToken: token, addressExpired: false, busy: false });
    } catch (error) {
      const latest = await latestDraft(draft.draftId);
      set({ ...(latest ? { draft: latest } : {}), busy: false, error: whatsAppFailure(error) });
      // Meta may still check the address with the token it has, so a wait that was running goes on.
      if (waiting && live()) listenForAddress(set, live);
      return;
    }
    // Meta checks with the new token, so the wait starts over.
    if (!current().number) return;
    invalidate();
    listenForAddress(set, follow());
  }, [begin, current, follow, invalidate, listenForAddress]);

  const subscribeApp = useCallback(async () => {
    const { draft, number, appSubscribed, busy } = current();
    // Only when Meta says the app is not subscribed: there is nothing to write otherwise.
    if (!draft || !number || appSubscribed || busy) return;
    const set = begin();
    set({ busy: true, error: undefined });
    try {
      await subscribeWhatsAppSetupApp({ draftId: draft.draftId, expectedRevision: draft.revision });
      set({ appSubscribed: true, busy: false });
    } catch (error) {
      set({ busy: false, error: whatsAppFailure(error) });
    }
  }, [begin, current]);

  const checkAddressAgain = useCallback(() => {
    const { draft, number, addressCheckedAt, busy } = current();
    if (!draft || !number || addressCheckedAt || busy) return;
    invalidate();
    const live = follow();
    const set = begin();
    set({ addressExpired: false, error: undefined });
    listenForAddress(set, live);
  }, [begin, current, follow, invalidate, listenForAddress]);

  const newCode = useCallback(async () => {
    const { draft, number, addressCheckedAt, busy } = current();
    // A code opens only once Meta has checked the address, so the two waits never overlap.
    if (!draft || !number || !addressCheckedAt || busy) return;
    invalidate();
    const live = follow();
    const set = begin();
    const code = createSetupCode();
    set({ ...NO_HI, busy: true, error: undefined });
    const outcome = await saveWhatsAppDraft(draft, { ...draft.draft, setupCode: code });
    // The page may have gone while the code was being saved: then nothing may start listening for it.
    if (!live()) return;
    if (outcome.kind === "failed") {
      set({ ...(outcome.latest ? { draft: outcome.latest } : {}), busy: false, error: outcome.error });
      return;
    }
    set({ draft: outcome.draft, code, busy: false });
    listenForCode(code, set, live);
  }, [begin, current, follow, invalidate, listenForCode]);

  const startOver = useCallback(async () => {
    const { draft, busy } = current();
    if (busy) return;
    if (!draft) {
      invalidate();
      reset();
      return;
    }
    const set = begin();
    set({ busy: true, error: undefined });
    try {
      await discardChannelSetupDraft(draft.draftId, draft.revision);
      invalidate();
      reset();
    } catch (error) {
      set({ busy: false, error: describeApiError(error).summary });
    }
  }, [begin, current, invalidate, reset]);

  return { ...view, checkDetails, newVerifyToken, subscribeApp, checkAddressAgain, newCode, startOver };
}
