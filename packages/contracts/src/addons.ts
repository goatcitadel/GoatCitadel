export type AddonTrustTier = "trusted" | "restricted" | "community";
export type AddonRuntimeType = "separate_repo_app";
export type AddonWebEntryMode = "none" | "external_local_url" | "embedded_proxy";
export type AddonRuntimeStatus = "not_installed" | "installed" | "running" | "stopped" | "error";
export type AddonHealthStatus = "pass" | "warn" | "fail";

export interface AddonInstallCommand {
  command: string;
  args?: string[];
  note?: string;
}

export interface AddonAuthorManifest {
  schemaVersion: 1;
  addon: AddonCatalogEntry;
  authorNotes?: string;
}

export interface AddonHealthCheckRecord {
  key: string;
  status: AddonHealthStatus;
  message: string;
}

export interface AddonCatalogEntry {
  addonId: string;
  label: string;
  description: string;
  owner: string;
  repoUrl: string;
  sameOwnerAsGoatCitadel: boolean;
  trustTier: AddonTrustTier;
  category: "fun_optional" | "productivity" | "other";
  runtimeType: AddonRuntimeType;
  installCommands: AddonInstallCommand[];
  webEntryMode: AddonWebEntryMode;
  requiresSeparateRepoDownload: true;
  launchUrl?: string;
  healthChecks: AddonHealthCheckRecord[];
}

export interface AddonInstalledRecord {
  addonId: string;
  installedPath: string;
  repoUrl: string;
  owner: string;
  sameOwnerAsGoatCitadel: boolean;
  trustTier: AddonTrustTier;
  runtimeType: AddonRuntimeType;
  webEntryMode: AddonWebEntryMode;
  launchUrl?: string;
  installRef?: string;
  installedAt: string;
  updatedAt: string;
  consentedAt: string;
  consentedBy: string;
  runtimeStatus: AddonRuntimeStatus;
  pid?: number;
  lastError?: string;
}

export interface AddonStatusRecord {
  addon: AddonCatalogEntry;
  installed?: AddonInstalledRecord;
  status: AddonRuntimeStatus;
  healthChecks: AddonHealthCheckRecord[];
}

export interface AddonInstallRequest {
  confirmRepoDownload: boolean;
  actorId?: string;
}

export interface AddonActionResponse {
  status: AddonStatusRecord;
}

export interface AddonUninstallResponse {
  addonId: string;
  removed: boolean;
}
