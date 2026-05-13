import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BridgeConfig, BridgeState } from "./types.js";

const configSchema = z.object({
  botToken: z.string().min(1).optional(),
  defaultWorkspace: z.string().min(1),
  codexCommand: z.string().min(1).default("codex")
});

const sessionSchema = z.object({
  key: z.string(),
  name: z.string(),
  codexSessionId: z.string().optional(),
  workspace: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const stateSchema = z.object({
  ownerUserId: z.number().int().optional(),
  currentSessionKey: z.string().optional(),
  sessions: z.record(z.string(), sessionSchema).default({})
});

export function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function getBridgeHome(): string {
  return path.join(getCodexHome(), "telegram-bridge");
}

export function getConfigPath(): string {
  return path.join(getBridgeHome(), "config.json");
}

export function getStatePath(): string {
  return path.join(getBridgeHome(), "state.json");
}

export function defaultConfig(): BridgeConfig {
  return {
    defaultWorkspace: process.env.CODEX_TELEGRAM_BRIDGE_WORKSPACE || process.cwd(),
    codexCommand: process.env.CODEX_TELEGRAM_BRIDGE_CODEX || "codex"
  };
}

export function defaultState(): BridgeState {
  return { sessions: {} };
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Windows may ignore POSIX file modes; the file still lives under the user profile.
  }
}

export class ConfigStore {
  constructor(private readonly filePath = getConfigPath()) {}

  async read(): Promise<BridgeConfig> {
    const raw = await readJsonFile(this.filePath, defaultConfig());
    return configSchema.parse({ ...defaultConfig(), ...raw });
  }

  async write(config: BridgeConfig): Promise<void> {
    await writeJsonFile(this.filePath, configSchema.parse(config));
  }

  async update(updater: (config: BridgeConfig) => BridgeConfig | Promise<BridgeConfig>): Promise<BridgeConfig> {
    const next = await updater(await this.read());
    await this.write(next);
    return next;
  }
}

export class StateStore {
  constructor(private readonly filePath = getStatePath()) {}

  async read(): Promise<BridgeState> {
    const raw = await readJsonFile(this.filePath, defaultState());
    return stateSchema.parse({ ...defaultState(), ...raw });
  }

  async write(state: BridgeState): Promise<void> {
    await writeJsonFile(this.filePath, stateSchema.parse(state));
  }

  async update(updater: (state: BridgeState) => BridgeState | Promise<BridgeState>): Promise<BridgeState> {
    const next = await updater(await this.read());
    await this.write(next);
    return next;
  }
}
