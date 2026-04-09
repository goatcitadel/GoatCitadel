# GoatCitadel Extension SDK

Local workspace SDK package for GoatCitadel add-on and integration-plugin authors.

## Current Scope

- add-on manifest schemas and validation helpers
- integration-plugin manifest schemas and validation helpers
- manifest filename constants
- file-loading and source-resolution helpers for repo-native author flows

## Current Boundary

- this package exists in the workspace and is also published to GitHub Packages as `@goatcitadel/extensions-sdk@0.9.0-beta.1` on the `beta` tag
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

- prerelease versions such as `0.9.0-beta.1` publish with `--tag beta`
- stable versions publish with `--tag latest`

If you need to publish directly from the package instead of the repo root:

```bash
pnpm --filter @goatcitadel/extensions-sdk publish:github
```
