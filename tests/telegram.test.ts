import { describe, expect, it } from "vitest";
import { parseCommandArgument, splitTelegramMessage } from "../src/telegram.js";

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
});
