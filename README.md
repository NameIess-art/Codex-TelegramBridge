# Codex Telegram Bridge

Telegram bridge for local Codex CLI conversations. It runs as a Codex MCP server, stores the Telegram Bot token locally, and starts the Bot when Codex loads the tool.

## Install

```powershell
npm install
npm run install:codex
```

Restart Codex, then call `telegram_bridge_enable` with your Telegram Bot Token.

## Telegram Commands

- `/start` binds the first Telegram user as owner.
- `/new [name]` creates and switches to a new Codex conversation.
- `/list` lists recorded conversations.
- `/switch <id|name>` switches the active conversation.
- `/rename <name>` renames the active conversation.
- `/current` shows the active conversation.
- `/status` shows bridge status.
- `/reset-owner` clears owner binding.
- `/help` shows command help.

Only the bound owner can use the Bot. Codex is launched with `danger-full-access` as requested, so keep the Bot token private.
