#!/usr/bin/env node

const args = new Set(process.argv.slice(2));

if (args.has("--emit-plan")) {
  console.log(
    [
      "Stage B package-identity/MSIX lane is intentionally scaffolded, not enabled.",
      "Required proof before public release:",
      "- build/register package identity for the WinUI host",
      "- verify goatcitadel:// protocol registration",
      "- verify app notification click routing",
      "- verify install/uninstall cleanup",
      "- verify Authenticode/package signing",
    ].join("\n"),
  );
  process.exit(0);
}

console.error(
  [
    "package:windows-msix is the Stage B package-identity lane and is not enabled yet.",
    "Use pnpm package:windows-host for the Stage A WinUI host build.",
    "Pass --emit-plan to print the package-identity proof checklist.",
  ].join("\n"),
);
process.exit(1);
