// Shapes from docs/API.md (hub ↔ PWA contract).

export type HostStatus = 'online' | 'offline' | 'unknown';
export interface Host {
  id: string;
  label: string;
  target: string;
  color: string;
  status: HostStatus;
  last_seen: string | number | null;
  info: { latencyMs?: number; uname?: string; error?: string };
}

export interface CloudEnv { id: string; label: string }
export interface Account {
  id: string;
  label: string;
  color: string;
  cloud: { claudeEnvironments: CloudEnv[]; codexEnvironments: CloudEnv[] };
  /** GitHub users / orgs this account owns (its gh login) */
  github?: string[];
}

/** One subscription rate-limit window (5 h, week…) as the vendor reports it. */
export interface UsageWindow { label: string; usedPct: number; resetsAt: number | null; minutes?: number | null }
/** Usage of one AI subscription: Claude or Codex for one account. */
export interface Usage { accountId: string; vendor: 'claude' | 'codex'; windows: UsageWindow[]; plan?: string | null; at: number; error?: string }

export interface CheckoutApp { dir: string; id: string; title: string; published: boolean; nodeId?: string }
export interface Checkout {
  id: string;
  host_id: string;
  path: string;
  repo_id: string;
  repoName: string;
  remote_url: string;
  branch: string;
  head: string;
  head_subject: string;
  head_time: string | number | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  changes: { path: string; xy: string }[];
  apps: CheckoutApp[];
  updated_at: string | number;
}

export type Vendor = 'claude' | 'codex';
export type SessionStatus = 'starting' | 'running' | 'idle' | 'waiting' | 'ended' | 'error' | 'pending' | 'ready' | 'applied';
export interface Session {
  id: string;
  vendor: Vendor;
  kind: 'local' | 'cloud';
  host_id: string | null;
  account_id: string;
  checkout_id: string | null;
  cwd: string;
  branch: string;
  native_id: string | null;
  native_url: string | null;
  title: string;
  status: SessionStatus;
  last_event: string | null;
  model: string | null;
  effort: string | null;
  created_at: string | number;
  updated_at: string | number;
  meta: {
    role?: 'assistant';
    /** removed from the canvas with Delete (the session itself is untouched); Sessions tab: "Show on canvas" */
    hidden?: boolean;
    channel?: 'connected' | 'disconnected';
    tmux?: string;
    cloudStatus?: string;
    diffSummary?: string;
    environment?: string;
    attempts?: number;
    /** started outside the hub (Claude app, terminal): shown read-only until taken over */
    external?: boolean;
    /** where it was started: claude-desktop, cli, … */
    source?: string;
    [k: string]: unknown;
  };
}

export interface Message {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  kind: 'text' | 'tool' | 'command' | 'reasoning' | 'status';
  text: string;
  data: any;
  created_at: string | number;
}

export interface Approval {
  id: string;
  session_id: string;
  source: 'codex' | 'claude-channel' | 'claude-hook' | 'app-confirm' | 'canvas-action';
  title: string;
  detail: string;
  data: any;
  status: 'pending' | 'allow' | 'deny' | 'expired';
  created_at: string | number;
}

export interface ToolDecl { tier: 'read' | 'actuate'; confirm?: boolean; maxPerMinute?: number }
export interface AppNode {
  id: string;
  type: 'app';
  appId: string;
  sessionId: string | null;
  hostId: string;
  dir: string;
  title: string;
  state: 'preview' | 'promoted';
  version: number | string;
  pinnedCommit: string | null;
  grantedVersion: number | string | null;
  status: 'starting' | 'running' | 'stopped' | 'error';
  errors: string[];
  url: string;
  thumbnail: string | null;
  updatedAt: string | number;
  previewOf: string | null;
  manifest: {
    id: string;
    title: string;
    version: string;
    lifecycle?: string;
    ui?: string;
    tools: Record<string, ToolDecl>;
    node: { width: number; height: number };
  };
}

export interface Audit {
  id: string;
  ts: string | number;
  app_node_id: string;
  tool: string;
  tier: string;
  caller: string;
  args: any;
  allowed: boolean | number;
  reason: string | null;
  result: any;
}

/** size: user-resized [w, h] per state (c = collapsed, x = expanded); null clears it. */
export interface LayoutEntry { x: number; y: number; w?: number; h?: number; collapsed?: boolean; size?: { c?: [number, number] | null; x?: [number, number] | null } }

export interface StateSnapshot {
  usage?: Usage[];
  seq: number;
  /** changes on every hub start (the event seq restarts) */
  boot?: string;
  hosts: Host[];
  accounts: Account[];
  checkouts: Checkout[];
  sessions: Session[];
  approvals: Approval[];
  nodes: AppNode[];
  layout: Record<string, LayoutEntry>;
  config: { publicUrl?: string; vapidPublicKey?: string };
  // v2
  projects?: Project[];
  branches?: Branch[];
  machines?: Machine[];
  devices?: Device[];
  cnodes?: CNode[];
  todos?: Todo[];
  grants?: Grant[];
  hil?: { plans: HilPlan[]; runs: HilRun[] };
}

// ---------------- v2 ----------------
export type Ts = string | number;

export interface Project {
  id: string;
  name: string;
  remoteUrl: string;
  gh: { owner: string; repo: string; account: string; url: string } | null;
  defaultBranch: string;
  readme: string;
  stats: { files: number; commits: number; sizeMB: number; branches: number; sessions: number };
  folders: { name: string; mb: number }[];
  checkouts: string[];
  /** last GitHub poll failed: branches, PRs and CI shown are from githubAt */
  githubError?: string | null;
  githubAt?: number | null;
  updatedAt: Ts;
}

