import { promises as fs } from "node:fs";
import path from "node:path";
import { getBridgeHome } from "./storage.js";

interface LockFile {
  pid: number;
  startedAt: string;
}

export class ProcessLock {
  private acquired = false;

  constructor(private readonly filePath = path.join(getBridgeHome(), "telegram-bridge.lock")) {}

  async acquire(): Promise<boolean> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });

    if (await this.isHeldByLiveProcess()) {
      return false;
    }

    await fs.rm(this.filePath, { force: true }).catch(() => undefined);
    try {
      const handle = await fs.open(this.filePath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      this.acquired = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    const lock = await this.readLock();
    if (lock?.pid === process.pid) {
      await fs.rm(this.filePath, { force: true }).catch(() => undefined);
    }
    this.acquired = false;
  }

  private async isHeldByLiveProcess(): Promise<boolean> {
    const lock = await this.readLock();
    if (!lock) return false;
    return isProcessLive(lock.pid);
  }

  private async readLock(): Promise<LockFile | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf8")) as LockFile;
    } catch {
      return undefined;
    }
  }
}

function isProcessLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
