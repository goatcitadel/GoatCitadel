# Plugins that ship with GoatCitadel

This folder holds the plugins that ship with GoatCitadel, one folder per plugin, named by the plugin's id. Today it holds one: Browser checks (`browser-checks`), the Playwright Browser connector, saved so everything it does asks first in Chat (a Playwright Browser server you already saved is kept with its own setting), and a skill for checking web pages step by step. GoatCitadel copies a plugin out of here into a snapshot and checks it like any other plugin source. Nothing in this folder is ever run.

A checkout and the Docker image read this folder in place. The release bundle copies it into the app's `templates/plugins`, which only installing or updating a release replaces, and a packaged install reads it there, never from its writable runtime folder. When a packaged install's app folder can't be verified, no plugin is read as built in.
