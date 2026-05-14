import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { syncCodexDesktopThread, upsertCodexSessionIndex } from "../src/codex.js";

let tempDir: string | undefined;
const hasSqlite = await commandAvailable("sqlite3");

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("session index helpers", () => {
  it("upserts session_index entries for sessions created outside the desktop app", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-session-index-"));
    const id = "019e21dd-4ea5-7213-8144-584af99a5fcc";

    await upsertCodexSessionIndex(id, "New conversation", tempDir, "2026-05-13T00:00:00.000Z");
    await upsertCodexSessionIndex(id, "First real prompt", tempDir, "2026-05-13T00:01:00.000Z");

    const raw = await readFile(path.join(tempDir, "session_index.jsonl"), "utf8");
    const lines = raw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id,
      thread_name: "First real prompt",
      updated_at: "2026-05-13T00:01:00.000Z"
    });
  });

  it("preserves existing desktop app titles when refreshing session_index", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-session-index-preserve-"));
    const id = "019e21dd-4ea5-7213-8144-584af99a5fcc";
    await writeFile(
      path.join(tempDir, "session_index.jsonl"),
      `${JSON.stringify({ id, thread_name: "Desktop generated title", updated_at: "2026-05-13T00:00:00.000Z" })}\n`
    );

    await upsertCodexSessionIndex(id, "First real prompt", tempDir, "2026-05-13T00:01:00.000Z");

    const raw = await readFile(path.join(tempDir, "session_index.jsonl"), "utf8");
    const entry = JSON.parse(raw.trim());
    expect(entry.thread_name).toBe("Desktop generated title");
    expect(entry.updated_at).toBe("2026-05-13T00:01:00.000Z");
  });

  it.runIf(hasSqlite)("marks exec-created sessions as desktop-visible threads", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-desktop-sync-"));
    const id = "019e21dd-4ea5-7213-8144-584af99a5fcc";
    const workspace = "E:\\MyProjects\\Codex-TelegramBridge";
    const sessionsDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await mkdir(sessionsDir, { recursive: true });
    const rolloutPath = path.join(sessionsDir, `rollout-test-${id}.jsonl`);
    await writeFile(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id, cwd: workspace, timestamp: "2026-05-14T00:00:00.000Z", source: "exec" } })}\n`
    );
    const dbPath = path.join(tempDir, "state_5.sqlite");
    await sqlite(dbPath, [
      "CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, first_user_message TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_at_ms INTEGER);",
      `INSERT INTO threads VALUES ('${id}', 'exec', '${workspace}', 'old title', '', 0, 0);`
    ].join(""));

    await syncCodexDesktopThread(id, "New conversation", workspace, tempDir, 1778734070447);

    const row = await sqlite(dbPath, `select source, cwd, title, first_user_message, updated_at, updated_at_ms from threads where id='${id}';`);
    expect(row.trim()).toBe("vscode|\\\\?\\E:\\MyProjects\\Codex-TelegramBridge|New conversation|New conversation|1778734070|1778734070447");
    const firstLine = (await readFile(rolloutPath, "utf8")).split(/\r?\n/, 1)[0];
    expect(JSON.parse(firstLine).payload.source).toBe("vscode");
  });
});

function sqlite(dbPath: string, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("sqlite3", [dbPath, sql], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], (error) => {
      resolve(!error);
    });
  });
}
