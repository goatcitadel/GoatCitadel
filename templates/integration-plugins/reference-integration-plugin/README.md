# Reference Integration Plugin

This directory is the current repo-native install target for the integration-plugin reference path.

## Purpose

Use it to prove the existing plugin lifecycle end to end:

- install from a local source path
- discover the installed plugin in Mission Control and gateway routes
- enable or disable it
- report its metadata honestly through the plugin registry

## Install Source

Use this directory path as the install source in Mission Control:

- `templates/integration-plugins/reference-integration-plugin/`

The gateway installer reads `goatcitadel.integration-plugin.json` from this directory and uses it to populate plugin metadata.

## What This Scaffold Does Not Prove Yet

- a published SDK package
- a remote package registry flow
- plugin-specific runtime execution beyond lifecycle reporting
