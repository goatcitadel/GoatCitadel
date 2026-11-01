# Plugins that ship with GoatCitadel

This folder holds the plugins that ship with GoatCitadel, one folder per plugin, named by the plugin's id. Today it holds one: Browser checks (`browser-checks`), the Playwright Browser connector, set so everything it does asks first in Chat, and a skill for checking web pages step by step. GoatCitadel copies a plugin out of here and checks it like any other plugin source. Nothing in this folder is ever run.

A checkout and the Docker image read this folder in place. The release bundle copies it into the app's read-only `templates/plugins`, and a packaged install reads it there, never from its writable runtime folder.
