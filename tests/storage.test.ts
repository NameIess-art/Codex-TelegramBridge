import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, StateStore } from "../src/storage.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("storage", () => {
  it("persists config and state", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-storage-"));
    const configStore = new ConfigStore(path.join(tempDir, "config.json"));
    const stateStore = new StateStore(path.join(tempDir, "state.json"));

    await configStore.write({ botToken: "123456:token", defaultWorkspace: tempDir, codexCommand: "codex" });
    await stateStore.write({ ownerUserId: 42, currentSessionKey: "abc", sessions: {} });

    await expect(configStore.read()).resolves.toMatchObject({ botToken: "123456:token", defaultWorkspace: tempDir });
    await expect(stateStore.read()).resolves.toMatchObject({ ownerUserId: 42, sessions: {} });
  });
});
