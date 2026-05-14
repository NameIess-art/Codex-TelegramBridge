import { Bot, type Context } from "grammy";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findLatestCodexSession,
  isTransientCodexNetworkError,
  listCodexWorkspaceSessions,
  type CodexSessionMeta,
  type CodexStreamEvent
} from "./codex.js";
import { ProcessLock } from "./lock.js";
import type { CodexClient } from "./codex.js";
import type { ConfigStore, StateStore } from "./storage.js";
import type { BridgeSession, BridgeState, BridgeStatus, CodexRunResult } from "./types.js";

const telegramMessageLimit = 4096;
const safeChunkSize = 3900;
const codexNetworkProbeUrl = "https://chatgpt.com/backend-api/codex/responses";
const networkFailureCooldownMs = 60_000;
const networkSuccessCacheMs = 30_000;

export interface TelegramBridgeOptions {
  configStore: ConfigStore;
  stateStore: StateStore;
  codexFactory: (codexCommand: string, defaultWorkspace: string) => CodexClient;
}

interface QueueState {
  tail: Promise<void>;
  pending: number;
}

interface WorkspaceCandidate {
  name: string;
  cwd: string;
}

interface NewSessionTarget {
  workspace: string;
  matchedWorkspace?: string;
}

export class TelegramBridge {
  private bot?: Bot;
  private running = false;
  private queues = new Map<number, QueueState>();
  private readonly lock = new ProcessLock();
  private readonly seenMessages = new Set<string>();
  private botToken?: string;
  private networkUnavailableUntil = 0;
  private networkHealthyUntil = 0;
  private networkProbePromise?: Promise<boolean>;

  constructor(private readonly options: TelegramBridgeOptions) {}

  async start(): Promise<void> {
    const config = await this.options.configStore.read();
    if (!config.botToken) return;
    await this.stop();

    if (!(await this.lock.acquire())) {
      this.running = false;
      console.error("Telegram bridge is already running in another process. This process will not poll Telegram.");
      return;
    }

    const bot = new Bot(config.botToken);
    this.botToken = config.botToken;
    this.registerHandlers(bot);
    bot.catch((error) => {
      console.error("Telegram bridge error:", error.error);
    });
    this.bot = bot;
    this.running = true;
    void bot.start().catch((error) => {
      this.running = false;
      void this.lock.release();
      console.error("Telegram bridge stopped:", error);
    });
  }

  async stop(): Promise<void> {
    if (this.bot && this.running) {
      await this.bot.stop().catch(() => undefined);
    }
    this.bot = undefined;
    this.botToken = undefined;
    this.running = false;
    await this.lock.release();
  }

  async status(): Promise<BridgeStatus> {
    const [config, state] = await Promise.all([this.options.configStore.read(), this.options.stateStore.read()]);
    return {
      tokenConfigured: Boolean(config.botToken),
      running: this.running,
      ownerBound: typeof state.ownerUserId === "number",
      ownerUserId: state.ownerUserId,
      sessionCount: Object.keys(state.sessions).length,
      currentSession: state.currentSessionKey ? state.sessions[state.currentSessionKey] : undefined,
      defaultWorkspace: config.defaultWorkspace,
      codexCommand: config.codexCommand,
      queueDepth: [...this.queues.values()].reduce((total, queue) => total + queue.pending, 0)
    };
  }

  private registerHandlers(bot: Bot): void {
    bot.command("start", (ctx) => this.handleStart(ctx));
    bot.command("help", (ctx) => this.withOwner(ctx, () => ctx.reply(helpText())));
    bot.command("new", (ctx) => this.withOwner(ctx, () => this.enqueueCodex(ctx, () => this.handleNew(ctx))));
    bot.command("list", (ctx) => this.withOwner(ctx, () => this.handleList(ctx)));
    bot.command("switch", (ctx) => this.withOwner(ctx, () => this.handleSwitch(ctx)));
    bot.command("rename", (ctx) => this.withOwner(ctx, () => this.handleRename(ctx)));
    bot.command("current", (ctx) => this.withOwner(ctx, () => this.handleCurrent(ctx)));
    bot.command("status", (ctx) => this.withOwner(ctx, () => this.handleStatus(ctx)));
    bot.command("reset-owner", (ctx) => this.withOwner(ctx, () => this.handleResetOwner(ctx)));
    bot.on("message:photo", (ctx) => this.withOwner(ctx, () => this.enqueueCodex(ctx, () => this.handlePhoto(ctx))));
    bot.on("message:document", (ctx) => this.withOwner(ctx, () => this.enqueueCodex(ctx, () => this.handleDocument(ctx))));
    bot.on("message:text", (ctx) => this.withOwner(ctx, () => this.enqueueCodex(ctx, () => this.handleText(ctx))));
  }

