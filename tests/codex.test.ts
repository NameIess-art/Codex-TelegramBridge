import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { extractSessionIdFromJsonl, listCodexWorkspaceSessions, parseCodexStreamEvent } from "../src/codex.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("codex helpers", () => {
  it("extracts session id from session metadata", () => {
    const id = "019e21dd-4ea5-7213-8144-584af99a5fcc";
    const jsonl = JSON.stringify({ type: "session_meta", payload: { id } });
    expect(extractSessionIdFromJsonl(jsonl)).toBe(id);
  });

  it("extracts session id from nested json events", () => {
    const id = "019e21dd-4ea5-7213-8144-584af99a5fcc";
    const jsonl = JSON.stringify({ event: { session_id: id } });
    expect(extractSessionIdFromJsonl(jsonl)).toBe(id);
  });

  it("parses stream reasoning and assistant messages", () => {
    expect(
      parseCodexStreamEvent(
        JSON.stringify({
          type: "response_item",
          payload: { type: "reasoning", summary: [{ text: "Inspecting files" }] }
        })
      )
    ).toEqual({ kind: "reasoning", text: "Inspecting files" });

    expect(
      parseCodexStreamEvent(
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ text: "Done" }] }
        })
      )
    ).toEqual({ kind: "message", text: "Done" });

    expect(
      parseCodexStreamEvent(
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "Done from exec" }
        })
      )
    ).toEqual({ kind: "message", text: "Done from exec" });
  });

  it("parses processed tool calls and outputs", () => {
    expect(
      parseCodexStreamEvent(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell_command",
            arguments: JSON.stringify({ command: "npm test", workdir: "E:\\MyProjects\\Codex-TelegramBridge" })
          }
        })
      )
    ).toEqual({ kind: "processed", text: "shell_command\nnpm test" });

    expect(
      parseCodexStreamEvent(
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call_output", output: "Exit code: 0\nOutput:\npassed" }
        })
      )
    ).toEqual({ kind: "processed", text: "Exit code: 0\nOutput:\npassed" });
  });

  it("lists sessions grouped by workspace", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-session-list-"));
    const sessionsDir = path.join(tempDir, "sessions", "2026", "05", "13");
    await mkdir(sessionsDir, { recursive: true });
    const id = "019e21dd-4ea5-7213-8144-584af99a5fcc";
    await writeFile(
      path.join(sessionsDir, `rollout-test-${id}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { id, cwd: "E:\\MyProjects\\AudioPlayer", timestamp: "2026-05-13T00:00:00.000Z" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "修复后台播放稳定性问题" }] } })
      ].join("\n")
    );

    const workspaces = await listCodexWorkspaceSessions(tempDir);

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].name).toBe("AudioPlayer");
    expect(workspaces[0].sessions[0]).toMatchObject({ id, title: "修复后台播放稳定性问题" });
  });

  it("uses Codex app thread_name from session_index before prompt text", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-session-title-"));
    const sessionsDir = path.join(tempDir, "sessions", "2026", "05", "13");
    await mkdir(sessionsDir, { recursive: true });
    const id = "019e21dd-4ea5-7213-8144-584af99a5fcc";
    await writeFile(path.join(tempDir, "session_index.jsonl"), JSON.stringify({ id, thread_name: "完成 Codex 集成" }));
    await writeFile(
      path.join(sessionsDir, `rollout-test-${id}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { id, cwd: "E:\\MyProjects\\Codex-TelegramBridge", timestamp: "2026-05-13T00:00:00.000Z" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "完成一个将codex应用中对话接入telegram远程对话的工具" }] } })
      ].join("\n")
    );

    const workspaces = await listCodexWorkspaceSessions(tempDir);

    expect(workspaces[0].sessions[0].title).toBe("完成 Codex 集成");
  });
});
