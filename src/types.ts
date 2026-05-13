export interface BridgeConfig {
  botToken?: string;
  defaultWorkspace: string;
  codexCommand: string;
}

export interface BridgeSession {
  key: string;
  name: string;
  codexSessionId?: string;
  workspace?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeState {
  ownerUserId?: number;
  currentSessionKey?: string;
  sessions: Record<string, BridgeSession>;
}

export interface BridgeStatus {
  tokenConfigured: boolean;
  running: boolean;
  ownerBound: boolean;
  ownerUserId?: number;
  sessionCount: number;
  currentSession?: BridgeSession;
  defaultWorkspace: string;
  codexCommand: string;
  queueDepth: number;
}

export interface CodexRunResult {
  sessionId?: string;
  finalMessage: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}