  private async handleStart(ctx: Context): Promise<void> {
    if (!(await this.isPrivateChat(ctx))) return;
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = await this.options.stateStore.read();
    if (typeof state.ownerUserId === "number" && state.ownerUserId !== userId) {
      await ctx.reply("Unauthorized.");
      return;
    }

    if (state.ownerUserId === userId) {
      await this.attachLatestCodexSession();
      await ctx.reply("Codex Telegram Bridge is already bound to you. Send a message or use /help.");
      return;
    }

    await this.options.stateStore.write({ ...state, ownerUserId: userId });
    await this.attachLatestCodexSession();
    await ctx.reply("Codex Telegram Bridge is bound to this Telegram account. Use /help to see commands.");
  }

  private async handleNew(ctx: Context): Promise<void> {
    const argument = parseCommandArgument(ctx.message?.text);
    const target = await this.resolveNewSessionTarget(argument);
    const session = createSession("New conversation", undefined, undefined, target.workspace);
    await this.options.stateStore.update((state) => ({
      ...state,
      currentSessionKey: session.key,
      sessions: { ...state.sessions, [session.key]: session }
    }));

    await withTyping(ctx, async () => {
      const config = await this.options.configStore.read();
      const codex = this.options.codexFactory(config.codexCommand, target.workspace);
      const stream = await TelegramStream.create(ctx);
      const result = await runCodexWithStream(
        stream,
        () =>
          codex.runNewSession(
            `Start a new Codex Telegram Bridge conversation in workspace "${target.workspace}". Reply briefly that the session is ready.`,
            {
              onEvent: (event) => stream.push(event)
            }
          ),
        (error) => this.noteCodexFailure(error)
      );
      if (!result) return;
      await this.options.stateStore.update((state) => {
        const current = state.sessions[session.key] || session;
        const updated = touchSession({ ...current, codexSessionId: result.sessionId || current.codexSessionId });
        return {
          ...state,
          currentSessionKey: session.key,
          sessions: { ...state.sessions, [session.key]: updated }
        };
      });
      await stream.complete(
        result.finalMessage || `New session is ready${target.matchedWorkspace ? ` in ${target.matchedWorkspace}` : ""}.`
      );
    });
  }

  private async resolveNewSessionTarget(argument: string): Promise<NewSessionTarget> {
    const [config, state, workspaces] = await Promise.all([
      this.options.configStore.read(),
      this.options.stateStore.read(),
      listCodexWorkspaceSessions()
    ]);
    const current = getCurrentSession(state);
    const fallbackWorkspace = current?.workspace || config.defaultWorkspace;
    const candidates = uniqueWorkspaceCandidates([
      { cwd: config.defaultWorkspace, name: path.basename(config.defaultWorkspace) || config.defaultWorkspace },
      ...workspaces.map((workspace) => ({ cwd: workspace.cwd, name: workspace.name }))
    ]);

    if (!argument) {
      return { workspace: fallbackWorkspace };
    }

    const exact = findWorkspaceCandidate(candidates, argument);
    if (exact) {
      return { workspace: exact.cwd, matchedWorkspace: exact.name };
    }

    throw new Error(`Workspace not found: ${argument}. Use /list to see existing workspaces.`);
  }

  private async handleList(ctx: Context): Promise<void> {
    const [state, workspaces] = await Promise.all([this.options.stateStore.read(), listCodexWorkspaceSessions()]);
    if (workspaces.length === 0) {
      await ctx.reply("No Codex sessions found.");
      return;
    }
    await replyLong(ctx, renderWorkspaceSessionList(workspaces, state.currentSessionKey ? state.sessions[state.currentSessionKey] : undefined), {
      parse_mode: "HTML"
    });
  }

