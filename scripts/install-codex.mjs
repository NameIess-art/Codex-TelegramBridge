import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const mcpPath = path.join(repoRoot, "dist", "mcp.js");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const bridgeHome = path.join(codexHome, "telegram-bridge");
const configPath = path.join(bridgeHome, "config.json");

mkdirSync(bridgeHome, { recursive: true, mode: 0o700 });

const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const config = {
  defaultWorkspace: existing.defaultWorkspace || repoRoot,
  codexCommand: existing.codexCommand || "codex",
  ...(existing.botToken ? { botToken: existing.botToken } : {})
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

spawnSync("codex", ["mcp", "remove", "telegram-bridge"], {
  stdio: "ignore",
  shell: process.platform === "win32",
  windowsHide: true
});

const add = spawnSync("codex", ["mcp", "add", "telegram-bridge", "--", "node", mcpPath], {
  stdio: "inherit",
  shell: process.platform === "win32",
  windowsHide: true
});

if (add.status !== 0) {
  process.exit(add.status || 1);
}

console.log(`Codex Telegram Bridge installed: ${mcpPath}`);
console.log(`Bridge config: ${configPath}`);
