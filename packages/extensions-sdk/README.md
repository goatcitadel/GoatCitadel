# GoatCitadel Extensions SDK

Workspace SDK package for people who build against GoatCitadel's tool catalog.

## Current Scope

Version 2.0.0 keeps one thing: the compact effective-tool snapshot helpers. They
consume the callable catalogs and schema refs that the GoatCitadel Gateway
owns.

- `validateCompactToolDirectorySnapshot` checks that a snapshot has the expected
  shape
- `listEffectiveCallableTools`, `findEffectiveToolByName` and
  `buildToolSchemaRefIndex` read a snapshot
- `dereferenceEffectiveToolSchema` fetches one tool's schema through a function
  you supply

These helpers read data. They grant nothing, activate nothing and run nothing.

## What 2.0.0 removed

Integration plugins and add-ons are retired, and their helpers left the SDK with
them: the add-on and integration-plugin manifest validators, the
configuration-form helpers, the static author preflight and the
`goatcitadel-extension-preflight` command. A plugin manifest validator arrives
in a later release.

`@goatcitadel/extensions-sdk@1.0.0` is the last published version, and it still
carries those helpers. Version 2.0.0 is not published yet.

## Current Boundary

- this package lives in the GoatCitadel workspace and is published to GitHub
  Packages as `@goatcitadel/extensions-sdk`
- broader runtime contracts still live in the main GoatCitadel repo contracts and
  Gateway surfaces

## Release Workflow

Once GitHub Packages auth exists on the operator machine:

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