  private async handleSwitch(ctx: Context): Promise<void> {
    const query = parseCommandArgument(ctx.message?.text);
    if (!query) {
      await ctx.reply("Usage: /switch <id|name>");
      return;
    }
    const state = await this.options.stateStore.read();
    const session = findSession(state, query);
    if (!session) {
      const codexSession = await findListedCodexSession(query);
      if (!codexSession) {
        await ctx.reply("Session not found. Use /list to see available sessions.");
        return;
      }
      const next = await this.setCurrentFromCodexSession(codexSession);
      await ctx.reply(`Switched to "${next.name}".`);
      return;
    }
    await this.options.stateStore.write({ ...state, currentSessionKey: session.key });
    await ctx.reply(`Switched to "${session.name}".`);
  }

  private async handleRename(ctx: Context): Promise<void> {
    const name = parseCommandArgument(ctx.message?.text);
    if (!name) {
      await ctx.reply("Usage: /rename <name>");
      return;
    }
    const state = await this.options.stateStore.read();
    const current = getCurrentSession(state);
    if (!current) {
      await ctx.reply("No current session. Use /new first.");
      return;
    }
    const updated = touchSession({ ...current, name });
    await this.options.stateStore.write({
      ...state,
      sessions: { ...state.sessions, [updated.key]: updated }
    });
    await ctx.reply(`Renamed current session to "${name}".`);
  }

  private async handleCurrent(ctx: Context): Promise<void> {
    const state = await this.attachLatestCodexSession();
    const current = getCurrentSession(state);
    if (!current) {
      await ctx.reply("No current session. Use /new first.");
      return;
    }
    await ctx.reply(`Current: ${current.name}\nKey: ${current.key}\nCodex session: ${current.codexSessionId || "not started"}`);
  }

  private async handleStatus(ctx: Context): Promise<void> {
    const status = await this.status();
    await ctx.reply(
      [
        `Running: ${status.running ? "yes" : "no"}`,
        `Token configured: ${status.tokenConfigured ? "yes" : "no"}`,
        `Owner bound: ${status.ownerBound ? "yes" : "no"}`,
        `Sessions: ${status.sessionCount}`,
        `Current: ${status.currentSession?.name || "none"}`,
        `Workspace: ${status.defaultWorkspace}`,
        `Codex: ${status.codexCommand}`,
        `Queue depth: ${status.queueDepth}`
      ].join("\n")
    );
  }

  private async handleResetOwner(ctx: Context): Promise<void> {
    await this.options.stateStore.update((state) => ({ ...state, ownerUserId: undefined }));
    await ctx.reply("Owner binding cleared. The next /start will bind a new owner.");
  }

  private async handleText(ctx: Context): Promise<void> {
    const prompt = ctx.message?.text?.trim();
    if (!prompt) return;
    if (prompt.startsWith("/")) {
      await ctx.reply("Unknown command. Use /help.");
      return;
    }

    await withTyping(ctx, async () => {
      const config = await this.options.configStore.read();
      const state = await this.ensureCurrentSession();
      const current = getCurrentSession(state);
      if (!current) throw new Error("No current session.");
      const codex = this.options.codexFactory(config.codexCommand, current.workspace || config.defaultWorkspace);

      const stream = await TelegramStream.create(ctx);
      const result = await runCodexWithStream(
        stream,
        () =>
          current.codexSessionId
            ? codex.resumeSession(current.codexSessionId, prompt, { onEvent: (event) => stream.push(event) })
            : codex.runNewSession(prompt, { onEvent: (event) => stream.push(event) }),
        (error) => this.noteCodexFailure(error)
      );
      if (!result) return;

      await this.options.stateStore.update((latest) => {
        const latestCurrent = latest.sessions[current.key] || current;
        const updated = touchSession({ ...latestCurrent, codexSessionId: result.sessionId || latestCurrent.codexSessionId });
        return {
          ...latest,
          currentSessionKey: updated.key,
          sessions: { ...latest.sessions, [updated.key]: updated }
        };
      });

      await stream.complete(result.finalMessage || "(Codex returned no final message.)");
    });
  }

  private async handlePhoto(ctx: Context): Promise<void> {
    const photo = ctx.message?.photo?.at(-1);
    if (!photo) return;
    const prompt = ctx.message?.caption?.trim() || "Please inspect this image and describe the relevant details.";
    await this.handleImage(ctx, photo.file_id, prompt);
  }

  private async handleDocument(ctx: Context): Promise<void> {
    const document = ctx.message?.document;
    if (!document) return;
    if (!document.mime_type?.startsWith("image/")) {
      await ctx.reply("Only image documents are supported. Send the image as a photo or as an image file.");
      return;
    }
    const prompt = ctx.message?.caption?.trim() || "Please inspect this image and describe the relevant details.";
    await this.handleImage(ctx, document.file_id, prompt);
  }

