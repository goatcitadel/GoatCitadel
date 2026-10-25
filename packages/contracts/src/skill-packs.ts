/**
 * Skill packs shipped in the repository under `skills/import-packs/<packId>`. They are not loaded as
 * skills: an operator brings one in through Skill Hub source review, then installs and activates it
 * through the usual approvals. The Gateway resolves each id to its own directory; callers never
 * supply a path.
 */
export interface ShippedSkillPack {
  packId: string;
  label: string;
  summary: string;
  /** The command-line program the operator installs and signs in to, outside GoatCitadel. */
  requiresCli: string;
  setupUrl: string;
  upstream: string;
  license: string;
}

// Google CLI/OAuth skills (OpenClaw `gog`) are not shipped: native Google sign-in covers Google Workspace,
// and no CLI skill ships for a natively integrated service. The `google_cli_oauth` admission rule stays.
export const SHIPPED_SKILL_PACKS: readonly ShippedSkillPack[] = [
  {
    packId: "himalaya",
    label: "Email over IMAP/SMTP (Himalaya)",
    summary: "Read, search, organise and send mail for any IMAP/SMTP account.",
    requiresCli: "himalaya",
    setupUrl: "https://github.com/pimalaya/himalaya",
    upstream: "OpenClaw skills/himalaya",
    license: "MIT",
  },
  {
    packId: "github-cli",
    label: "GitHub (gh CLI)",
    summary: "Issues, pull requests, checks, runs and the GitHub API through gh.",
    requiresCli: "gh",
    setupUrl: "https://cli.github.com",
    upstream: "OpenClaw skills/github",
    license: "MIT",
  },
];

export function findShippedSkillPack(packId: string): ShippedSkillPack | undefined {
  return SHIPPED_SKILL_PACKS.find((pack) => pack.packId === packId);
}
