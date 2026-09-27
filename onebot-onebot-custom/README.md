# OneBot custom source

This directory is the editable source of the local OneBot extension. OpenClaw
loads `extensions/openclaw-onebot/dist/index.js`; do not edit its generated
`dist/src` files directly after migrating a feature here.

`npm run check` checks JavaScript syntax and runs focused unit tests without
touching the live plugin. `npm run deploy` validates, backs up existing files to
`state/backups/`, and copies only source-owned JS and declaration files into
the extension's `dist/` directory. Deployment does not restart the Gateway.

The current source is a snapshot of the installed plugin plus local changes.
Refactor modules one boundary at a time while preserving all external entry
points, session keys and shared approval state. Model and role routing remain
in `onebot-model-routing.json` and `onebot-role-routing.json`; provider and
agent registration remain in `openclaw.json`.

After deployment: validate the OpenClaw configuration, restart the user Gateway,
check both OneBot accounts reconnect, then test text, approval, fallback, media,
guest and conversation-mode flows. A successful syntax check alone does not
establish parity for the latter workflows.