  private async handleImage(ctx: Context, fileId: string, prompt: string): Promise<void> {
    if (!this.botToken) {
      throw new Error("Telegram bridge is missing its Bot token.");
    }
    const imagePath = await downloadTelegramFile(ctx, fileId, this.botToken);

    try {
      await withTyping(ctx, async () => {
        const config = await this.options.configStore.read();
        const state = await this.ensureCurrentSession();
        const current = getCurrentSession(state);
        if (!current) throw new Error("No current session.");
        const codex = this.options.codexFactory(config.codexCommand, current.workspace || config.defaultWorkspace);

        const stream = await TelegramStream.create(ctx);
        const runOptions = {
          imagePaths: [imagePath],
          onEvent: (event: CodexStreamEvent) => stream.push(event)
        };
        const result = await runCodexWithStream(
          stream,
          () =>
            current.codexSessionId
              ? codex.resumeSession(current.codexSessionId, prompt, runOptions)
              : codex.runNewSession(prompt, runOptions),
          (error) => this.noteCodexFailure(error)
        );
        if (!result) return;

        await this.options.stateStore.update((latest) => {
          const latestCurrent = latest.sessions[current.key] || current;
          const updated = touchSession({ ...latestCurrent, codexSessionId: result.sessionId || latestCurrent.codexSessionId });
          return {
            ...latest,
            currentSessionKey: updated.key,
            sessions: { ...latest.sessions, [updated.key]: updated }
          };
        });

        await stream.complete(result.finalMessage || "(Codex returned no final message.)");
      });
    } finally {
      await fs.rm(imagePath, { force: true }).catch(() => undefined);
    }
  }

  private async ensureCurrentSession(): Promise<BridgeState> {
    const state = await this.attachLatestCodexSession();
    if (getCurrentSession(state)) return state;
    const session = createSession("default");
    const next = {
      ...state,
      currentSessionKey: session.key,
      sessions: { ...state.sessions, [session.key]: session }
    };
    await this.options.stateStore.write(next);
    return next;
  }

  private async attachLatestCodexSession(): Promise<BridgeState> {
    const state = await this.options.stateStore.read();
    const existingCurrent = getCurrentSession(state);
    if (existingCurrent) return state;

    const config = await this.options.configStore.read();
    const latest = await findLatestCodexSession(undefined, config.defaultWorkspace);
    if (!latest) return state;

    const existing = Object.values(state.sessions).find((session) => session.codexSessionId === latest.id);
    if (existing) {
      const next = { ...state, currentSessionKey: existing.key };
      await this.options.stateStore.write(next);
      return next;
    }

    const session = createSession(latest.title, latest.id, latest.timestamp, latest.cwd);
    const next = {
      ...state,
      currentSessionKey: session.key,
      sessions: { ...state.sessions, [session.key]: session }
    };
    await this.options.stateStore.write(next);
    return next;
  }

  private async setCurrentFromCodexSession(codexSession: CodexSessionMeta): Promise<BridgeSession> {
    const state = await this.options.stateStore.read();
    const existing = Object.values(state.sessions).find((session) => session.codexSessionId === codexSession.id);
    if (existing) {
      const updated = touchSession({ ...existing, name: codexSession.title, workspace: codexSession.cwd });
      await this.options.stateStore.write({
        ...state,
        currentSessionKey: updated.key,
        sessions: { ...state.sessions, [updated.key]: updated }
      });
      return updated;
    }
    const session = createSession(codexSession.title, codexSession.id, codexSession.timestamp, codexSession.cwd);
    await this.options.stateStore.write({
      ...state,
      currentSessionKey: session.key,
      sessions: { ...state.sessions, [session.key]: session }
    });
    return session;
  }

  private async withOwner(ctx: Context, handler: () => Promise<unknown>): Promise<void> {
    if (!(await this.isPrivateChat(ctx))) return;
    if (!this.markMessageSeen(ctx)) return;
    const userId = ctx.from?.id;
    if (!userId) return;
    const state = await this.options.stateStore.read();
    if (typeof state.ownerUserId !== "number") {
      await ctx.reply("Use /start to bind this Bot first.");
      return;
    }
    if (state.ownerUserId !== userId) {
      await ctx.reply("Unauthorized.");
      return;
    }
    await handler();
  }

