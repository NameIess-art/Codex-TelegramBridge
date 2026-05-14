import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexRunResult } from "./types.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultCodexTimeoutMs = 180_000;

export interface CodexClientOptions {
  codexCommand: string;
  codexBaseArgs?: string[];
  defaultWorkspace: string;
  codexHome?: string;
}

export interface CodexSessionMeta {
  id: string;
  cwd?: string;
  timestamp?: string;
  title: string;
  filePath: string;
  mtimeMs: number;
}

export interface CodexWorkspaceSessions {
  cwd: string;
  name: string;
  sessions: CodexSessionMeta[];
  latestMtimeMs: number;
}

export interface CodexStreamEvent {
  kind: "reasoning" | "message" | "processed" | "status";
  text: string;
}

export interface CodexRunOptions {
  onEvent?: (event: CodexStreamEvent) => void | Promise<void>;
  imagePaths?: string[];
  timeoutMs?: number;
}

export class CodexError extends Error {
  constructor(
    message: string,
    readonly result: CodexRunResult
  ) {
    super(message);
    this.name = "CodexError";
  }
}

export class CodexClient {
  constructor(private readonly options: CodexClientOptions) {}

  async runNewSession(prompt: string, options: CodexRunOptions = {}): Promise<CodexRunResult> {
    const startedAt = Date.now();
    const outputPath = tempOutputPath();
    const args = [
      "exec",
      "--json",
      "--output-last-message",
      outputPath,
      ...imageArgs(options.imagePaths),
      "-C",
      this.options.defaultWorkspace,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-"
    ];
    return this.run(args, prompt, outputPath, startedAt, undefined, options);
  }

  async resumeSession(sessionId: string, prompt: string, options: CodexRunOptions = {}): Promise<CodexRunResult> {
    const startedAt = Date.now();
    const outputPath = tempOutputPath();
    const args = [
      "exec",
      "resume",
      "--json",
      "--output-last-message",
      outputPath,
      ...imageArgs(options.imagePaths),
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      sessionId,
      "-"
    ];
    return this.run(args, prompt, outputPath, startedAt, sessionId, options);
  }

  private async run(
    args: string[],
    prompt: string,
    outputPath: string,
    startedAt: number,
    knownSessionId?: string,
    options: CodexRunOptions = {}
  ): Promise<CodexRunResult> {
    const maxAttempts = 3;
    let lastResult: CodexRunResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await fs.rm(outputPath, { force: true }).catch(() => undefined);
      const { stdout, stderr, exitCode } = await spawnCodex(
        this.options.codexCommand,
        [...(this.options.codexBaseArgs || []), ...args],
        prompt,
        this.options.defaultWorkspace,
        options.onEvent,
        options.timeoutMs
      );
      const finalMessage = await readFinalMessage(outputPath, stdout);
      const sessionId =
        knownSessionId ||
        extractSessionIdFromJsonl(stdout) ||
        (await findLatestSessionId(this.options.codexHome, this.options.defaultWorkspace, startedAt));
      const result = { sessionId, finalMessage, stdout, stderr, exitCode };
      lastResult = result;

      if (exitCode === 0) {
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
        return result;
      }

      if (!shouldRetryCodexRun(result, attempt, maxAttempts)) {
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
        const details = stderr.trim() || stdout.trim() || `codex exited with code ${exitCode}`;
        throw new CodexError(details, result);
      }

      await options.onEvent?.({ kind: "status", text: `Connection failed, retrying ${attempt + 1}/${maxAttempts}` });
      await delay(1500 * attempt);
    }

    const result = lastResult || { finalMessage: "", stdout: "", stderr: "", exitCode: 1 };
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
    const details = result.stderr.trim() || result.stdout.trim() || `codex exited with code ${result.exitCode}`;
    throw new CodexError(details, result);
  }
}

function shouldRetryCodexRun(result: CodexRunResult, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) return false;
  if (hasStartedTurn(result.stdout)) return false;
  return isTransientCodexNetworkError(`${result.stderr}\n${result.stdout}`);
}

function hasStartedTurn(stdout: string): boolean {
  return /"type"\s*:\s*"turn\.started"|"type"\s*:\s*"thread\.started"/.test(stdout);
}

