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

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

await bridge.start();
console.error("Codex Telegram Bridge daemon started.");

async function shutdown(): Promise<void> {
  await bridge.stop();
  process.exit(0);
}