  private markMessageSeen(ctx: Context): boolean {
    if (!ctx.message) return true;
    const key = `${ctx.chat?.id || "unknown"}:${ctx.message.message_id}`;
    if (this.seenMessages.has(key)) return false;
    this.seenMessages.add(key);
    if (this.seenMessages.size > 1000) {
      const [first] = this.seenMessages;
      if (first) this.seenMessages.delete(first);
    }
    return true;
  }

  private async isPrivateChat(ctx: Context): Promise<boolean> {
    if (ctx.chat?.type === "private") return true;
    await ctx.reply("This bridge only accepts private chats.");
    return false;
  }

  private enqueue(ctx: Context, task: () => Promise<void>): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return Promise.resolve();
    const queue = this.queues.get(chatId) || { tail: Promise.resolve(), pending: 0 };
    if (queue.pending > 0) {
      void ctx.reply(`Queued. ${queue.pending} request(s) ahead of this one.`);
    }
    queue.pending += 1;
    const run = queue.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await task();
        } catch (error) {
          const message = formatCodexRequestError(error);
          await ctx.reply(`Codex request failed:\n${message.slice(0, 3500)}`);
        } finally {
          queue.pending -= 1;
          if (queue.pending === 0) this.queues.delete(chatId);
        }
      });
    queue.tail = run;
    this.queues.set(chatId, queue);
    return run;
  }

  private async enqueueCodex(ctx: Context, task: () => Promise<void>): Promise<void> {
    if (!(await this.ensureCodexNetworkAvailable(ctx))) return;
    return this.enqueue(ctx, task);
  }

  private async ensureCodexNetworkAvailable(ctx: Context): Promise<boolean> {
    const now = Date.now();
    if (now < this.networkUnavailableUntil) {
      await replyNetworkUnavailable(ctx, this.networkUnavailableUntil - now);
      return false;
    }
    if (now < this.networkHealthyUntil) {
      return true;
    }

    const available = await this.probeCodexNetwork();
    if (available) {
      this.networkHealthyUntil = Date.now() + networkSuccessCacheMs;
      return true;
    }

    this.markNetworkUnavailable();
    await replyNetworkUnavailable(ctx, networkFailureCooldownMs);
    return false;
  }

  private async probeCodexNetwork(): Promise<boolean> {
    if (!this.networkProbePromise) {
      this.networkProbePromise = probeCodexNetwork().finally(() => {
        this.networkProbePromise = undefined;
      });
    }
    return this.networkProbePromise;
  }

  private noteCodexFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (isTransientCodexNetworkError(message)) {
      this.markNetworkUnavailable();
    }
  }

  private markNetworkUnavailable(): void {
    this.networkUnavailableUntil = Date.now() + networkFailureCooldownMs;
    this.networkHealthyUntil = 0;
  }
}

export function splitTelegramMessage(text: string, limit = safeChunkSize): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function parseCommandArgument(text: string | undefined): string {
  if (!text) return "";
  const firstSpace = text.indexOf(" ");
  return firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
}

function createSession(name: string, codexSessionId?: string, createdAt?: string, workspace?: string): BridgeSession {
  const now = createdAt || new Date().toISOString();
  return {
    key: crypto.randomUUID(),
    name,
    codexSessionId,
    workspace,
    createdAt: now,
    updatedAt: new Date().toISOString()
  };
}

function touchSession(session: BridgeSession): BridgeSession {
  return { ...session, updatedAt: new Date().toISOString() };
}

function getCurrentSession(state: BridgeState): BridgeSession | undefined {
  return state.currentSessionKey ? state.sessions[state.currentSessionKey] : undefined;
}

function findSession(state: BridgeState, query: string): BridgeSession | undefined {
  const normalized = query.toLowerCase();
  return Object.values(state.sessions).find(
    (session) => session.key === query || session.key.startsWith(query) || session.name.toLowerCase() === normalized
  );
}

async function replyLong(ctx: Context, text: string, options?: Parameters<Context["reply"]>[1]): Promise<void> {
  for (const chunk of splitTelegramMessage(text, telegramMessageLimit - 128)) {
    await ctx.reply(chunk, options);
  }
}

async function withTyping(ctx: Context, task: () => Promise<void>): Promise<void> {
  const chatId = ctx.chat?.id;
  let timer: NodeJS.Timeout | undefined;
  if (chatId) {
    await ctx.api.sendChatAction(chatId, "typing").catch(() => undefined);
    timer = setInterval(() => {
      void ctx.api.sendChatAction(chatId, "typing").catch(() => undefined);
    }, 4000);
  }
  try {
    await task();
  } finally {
    if (timer) clearInterval(timer);
  }
}