export function isTransientCodexNetworkError(text: string): boolean {
  return /tls handshake eof|unexpected EOF during handshake|failed to connect to websocket|error sending request|HTTP request failed/i.test(text);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function imageArgs(imagePaths: string[] | undefined): string[] {
  return (imagePaths || []).flatMap((imagePath) => ["--image", imagePath]);
}

function tempOutputPath(): string {
  return path.join(os.tmpdir(), `codex-telegram-bridge-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
}

function spawnCodex(
  command: string,
  args: string[],
  stdin: string,
  cwd: string,
  onEvent?: (event: CodexStreamEvent) => void | Promise<void>,
  timeoutMs = defaultCodexTimeoutMs
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      windowsHide: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let bufferedLine = "";
    let settled = false;
    const timeout = setTimeout(() => {
      stderr += `\nCodex CLI timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
      killProcessTree(child.pid);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      bufferedLine = consumeJsonlChunk(bufferedLine + chunk, onEvent);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (bufferedLine.trim()) {
        emitJsonlEvent(bufferedLine.trim(), onEvent);
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.end(stdin);
  });
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

function consumeJsonlChunk(text: string, onEvent?: (event: CodexStreamEvent) => void | Promise<void>): string {
  const lines = text.split(/\r?\n/);
  const tail = lines.pop() || "";
  for (const line of lines) {
    emitJsonlEvent(line, onEvent);
  }
  return tail;
}

function emitJsonlEvent(line: string, onEvent?: (event: CodexStreamEvent) => void | Promise<void>): void {
  if (!onEvent || !line.trim()) return;
  const event = parseCodexStreamEvent(line);
  if (event) void onEvent(event);
}

export function parseCodexStreamEvent(line: string): CodexStreamEvent | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object") return undefined;
  const objectEvent = event as Record<string, unknown>;

  const responseItem = objectEvent.type === "response_item" ? (objectEvent.payload as Record<string, unknown> | undefined) : undefined;
  if (responseItem?.type === "reasoning") {
    const text = extractReasoningText(responseItem);
    return text ? { kind: "reasoning", text } : undefined;
  }
  if (responseItem?.type === "message" && responseItem.role === "assistant") {
    const text = extractContentText(responseItem.content);
    return text ? { kind: "message", text } : undefined;
  }
  if (responseItem?.type === "function_call") {
    return { kind: "processed", text: renderToolCall(responseItem) };
  }
  if (responseItem?.type === "function_call_output") {
    const output = typeof responseItem.output === "string" ? responseItem.output : "";
    return output ? { kind: "processed", text: output } : undefined;
  }
  if (responseItem?.type === "custom_tool_call") {
    return { kind: "processed", text: renderToolCall(responseItem) };
  }
  if (responseItem?.type === "custom_tool_call_output") {
    const output = typeof responseItem.output === "string" ? responseItem.output : "";
    return output ? { kind: "processed", text: output } : undefined;
  }

  const eventMsg = objectEvent.type === "event_msg" ? (objectEvent.payload as Record<string, unknown> | undefined) : undefined;
  if (eventMsg?.type === "agent_message" && typeof eventMsg.message === "string") {
    return { kind: "message", text: eventMsg.message };
  }
  if (eventMsg?.type === "agent_reasoning" && typeof eventMsg.message === "string") {
    return { kind: "reasoning", text: eventMsg.message };
  }
  if (eventMsg?.type === "exec_command_begin" && typeof eventMsg.command === "string") {
    return { kind: "processed", text: `Running command: ${eventMsg.command}` };
  }
  if (eventMsg?.type === "exec_command_end") {
    const text = extractContentText(eventMsg.output) || extractContentText(eventMsg.message) || extractContentText(eventMsg);
    return text ? { kind: "processed", text } : undefined;
  }

  return undefined;
}

function renderToolCall(value: Record<string, unknown>): string {
  const name = typeof value.name === "string" ? value.name : "tool";
  const args = typeof value.arguments === "string" ? value.arguments : typeof value.input === "string" ? value.input : "";
  const parsedArgs = parseToolArguments(args);
  if (parsedArgs) return `${name}\n${parsedArgs}`;
  return args ? `${name}\n${args}` : name;
}

function parseToolArguments(args: string): string | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["command", "query", "path", "pattern"]) {
      if (typeof parsed[key] === "string") return parsed[key];
    }
    return JSON.stringify(parsed);
  } catch {
    return trimmed;
  }
}

function extractReasoningText(value: Record<string, unknown>): string | undefined {
  const summary = extractContentText(value.summary);
  if (summary) return summary;
  const content = extractContentText(value.content);
  return content || undefined;
}

function extractContentText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const part = item as Record<string, unknown>;
      for (const key of ["text", "message", "content", "summary_text"]) {
        if (typeof part[key] === "string") return part[key];
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

async function readFinalMessage(outputPath: string, stdout: string): Promise<string> {
  try {
    const raw = await fs.readFile(outputPath, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  } catch {
    // Fall through to stdout parsing.
  }
  return extractFinalMessageFromJsonl(stdout) || stdout.trim();
}

export function extractSessionIdFromJsonl(jsonl: string): string | undefined {
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as unknown;
      const id = extractSessionIdFromValue(event);
      if (id) return id;
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractSessionIdFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const objectValue = value as Record<string, unknown>;

  if (objectValue.type === "session_meta") {
    const id = (objectValue.payload as Record<string, unknown> | undefined)?.id;
    if (typeof id === "string" && uuidPattern.test(id)) return id;
  }

  for (const key of ["session_id", "sessionId", "sessionID"]) {
    const candidate = objectValue[key];
    if (typeof candidate === "string" && uuidPattern.test(candidate)) return candidate;
  }

  for (const nested of Object.values(objectValue)) {
    const candidate = extractSessionIdFromValue(nested);
    if (candidate) return candidate;
  }

  return undefined;
}

function extractFinalMessageFromJsonl(jsonl: string): string | undefined {
  let finalText: string | undefined;
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const text = findText(event);
      if (text) finalText = text;
    } catch {
      continue;
    }
  }
  return finalText;
}

