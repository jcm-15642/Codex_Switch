# Changelog

All notable changes to this project are documented in this file.

## [0.2.1] - 2026-07-24

- Preserve the exact text and formatting of every private-profile `auth.json` field except `OPENAI_API_KEY`.
- Show add and delete actions with codicon buttons and expose saved-profile editing in the command palette.

## [0.2.0] - 2026-07-24

- Added separate private API and official-account Profile types.
- Added secure official-account auth snapshots and the `Import Current Official Account` command.
- Preserved non-Key auth fields when switching to a private API Profile.
- Kept local Codex session, log, memory, and state files out of every switch operation.

## [0.1.4] - 2026-07-24

- Added grouped configuration backups, retention settings, restore, cleanup, and legacy-backup cleanup commands.
- Avoid creating backups when the target API configuration is unchanged.
- Added Profile rename support and a Reload Window action after a real switch.
- Added Remote-WSL-compatible packaging of runtime dependencies.
