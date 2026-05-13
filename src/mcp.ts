import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodexClient } from "./codex.js";
import { ConfigStore, StateStore } from "./storage.js";
import { TelegramBridge } from "./telegram.js";

const configStore = new ConfigStore();
const stateStore = new StateStore();
const bridge = new TelegramBridge({
  configStore,
  stateStore,
  codexFactory: (codexCommand, defaultWorkspace) => new CodexClient({ codexCommand, defaultWorkspace })
});

const server = new McpServer({
  name: "codex-telegram-bridge",
  version: "0.1.0"
});

server.registerTool(
  "telegram_bridge_enable",
  {
    title: "Enable Telegram bridge",
    description: "Save the Telegram Bot Token locally and start the Codex Telegram bridge.",
    inputSchema: {
      botToken: z.string().min(20).describe("Telegram Bot Token from BotFather.")
    }
  },
  async ({ botToken }) => {
    const config = await configStore.update((current) => ({ ...current, botToken }));
    await bridge.start();
    return textResult(
      [
        "Telegram bridge enabled.",
        `Default workspace: ${config.defaultWorkspace}`,
        "Open Telegram and send /start to the Bot. The first user becomes the owner."
      ].join("\n")
    );
  }
);

server.registerTool(
  "telegram_bridge_status",
  {
    title: "Telegram bridge status",
    description: "Show whether the bridge is configured, running, owner-bound, and how many sessions are recorded.",
    inputSchema: {}
  },
  async () => {
    const status = await bridge.status();
    return textResult(JSON.stringify(status, null, 2));
  }
);

server.registerTool(
  "telegram_bridge_disable",
  {
    title: "Disable Telegram bridge",
    description: "Stop the Telegram bridge. Optionally clear the saved Bot Token and owner binding.",
    inputSchema: {
      clearToken: z.boolean().optional().describe("Clear the saved Telegram Bot Token and owner binding.")
    }
  },
  async ({ clearToken }) => {
    await bridge.stop();
    if (clearToken) {
      await configStore.update((current) => {
        const { botToken: _botToken, ...rest } = current;
        return rest;
      });
      await stateStore.update((state) => ({ ...state, ownerUserId: undefined }));
    }
    return textResult(clearToken ? "Telegram bridge disabled and token cleared." : "Telegram bridge disabled.");
  }
);

await bridge.start();
await server.connect(new StdioServerTransport());

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }]
  };
}
