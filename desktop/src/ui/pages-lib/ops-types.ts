// Shapes of the runner's answers that runner/src/protocol.ts doesn't hold
// (they live in runner modules that pull in Node). Kept to what these pages
// read; docs/protocol.md has the full ones.

export type RunnerInfo = {
  id: string;
  name: string;
  icon?: string;
  online: boolean;
  lastSeenAt?: string;
  self: boolean;
  version?: string;
  release?: string;
  startedAt?: string;
  draining?: boolean;
};

export type MachineStats = {
  runnerId: string;
  at: string;
  cpuPercent: number;
  cores: number;
  memUsed: number;
  memTotal: number;
  diskFree: number;
  diskTotal: number;
  load1?: number;
  uptimeSec: number;
  machine?: string;
  os?: string;
};

export type RunnerUpdateState = 'off' | 'idle' | 'checking' | 'building' | 'waiting' | 'failed';

export type RunnerStatus = {
  version: string;
  release?: string;
  branch?: string;
  pid: number;
  startedAt: string;
  home: string;
  logFile: string;
  liveClis: number;
  running: string[];
  background: { threadId: string; tasks: string[] }[];
  pendingRestart?: { when: string; reason?: string; release?: string; resumeThreadId?: string; requestedAt: string; backgroundUntil?: string; waitingFor: string[] };
  rolledBack?: { from: string; at: string };
  draining?: { pid: number; version: string; release?: string; since: string; threads: string[] }[];
  update?: { state: RunnerUpdateState; reason?: string; checkedAt?: string; commit?: string };
  sync?: { state: string; url?: string; reason?: string };
};

export type RemoteRunner = { id: string; name: string; icon?: string; online: boolean; lastSeenAt: string; rpcUrl?: string; tokenFile?: string };
export type RemoteThread = {
  runnerId: string;
  threadId: string;
  title: string;
  cwd: string;
  accountId: string;
  provider: string;
  model?: string;
  status: string;
  needsYou: boolean;
  unread: boolean;
  preview: string;
  createdAt: string;
  lastActivityAt: string;
  snoozedUntil?: string;
  archivedAt?: string;
};
export type RemoteThreads = { runners: RemoteRunner[]; threads: RemoteThread[] };

export type UsageStats = {
  generatedAt: string;
  ready: boolean;
  // [startMs, input, output, cacheRead, cacheWrite]
  tokens: { accountId: string; hours: [number, number, number, number, number][] }[];
  limits: { accountId: string; kind: 'five_hour' | 'weekly'; samples: [number, number][] }[];
};

export type Settings = {
  defaultCwd: string;
  idleMinutes: number;
  maxLiveCLIs: number;
  followMain: boolean;
  bulletReplies: boolean;
  oneReply: boolean;
  models: { pool: string | null; privateFolders: string[] };
};

export type Device = { id: string; kind: 'phone' | 'browser'; name: string; createdAt: string; expiresAt: string; expired: boolean };
