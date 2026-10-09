import type { ChannelSettingsOwner } from "../sections/use-channel-settings";
import { Button } from "../../../../cockpit/ui/Button";

export function ChannelEntryControls({ owner }: { owner: ChannelSettingsOwner }) {
  const draft = owner.selectedDraft;
  const disabled = owner.entryBusy || owner.mutation.pending || Boolean(owner.mutation.uncertain) || owner.needsConnectionReview;
  if (draft?.catalogId === "channel.slack") {
    const attempt = owner.oauthAttempt;
    const current = attempt?.draftId === draft.draftId && attempt.workspaceId === owner.activeWorkspaceId;
    const pending = current && (attempt.status === "pending" || attempt.status === "exchanging");
    return <section aria-label="Slack authorization" className="min-w-0 space-y-3 rounded-md border border-line p-3 text-sm">
      <h4 className="font-semibold">Connect this Slack workspace</h4>
      <p>Authorization creates a staged install. Review its workspace and app before adding it to this draft.</p>
      {owner.oauthError ? <p role="alert">{owner.oauthError}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || Boolean(pending)} onClick={() => void owner.handleStartSlackOAuth()}>
          {attempt ? "Restart Slack authorization" : "Connect Slack with OAuth"}</Button>
        {attempt ? <Button disabled={disabled} onClick={() => void owner.refreshOAuthAttempt()}>Refresh authorization receipt</Button> : null}
        {pending || attempt?.status === "ready" ? <Button disabled={disabled} onClick={() => void owner.handleCancelSlackOAuth()}>Cancel authorization</Button> : null}
      </div>
      {owner.authorizationUrl && pending ? <a href={owner.authorizationUrl} target="_blank" rel="noopener noreferrer"
        className="break-words text-accent underline">Open the reviewed Slack authorization page</a> : null}
      {current ? <div className="space-y-2">
        <p role="status">Authorization: {attempt.status} · expires {new Date(attempt.expiresAt).toLocaleString()}</p>
        {attempt.install ? <dl className="space-y-1">
          <dt>Workspace</dt><dd>{attempt.install.teamName || attempt.install.teamId}</dd>
          <dt>Workspace ID</dt><dd className="break-all">{attempt.install.teamId}</dd>
          <dt>App and bot</dt><dd className="break-all">{attempt.install.appId} · {attempt.install.botUserId}</dd>
          <dt>Requested access</dt><dd className="break-words">{attempt.install.scopes.join(", ")}</dd>
        </dl> : null}
        {attempt.failureCode ? <p role="alert">{attempt.failureCode.replaceAll("_", " ")}. Refresh the receipt before retrying.</p> : null}
        {attempt.status === "ready" ? <>
          {owner.draftDirty || attempt.draftRevision !== draft.revision ?
            <p role="alert">The draft changed after authorization started. Keep your edits, save them, then restart authorization for the current revision.</p> : null}
          <Button className="h-auto min-h-10 max-w-full whitespace-normal py-2" variant="primary" disabled={disabled || owner.draftDirty || attempt.draftRevision !== draft.revision}
            onClick={() => void owner.handleAdoptSlackOAuth()}>Use this reviewed workspace and app</Button>
        </> : null}
      </div> : null}
    </section>;
  }
  if (draft?.catalogId !== "channel.telegram") return null;
  return <section aria-label="Discover Telegram destinations" className="min-w-0 space-y-3 rounded-md border border-line p-3 text-sm">
    <h4 className="font-semibold">Discover chats for this bot</h4>
    <p>Send /start or the setup code in the intended chat first. Discovery adds only the chats you select.</p>
    <Button disabled={disabled} onClick={() => void owner.handleDiscoverTelegramTargets()}>Detect Telegram chats</Button>
    {owner.discovery?.botIdentity ? <p>Bot: {owner.discovery.botIdentity.username || owner.discovery.botIdentity.label || owner.discovery.botIdentity.id}</p> : null}
    {owner.discovery?.warnings.map((warning) => <p key={warning} role="status">{warning}</p>)}
    {owner.discovery?.webhookActive ? <p role="status">A webhook is active. Accepted ingress and saved targets are used; discovery will not consume polling updates.</p> : null}
    {owner.discovery?.items.length ? <>
      <ul className="max-h-80 space-y-2 overflow-auto">{owner.discovery.items.map((item) => <li key={item.id}>
        <label className="flex min-h-10 items-start gap-2">
          <input type="checkbox" disabled={disabled || !owner.discoveryCurrent} checked={Boolean(owner.selectedCandidates[item.id])}
            onChange={(event) => owner.setSelectedCandidates((current) => ({ ...current, [item.id]: event.target.checked }))} />
          <span>{item.label}<span className="block break-all text-xs text-fg-muted">{item.chatId} · {item.kind} · {item.source.replaceAll("_", " ")}</span></span>
        </label>
      </li>)}</ul>
      {!owner.discoveryCurrent ? <p role="status">Draft input changed. Refresh discovery before selecting these candidates.</p> : null}
      <Button className="h-auto min-h-10 max-w-full whitespace-normal py-2" disabled={disabled || !owner.discoveryCurrent || !Object.values(owner.selectedCandidates).some(Boolean)}
        onClick={owner.handleMergeTelegramTargets}>Add selected chats without replacing destinations</Button>
    </> : null}
  </section>;
}
