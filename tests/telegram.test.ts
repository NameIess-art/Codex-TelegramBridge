import { describe, expect, it } from "vitest";
import { createAnswerRevealFrames, isListIndexQuery, parseCommandArgument, probeCodexNetwork, splitTelegramMessage } from "../src/telegram.js";

describe("telegram helpers", () => {
  it("splits long Telegram messages", () => {
    const chunks = splitTelegramMessage(`hello\n${"x".repeat(30)}`, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toContain("hello");
  });

  it("parses command arguments", () => {
    expect(parseCommandArgument("/new project notes")).toBe("project notes");
    expect(parseCommandArgument("/new")).toBe("");
  });

  it("detects /list numeric switch indexes", () => {
    expect(isListIndexQuery("1")).toBe(true);
    expect(isListIndexQuery(" 25 ")).toBe(true);
    expect(isListIndexQuery("0")).toBe(false);
    expect(isListIndexQuery("1abc")).toBe(false);
  });

  it("treats any HTTP response as reachable Codex network", async () => {
    const fetchImpl = async () => new Response("", { status: 403 });
    await expect(probeCodexNetwork(fetchImpl as typeof fetch)).resolves.toBe(true);
  });

  it("treats fetch failures as unavailable Codex network", async () => {
    const fetchImpl = async () => {
      throw new Error("tls handshake eof");
    };
    await expect(probeCodexNetwork(fetchImpl as typeof fetch)).resolves.toBe(false);
  });

  it("creates incremental answer reveal frames", () => {
    expect(createAnswerRevealFrames("", "one two three", 10)).toEqual(["one ", "one two ", "one two three"]);
    expect(createAnswerRevealFrames("one ", "one two three", 10)).toEqual(["one two ", "one two three"]);
  });
});