async function downloadTelegramFile(ctx: Context, fileId: string, botToken: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path for this file.");
  }
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram image: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".jpg";
  const directory = path.join(os.tmpdir(), "codex-telegram-bridge", "images");
  await fs.mkdir(directory, { recursive: true });
  const imagePath = path.join(directory, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  await fs.writeFile(imagePath, buffer);
  return imagePath;
}

function helpText(): string {
  return [
    "Codex Telegram Bridge commands:",
    "/new [workspace] - create and switch to a new Codex conversation",
    "/list - list conversations",
    "/switch <id|name> - switch conversation",
    "/rename <name> - rename current conversation",
    "/current - show current conversation",
    "/status - show bridge status",
    "/reset-owner - clear owner binding",
    "/help - show this help"
  ].join("\n");
}

type WorkspaceList = Awaited<ReturnType<typeof listCodexWorkspaceSessions>>;

function renderWorkspaceSessionList(workspaces: WorkspaceList, currentSession: BridgeSession | undefined): string {
  let index = 1;
  const lines = ["<b>Codex conversations</b>"];
  for (const workspace of workspaces) {
    lines.push("", `<b>&#9656; ${escapeHtml(workspace.name)}</b>`);
    for (const session of workspace.sessions) {
      const current = currentSession?.codexSessionId === session.id ? "&#9679;" : "&#9675;";
      const title = truncateForList(session.title, 24);
      const age = formatRelativeTime(session.mtimeMs);
      lines.push(`${current} ${index} ${escapeHtml(title)}  <i>${escapeHtml(age)}</i>`);
      index += 1;
    }
  }
  lines.push("", "<i>Use /switch &lt;number|id|title&gt; to switch.</i>");
  return lines.join("\n");
}

async function findListedCodexSession(query: string): Promise<CodexSessionMeta | undefined> {
  const trimmed = query.trim();
  const workspaces = await listCodexWorkspaceSessions();
  const flattened = workspaces.flatMap((workspace) => workspace.sessions);
  const asIndex = Number(trimmed);
  if (Number.isInteger(asIndex) && asIndex > 0) return flattened[asIndex - 1];

  const normalized = trimmed.toLowerCase();
  return flattened.find(
    (session) =>
      session.id === trimmed ||
      session.id.startsWith(trimmed) ||
      session.title.toLowerCase() === normalized ||
      session.title.toLowerCase().includes(normalized)
  );
}

