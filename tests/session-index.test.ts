import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertCodexSessionIndex } from "../src/codex.js";

let tempDir: string | undefined;

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
});