function findText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const objectValue = value as Record<string, unknown>;
  for (const key of ["text", "message", "content", "final_message", "finalMessage"]) {
    const candidate = objectValue[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  for (const nested of Object.values(objectValue)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const candidate = findText(item);
        if (candidate) return candidate;
      }
    } else {
      const candidate = findText(nested);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

async function findLatestSessionId(codexHome: string | undefined, workspace: string, startedAt: number): Promise<string | undefined> {
  const latest = await findLatestCodexSession(codexHome, workspace, startedAt - 120_000);
  return latest?.id;
}

export async function findLatestCodexSession(
  codexHome: string | undefined,
  workspace: string,
  minMtimeMs = 0
): Promise<CodexSessionMeta | undefined> {
  const sessions = await listCodexSessions(codexHome, minMtimeMs);
  return sessions.find((session) => pathEquals(session.cwd, workspace));
}

export async function listCodexSessions(codexHome?: string, minMtimeMs = 0): Promise<CodexSessionMeta[]> {
  const home = codexHome || path.join(os.homedir(), ".codex");
  const sessionsRoot = path.join(home, "sessions");
  const titleIndex = await readSessionTitleIndex(home);
  const files = await listJsonlFiles(sessionsRoot).catch(() => []);
  const candidates: CodexSessionMeta[] = [];
  for (const filePath of files) {
    const stats = await fs.stat(filePath).catch(() => undefined);
    if (!stats || stats.mtimeMs < minMtimeMs) continue;
    const raw = await fs.readFile(filePath, "utf8").catch(() => undefined);
    if (!raw) continue;
    const firstLine = raw.split(/\r?\n/, 1)[0];
    try {
      const event = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string; timestamp?: string } };
      if (event.type === "session_meta" && event.payload?.id && event.payload.cwd) {
        candidates.push({
          id: event.payload.id,
          cwd: event.payload.cwd,
          timestamp: event.payload.timestamp,
          title: titleIndex.get(event.payload.id) || extractSessionTitle(raw),
          filePath,
          mtimeMs: stats.mtimeMs
        });
      }
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

async function readSessionTitleIndex(codexHome: string): Promise<Map<string, string>> {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const raw = await fs.readFile(indexPath, "utf8").catch(() => "");
  const titles = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed) as { id?: string; thread_name?: string };
      if (item.id && item.thread_name?.trim()) {
        titles.set(item.id, item.thread_name.trim());
      }
    } catch {
      continue;
    }
  }
  return titles;
}

export async function listCodexWorkspaceSessions(codexHome?: string): Promise<CodexWorkspaceSessions[]> {
  const sessions = await listCodexSessions(codexHome);
  const groups = new Map<string, CodexSessionMeta[]>();
  for (const session of sessions) {
    const cwd = session.cwd || "(unknown workspace)";
    groups.set(cwd, [...(groups.get(cwd) || []), session]);
  }

  const workspaces = [...groups.entries()].map(([cwd, workspaceSessions]) => {
    workspaceSessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      cwd,
      name: path.basename(cwd) || cwd,
      sessions: workspaceSessions,
      latestMtimeMs: workspaceSessions[0]?.mtimeMs || 0
    };
  });
  workspaces.sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
  return workspaces;
}

export async function findCodexSessionByQuery(query: string, codexHome?: string): Promise<CodexSessionMeta | undefined> {
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  const sessions = await listCodexSessions(codexHome);
  const asIndex = Number(trimmed);
  if (Number.isInteger(asIndex) && asIndex > 0) {
    return sessions[asIndex - 1];
  }
  const normalized = trimmed.toLowerCase();
  return sessions.find(
    (session) =>
      session.id === trimmed ||
      session.id.startsWith(trimmed) ||
      session.title.toLowerCase() === normalized ||
      session.title.toLowerCase().includes(normalized)
  );
}

function extractSessionTitle(raw: string): string {
  const candidates: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const text = extractUserMessageText(event);
      const title = sanitizeTitle(text);
      if (title) candidates.push(title);
    } catch {
      continue;
    }
  }
  return candidates.find((title) => title.length >= 18) || candidates[0] || "Untitled";
}

function extractUserMessageText(event: Record<string, unknown>): string | undefined {
  if (event.type !== "response_item") return undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== "message" || payload.role !== "user") return undefined;
  const content = payload.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const part = item as Record<string, unknown>;
      return typeof part.text === "string" ? part.text : "";
    })
    .join(" ")
    .trim();
}

function sanitizeTitle(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.startsWith("<environment_context>") || normalized.startsWith("<turn_aborted>")) {
    return undefined;
  }
  return normalized.length > 42 ? `${normalized.slice(0, 40)}...` : normalized;
}

function pathEquals(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) return listJsonlFiles(fullPath);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
    })
  );
  return files.flat();
}