function formatRelativeTime(mtimeMs: number): string {
  const diffMs = Math.max(0, Date.now() - mtimeMs);
  const minutes = Math.max(1, Math.round(diffMs / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} d`;
}

function truncateForList(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}...` : normalized;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function uniqueWorkspaceCandidates(candidates: WorkspaceCandidate[]): WorkspaceCandidate[] {
  const seen = new Set<string>();
  const result: WorkspaceCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.cwd.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function findWorkspaceCandidate(candidates: WorkspaceCandidate[], query: string): WorkspaceCandidate | undefined {
  const normalized = normalizeWorkspaceToken(query);
  return candidates.find((candidate) => workspaceAliases(candidate).some((alias) => alias === normalized));
}

function workspaceAliases(candidate: WorkspaceCandidate): string[] {
  return [candidate.name, path.basename(candidate.cwd), candidate.cwd].map(normalizeWorkspaceToken).filter(Boolean);
}

function normalizeWorkspaceToken(value: string): string {
  return value.trim().replace(/^["'`]+|["'`]+$/g, "").toLowerCase();
}

class TelegramStream {
  private reasoning = "";
  private processed = "";
  private answer = "";
  private status = "";
  private lastText = "";
  private lastFlushAt = 0;
  private messageId?: number;

  private constructor(
    private readonly ctx: Context,
    private readonly chatId: number
  ) {}

  static async create(ctx: Context): Promise<TelegramStream> {
    if (!ctx.chat?.id) throw new Error("Cannot stream without a chat id.");
    const stream = new TelegramStream(ctx, ctx.chat.id);
    const message = await ctx.reply("<b>Codex</b> <i>Thinking...</i>", { parse_mode: "HTML" });
    stream.messageId = message.message_id;
    stream.lastText = "<b>Codex</b> <i>Thinking...</i>";
    stream.lastFlushAt = Date.now();
    return stream;
  }

  async push(event: CodexStreamEvent): Promise<void> {
    if (event.kind === "reasoning") {
      this.reasoning = appendDistinct(this.reasoning, event.text);
    } else if (event.kind === "processed") {
      this.processed = appendDistinct(this.processed, event.text);
    } else if (event.kind === "message") {
      this.answer = appendDistinct(this.answer, event.text);
    } else {
      this.status = event.text;
    }
    await this.flush(false);
  }

  async complete(finalMessage: string): Promise<void> {
    this.status = "Done";
    this.answer = finalMessage || this.answer;
    await this.flush(true);
  }

  async fail(error: unknown): Promise<void> {
    this.status = "Failed";
    this.answer = formatCodexRequestError(error);
    await this.flush(true);
  }

  private async flush(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastFlushAt < 1200) return;
    const text = renderStreamMessage({
      status: this.status,
      reasoning: this.reasoning,
      processed: this.processed,
      answer: this.answer
    });
    if (text === this.lastText) return;
    this.lastText = text;
    this.lastFlushAt = now;
    if (!this.messageId) {
      const message = await this.ctx.reply(text, { parse_mode: "HTML" });
      this.messageId = message.message_id;
      return;
    }
    await this.ctx.api.editMessageText(this.chatId, this.messageId, text, { parse_mode: "HTML" }).catch(async () => {
      if (force) {
        await replyLong(this.ctx, text, { parse_mode: "HTML" });
      }
    });
  }
}

function renderStreamMessage(parts: { status: string; reasoning: string; processed: string; answer: string }): string {
  const lines = [`<b>Codex</b>${parts.status ? ` <i>${escapeHtml(parts.status)}</i>` : ""}`];
  const reasoning = truncateForStream(parts.reasoning, 700);
  const processed = truncateForStream(parts.processed, 1400);
  const answer = truncateForStream(parts.answer, 2500);
  if (reasoning) {
    lines.push("", "<b>Thinking</b>", renderFormattedText(reasoning));
  }
  if (processed) {
    lines.push("", "<b>Processed</b>", renderFormattedText(processed));
  }
  if (answer) {
    lines.push("", "<b>Answer</b>", renderFormattedText(answer));
  }
  return lines.length > 1 ? lines.join("\n") : "<b>Codex</b> <i>Thinking...</i>";
}

function renderFormattedText(text: string): string {
  const escaped = escapeHtml(text.trim());
  return escaped
    .replace(/```([\s\S]*?)```/g, (_match, code: string) => `<pre>${code.trim()}</pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}

function appendDistinct(existing: string, next: string): string {
  const normalized = next.trim();
  if (!normalized) return existing;
  if (!existing) return normalized;
  if (existing.includes(normalized)) return existing;
  return `${existing}\n${normalized}`;
}

function truncateForStream(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 20)}\n...`;
}

async function runCodexWithStream(
  stream: TelegramStream,
  run: () => Promise<CodexRunResult>,
  onFailure?: (error: unknown) => void
): Promise<CodexRunResult | undefined> {
  try {
    return await run();
  } catch (error) {
    onFailure?.(error);
    await stream.fail(error);
    return undefined;
  }
}

function formatCodexRequestError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (isTransientCodexNetworkError(raw)) {
    return [
      "Codex CLI could not connect to ChatGPT/Codex websocket.",
      "This is a network/proxy/TLS issue, not an image parsing failure.",
      "The bridge retried automatically. Please retry after the network path is stable.",
      "",
      firstRelevantErrorLine(raw)
    ]
      .filter(Boolean)
      .join("\n");
  }
  return raw;
}

function firstRelevantErrorLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /ERROR|tls handshake|websocket|HTTP request failed|unexpected EOF/i.test(line)) || ""
  );
}

async function replyNetworkUnavailable(ctx: Context, remainingMs: number): Promise<void> {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  await ctx.reply(
    [
      "检测到网络异常：这条消息没有发送给 Codex，也没有加入队列。",
      `请检查代理/网络，约 ${seconds}s 后重试。`
    ].join("\n")
  );
}

export async function probeCodexNetwork(
  fetchImpl: typeof fetch = fetch,
  url = codexNetworkProbeUrl,
  timeoutMs = 3000
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(url, {
      method: "HEAD",
      signal: controller.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
