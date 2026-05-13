import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexClient } from "../src/codex.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("CodexClient", () => {
  it("runs new and resumed sessions through a mock codex command", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-client-"));
    const argsPath = path.join(tempDir, "args.jsonl");
    const fakeCodex = path.join(tempDir, "fake-codex.mjs");
    await writeFile(
      fakeCodex,
      `
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(args) + "\\n");
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex !== -1) writeFileSync(args[outputIndex + 1], "fake final");
console.log(JSON.stringify({ type: "session_meta", payload: { id: "019e21dd-4ea5-7213-8144-584af99a5fcc" } }));
`,
      "utf8"
    );

    const previous = process.env.FAKE_CODEX_ARGS;
    process.env.FAKE_CODEX_ARGS = argsPath;
    try {
      const client = new CodexClient({
        codexCommand: process.execPath,
        codexBaseArgs: [fakeCodex],
        defaultWorkspace: tempDir
      });

      const imagePath = path.join(tempDir, "image.jpg");
      const created = await client.runNewSession("hello", { imagePaths: [imagePath] });
      const resumed = await client.resumeSession("019e21dd-4ea5-7213-8144-584af99a5fcc", "again");

      expect(created.finalMessage).toBe("fake final");
      expect(resumed.finalMessage).toBe("fake final");

      const calls = (await readFile(argsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls[0].slice(0, 2)).toEqual(["exec", "--json"]);
      expect(calls[0]).toContain("--image");
      expect(calls[0][calls[0].indexOf("--image") + 1]).toBe(imagePath);
      expect(calls[1].slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    } finally {
      if (previous === undefined) delete process.env.FAKE_CODEX_ARGS;
      else process.env.FAKE_CODEX_ARGS = previous;
    }
  });

  it("retries transient connection failures before a turn starts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-client-retry-"));
    const argsPath = path.join(tempDir, "args.jsonl");
    const attemptsPath = path.join(tempDir, "attempts.txt");
    const fakeCodex = path.join(tempDir, "fake-retry-codex.mjs");
    await writeFile(
      fakeCodex,
      `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(args) + "\\n");
const attemptsPath = process.env.FAKE_CODEX_ATTEMPTS;
const attempt = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) + 1 : 1;
writeFileSync(attemptsPath, String(attempt));
if (attempt === 1) {
  console.error("failed to connect to websocket: IO error: tls handshake eof");
  process.exit(1);
}
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex !== -1) writeFileSync(args[outputIndex + 1], "retried final");
console.log(JSON.stringify({ type: "session_meta", payload: { id: "019e21dd-4ea5-7213-8144-584af99a5fcc" } }));
`,
      "utf8"
    );

    const previousArgs = process.env.FAKE_CODEX_ARGS;
    const previousAttempts = process.env.FAKE_CODEX_ATTEMPTS;
    process.env.FAKE_CODEX_ARGS = argsPath;
    process.env.FAKE_CODEX_ATTEMPTS = attemptsPath;
    try {
      const client = new CodexClient({
        codexCommand: process.execPath,
        codexBaseArgs: [fakeCodex],
        defaultWorkspace: tempDir
      });

      const result = await client.runNewSession("hello");

      expect(result.finalMessage).toBe("retried final");
      expect(await readFile(attemptsPath, "utf8")).toBe("2");
    } finally {
      if (previousArgs === undefined) delete process.env.FAKE_CODEX_ARGS;
      else process.env.FAKE_CODEX_ARGS = previousArgs;
      if (previousAttempts === undefined) delete process.env.FAKE_CODEX_ATTEMPTS;
      else process.env.FAKE_CODEX_ATTEMPTS = previousAttempts;
    }
  });
});
