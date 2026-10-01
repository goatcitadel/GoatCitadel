import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchDeviceAccessGrants } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import {
  deviceGrantCanBeRevoked,
  useDeviceAccessRevocation,
} from "../../../features/native-routes/settings/use-device-access-revocation";
import { GatewayAuthSettings } from "./GatewayAuthSettings";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { Button } from "../../ui/Button";

const PAGE_SIZE = 20;
const dateLabel = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not recorded";

export function DeviceAccessSettings() {
  const devices = useQuery({ queryKey: ["settings", "device-grants"], queryFn: () => fetchDeviceAccessGrants("all") });
  const control = useDeviceAccessRevocation();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const ready = !devices.isError && Array.isArray(devices.data?.items);
  const grants = ready ? devices.data!.items : [];
  const review = control.reviewed;
  return (
    <>
    <GatewayAuthSettings />
    <section
      id="device-access"
      aria-labelledby="device-access-title"
      className="mt-4 rounded-lg border border-line bg-sunken p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="device-access-title" className="font-display text-base font-semibold text-fg">
            Approved devices
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Device grants for this Gateway installation, across all workspaces.
          </p>
        </div>
        <Button size="sm" disabled={devices.isFetching} onClick={() => void devices.refetch()}>
          Refresh devices
        </Button>
      </div>
      {devices.isLoading ? (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          Loading device grants…
        </p>
      ) : null}
      {devices.isError ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          {describeApiError(devices.error).summary}
        </p>
      ) : null}
      {devices.data && !devices.isError && !ready ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          Device grant evidence is unavailable. Refresh before deciding.
        </p>
      ) : null}
      {control.notice ? (
        <p role={control.notice.tone === "error" ? "alert" : "status"} className="mt-3 text-sm text-fg-secondary">
          {control.notice.message}
        </p>
      ) : null}
      {ready && !grants.length ? <p className="mt-3 text-sm text-fg-muted">No device grants recorded.</p> : null}
      <ul className="mt-3 space-y-3">
        {grants.slice(0, limit).map((grant) => {
          const active = deviceGrantCanBeRevoked(grant);
          const attempt = control.attemptFor(grant.grantId);
          const state = grant.revokedAt
            ? "Revoked"
            : grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()
              ? "Expired"
              : active
                ? "Active"
                : "Unavailable";
          return (
            <li key={grant.grantId} className="rounded-md border border-line bg-raised p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="break-words text-sm font-semibold text-fg">{grant.deviceLabel || "Unnamed device"}</h4>
                  <p className="mt-1 text-xs text-fg-muted">
                    {humanizeToken(grant.deviceType)}
                    {grant.platform ? ` · ${grant.platform}` : ""} · {state}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!active || Boolean(attempt) || devices.isFetching || Boolean(review)}
                  onClick={() => control.review(grant)}
                >
                  Revoke access
                </Button>
              </div>
              <dl className="mt-3 grid gap-2 text-xs text-fg-secondary sm:grid-cols-2">
                <div>
                  <dt>Approved</dt>
                  <dd>{dateLabel(grant.createdAt)}</dd>
                </div>
                <div>
                  <dt>Last used</dt>
                  <dd>{dateLabel(grant.lastUsedAt)}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{grant.expiresAt ? dateLabel(grant.expiresAt) : "No recorded expiry"}</dd>
                </div>
                <div>
                  <dt>Purpose</dt>
                  <dd>{humanizeToken(grant.principalPurpose || "unavailable")}</dd>
                </div>
              </dl>
              {attempt ? (
                <p role="status" className="mt-2 text-sm text-fg-secondary">
                  {attempt.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {grants.length > limit ? (
        <Button className="mt-3" size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
          Show more devices ({Math.min(limit, grants.length)} of {grants.length})
        </Button>
      ) : null}
      <p className="mt-3 text-xs text-fg-muted">
        Revoking a grant also revokes its companion sessions and bound session controls. The device must be approved
        again to regain access.
      </p>
      <ClassicOwnerLink href="/settings/access?shell=classic" scope={getGatewayApiBaseUrl()} label="Desktop and mobile continuity" />
      <ConfirmModal
        open={Boolean(review)}
        danger
        title="Revoke device access?"
        confirmLabel="Revoke device access"
        cancelLabel="Keep access"
        message={`Revoke access for ${review?.deviceLabel || "this device"} on this Gateway? Its companion sessions and session controls will also be revoked. This can disconnect the current device. A new approval is needed to regain access.`}
        pending={control.pending}
        confirmDisabled={!review || !deviceGrantCanBeRevoked(review)}
        onCancel={control.cancel}
        onConfirm={() =>
          void control.confirm().then((revoked) => {
            if (revoked) void devices.refetch();
          })
        }
      />
    </section>
    </>
  );
}
