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
}

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
    channel?: 'connected' | 'disconnected';
    tmux?: string;
    cloudStatus?: string;
    diffSummary?: string;
    environment?: string;
    attempts?: number;
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
  source: 'codex' | 'claude-channel' | 'claude-hook' | 'app-confirm';
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

export interface LayoutEntry { x: number; y: number; w?: number; h?: number; collapsed?: boolean }

export interface StateSnapshot {
  seq: number;
  hosts: Host[];
  accounts: Account[];
  checkouts: Checkout[];
  sessions: Session[];
  approvals: Approval[];
  nodes: AppNode[];
  layout: Record<string, LayoutEntry>;
  config: { publicUrl?: string; vapidPublicKey?: string };
}

export interface HubEvent { seq: number; type: string; data: any; ts?: number | string }

export interface Review {
  version: number | string;
  candidateCommit: string;
  dirtyFiles: string[];
  tools: Record<string, ToolDecl>;
  lifecycle?: string;
  serverFiles: { path: string; content: string }[];
  reviewHash: string;
}

export interface CallToolResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}