export interface PullRequest {
  number: number;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  url: string;
  reviews: { approved: number; changesRequested: number; commented: number };
}
export interface CiStatus { state: 'success' | 'failure' | 'pending' | 'none'; total: number; passed: number; failed: number; url: string | null }
export interface Branch {
  id: string;
  projectId: string;
  name: string;
  base: string | null;
  goal: string | null;
  createdBy: 'hub' | 'agent' | 'other';
  checkouts: string[];
  head: string | null;
  pushed: boolean;
  remoteSha: string | null;
  aheadRemote: number;
  behindRemote: number;
  aheadBase: number;
  behindBase: number;
  pr: PullRequest | null;
  ci: CiStatus | null;
  commits: { sha: string; subject: string; author: string; at: Ts }[];
  apps: { path: string; id: string; title: string }[];
  cloud: { sessionId?: string } | null;
  updatedAt: Ts;
}

export interface Machine {
  id: string;
  label: string;
  kind: 'host' | 'cloud';
  color: string;
  status: 'online' | 'offline' | 'managed';
  cpu: { pct: number; cores: number } | null;
  mem: { usedMB: number; totalMB: number } | null;
  gpu: { name: string; utilPct: number; memUsedMB: number; memTotalMB: number }[];
  load: number | null;
  updatedAt: Ts;
}

export type DeviceIcon = 'SWD' | 'CAN' | 'USB' | 'SER' | 'LAN' | 'DUT' | 'BUS' | 'SSH';
export interface Device {
  id: string;
  hostId: string;
  parentId: string | null;
  title: string;
  kind: string;
  icon: DeviceIcon;
  port: string;
  fw: string;
  status: 'connected' | 'missing' | 'reachable' | 'busy' | 'unknown';
  source: 'declared' | 'discovered';
  lock: { sessionId: string; since: Ts } | null;
  updatedAt: Ts;
}

export interface Grant {
  id: string;
  sessionId: string;
  hostId: string;
  resources: string;
  purpose: string;
  quotaGB: number | null;
  usedGB: number | null;
  status: 'requested' | 'active' | 'revoked';
  createdAt: Ts;
}

export interface HilPlan { id: string; title: string; hostId: string; devices: string[]; plan: string | null; setup: string[] }
export interface HilRow { id: string; req: string; name: string; status: 'pending' | 'run' | 'pass' | 'fail' | 'skip'; durMs: number | null }
export interface HilRun {
  id: string;
  planId: string;
  status: 'running' | 'passed' | 'failed' | 'aborted';
  pass: number;
  fail: number;
  left: number;
  rows: HilRow[];
  log: string[];
  startedBy: string;
  startedAt: Ts;
  finishedAt: Ts | null;
}

export interface Todo {
  id: string;
  scope: string | null;
  text: string;
  src: string;
  done: boolean;
  dispatchedSessionId: string | null;
  createdAt: Ts;
}

export type FileSource = { kind: 'checkout'; checkoutId: string } | { kind: 'github'; projectId: string; ref: string };
export type FileKind = 'doc' | 'image' | 'code' | 'model3d' | 'pdf' | 'text' | 'binary';

export interface NoteData { title?: string; text?: string }
export interface TodosData { title?: string; scope?: string | null }
export interface HTodoData { todoId: string }
export interface SuggestData {
  title: string; prompt: string; rationale: string; vendor: Vendor; hostId: string | null; accountId: string;
  branchId: string | null; status: 'open' | 'launched' | 'dismissed'; sessionId?: string;
}
export interface ReviewComment { id: string; author: 'you' | 'agent'; text: string; at: Ts }
export interface ReviewData {
  sessionId: string; title: string; path: string; source: FileSource; sha: string; kind: string; note: string; promoteTo: string | null;
  checklist: { text: string; done: boolean }[]; comments: ReviewComment[]; status: 'pending' | 'approved' | 'changes';
}
export interface FileData {
  source: FileSource; path: string; sha: string; blob?: string; kind: FileKind; newer: { sha: string; subject: string; at: Ts } | null;
}
export interface TerminalData { hostId: string; cwd: string; mode: 'shell' | 'agent'; sessionId: string | null; status: 'open' | 'closed' }

export type CNodeType = 'note' | 'todos' | 'htodo' | 'suggest' | 'review' | 'file' | 'terminal';
export interface CNode<D = any> {
  id: string;
  type: CNodeType;
  parentId: string | null;
  data: D;
  createdBy: string;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface HubEvent { seq: number; type: string; data: any; ts?: number | string }

export interface Review {
  version: number | string;
  candidateCommit: string;
  dirtyFiles: string[];
  tools: Record<string, ToolDecl>;
  lifecycle?: string;
  /** every change Commit & pin would commit, recursively (status A/M/D + path relative to the app dir) */
  changes?: { status: string; path: string }[];
  /** every file of the reviewed app tree */
  files?: string[];
  serverFiles: { path: string; content: string; size?: number; truncated?: boolean; changed?: boolean }[];
  reviewHash: string;
}

export interface CallToolResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

/** canvas.changed: a batch of edits Claude made through the canvas tools (undoable) */
export interface CanvasChange { batchId: string; by: string; sessionId: string | null; summary: string[]; ids: string[]; moved?: boolean; at: number; undone?: boolean }
