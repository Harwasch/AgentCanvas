// Late-bound service registry shared by drivers (avoids constructor cycles).
import type { HubConfig, Secrets, AccountConfig } from './config.js';
import type { Db } from './db.js';
import type { EventBus } from './events.js';
import type { Store } from './store.js';
import type { HostManager } from './ssh.js';
import type { Bootstrapper } from './bootstrap.js';
import type { ClaudeDriver } from './claude/driver.js';
import type { CodexDriver } from './codex/driver.js';
import type { CloudService } from './cloud.js';
import type { RepoIndexer } from './repos.js';
import type { AppService } from './apps/service.js';
import type { Push } from './push.js';
import type { ProjectService } from './projects.js';
import type { FileService } from './files.js';
import type { NodeService } from './nodes.js';
import type { ComputeService } from './compute.js';
import type { HilService } from './hil.js';
import type { TerminalService } from './terminal.js';
import type { CanvasService } from './canvas.js';

export interface Ctx {
  cfg: HubConfig;
  secrets: Secrets;
  db: Db;
  bus: EventBus;
  store: Store;
  hosts: HostManager;
  boot: Bootstrapper;
  claude: ClaudeDriver;
  codex: CodexDriver;
  cloud: CloudService;
  repos: RepoIndexer;
  apps: AppService;
  push: Push;
  projects: ProjectService;
  files: FileService;
  nodes: NodeService;
  compute: ComputeService;
  hil: HilService;
  terminals: TerminalService;
  canvas: CanvasService;
  account(id: string): AccountConfig;
}
