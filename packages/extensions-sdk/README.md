# GoatCitadel Extensions SDK

Workspace SDK package for people who build against GoatCitadel's tool catalog and people who write plugins.

## Current Scope

Version 2.0.0 holds two things. The first is the compact effective-tool
snapshot helpers. They consume the callable catalogs and schema refs that the
GoatCitadel Gateway owns.

- `validateCompactToolDirectorySnapshot` checks that a snapshot has the expected
  shape
- `listEffectiveCallableTools`, `findEffectiveToolByName` and
  `buildToolSchemaRefIndex` read a snapshot
- `dereferenceEffectiveToolSchema` fetches one tool's schema through a function
  you supply

These helpers read data. They grant nothing, activate nothing and run nothing.

The second is the plugin manifest check. A plugin is a bundle of skills,
connectors, tool group holds, observe-only hooks and prompt packs that runs no
code, and its manifest is `goatcitadel-plugin.json`.

- `parsePluginManifest(text)` checks a manifest's text. It answers the parsed
  manifest and its SHA-256, or a refusal with a code and the field at fault
- `pluginManifestSchema` is the strict schema behind it
- `loadPluginManifest(dir)` reads and checks the manifest in a plugin folder.
  It reads that one file, at most 64 KiB plus one byte of it, refuses a link,
  and never runs or imports anything from the folder
- `PLUGIN_MANIFEST_FILENAME` and `PLUGIN_LIMITS` are the file name and the limits

Checking a manifest installs nothing and grants nothing. The GoatCitadel
Gateway inspects, installs and uninstalls plugins through its Capabilities API,
governed by Change Plans. Mission Control has no Plugins tab yet, and there is
no plugin trust or marketplace surface.

## Check a plugin

```bash
# from a project that depends on this package
pnpm exec goatcitadel-plugin-preflight path/to/your-plugin

# in the GoatCitadel repo, after `pnpm --filter @goatcitadel/extensions-sdk build`
node packages/extensions-sdk/dist/plugin-preflight-cli.js path/to/your-plugin
```

It prints `ok <pluginId> <manifestSha256>` and exits 0, or prints the refusal
code and message and exits 1. A manifest cannot carry feature flags, chat
instructions or a hook that changes what happens or runs code, and a connector
cannot ask first about nothing; the command refuses each by name.

`templates/plugins/reference-plugin/` holds a small working plugin: a manifest,
one skill and one prompt pack. Copy it to start.

## What 2.0.0 removed

Integration plugins and add-ons are retired, and their helpers left the SDK with
them: the add-on and integration-plugin manifest validators, the
configuration-form helpers, the static author preflight and the
`goatcitadel-extension-preflight` command. The plugin manifest check above
replaces them.

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
