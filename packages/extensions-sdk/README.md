# GoatCitadel Extension SDK

Local workspace SDK package for GoatCitadel add-on and integration-plugin authors.

## Current Scope

- add-on manifest schemas and validation helpers
- integration-plugin manifest schemas and validation helpers
- compact effective-tool snapshot helpers that consume Gateway-owned callable catalogs and schema refs
- manifest filename constants
- file-loading and source-resolution helpers for repo-native author flows
- optional versioned configuration-form metadata and static author preflight

## Author preflight and configuration metadata

`IntegrationPluginAuthorManifest.configurationForm` is optional; older manifests
remain valid. Version `goatcitadel.extension-configuration.v1` supports bounded
text, URL, number, boolean, choice and secret-reference fields, prerequisites and
a sample-task description. Secret-reference fields have no value, default or
example slot. Use the Gateway credential owner for actual credentials. URL
defaults cannot embed credentials or query parameters. This is metadata for
review, not an install script, tool grant or callable runtime contract.

The exported `preflightIntegrationPluginAuthorManifest(manifest, configuredKeys)`
uses the same validation and descriptor hash as installation. It reports missing
required key names; it never receives their values. `declared_configured` is an
author declaration, and `default_available` is only a proposed default. Neither
establishes a working connection. The reference scaffold is included in starter
pack exports and the package templates.

From the repository root:

```text
pnpm --filter @goatcitadel/extensions-sdk build
node packages/extensions-sdk/dist/author-preflight-cli.js templates/integration-plugins/reference-integration-plugin
```

The next package build also exposes `goatcitadel-extension-preflight LOCAL_SOURCE`
with optional `--configured-key=NAME` arguments. Do not pass configuration or
secret values on the command line. Successful preflight proves descriptor shape
only; installation, enable/disable, live connection and actual task results need
their own governed lifecycle evidence. No package publication is implied.

## Current Boundary

- this package exists in the workspace and is also published to GitHub Packages as `@goatcitadel/extensions-sdk@1.0.0` on the `latest` tag
- broader runtime contracts still live in the main GoatCitadel repo contracts and gateway surfaces

## Release Workflow

For the next release, once GitHub Packages auth exists on the operator machine:

1. Log in once:
   ```bash
   pnpm login --scope=@goatcitadel --registry=https://npm.pkg.github.com
   ```
2. Run the dry run from the repo root:
   ```bash
   pnpm release:extensions-sdk:dry-run
   ```
3. Publish for real from the repo root:
   ```bash
   pnpm release:extensions-sdk
   ```

The publish wrapper runs `lint`, `test`, and `build` before `pnpm publish`.
It also derives the publish tag from the package version automatically:

- prerelease versions publish with `--tag beta`
- stable versions publish with `--tag latest`

If you need to publish directly from the package instead of the repo root:

```bash
pnpm --filter @goatcitadel/extensions-sdk publish:github
```
