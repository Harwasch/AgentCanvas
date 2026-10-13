// Kind → component dispatch for canvas nodes (and phone sheets).
import type { Kind } from '../canvas/layout';
import type { HubData } from '../store';
import { AppNode } from './AppNode';
import { BranchNode } from './BranchNode';
import { CheckoutNode } from './CheckoutNode';
import type { NodeMode } from './common';
import { FileNode } from './FileNode';
import { HilNode } from './HilNode';
import { MachineNode } from './MachineNode';
import { ProjectNode } from './ProjectNode';
import { ReviewNode } from './ReviewNode';
import { SessionNode } from './SessionNode';
import { AgentRefNode, ClusterNode, DeviceNode, GrantNode, HTodoNode, NoteNode, SuggestNode } from './SmallNodes';
import { TerminalNode } from './TerminalNode';
import { TodosNode } from './TodosNode';

export function NodeView({ kind, id, refId, mode, sessionCount = 0, h }: {
  kind: Kind; id: string; refId: string; mode: NodeMode; sessionCount?: number; h: Pick<HubData, 'checkouts' | 'hosts'>;
}) {
  switch (kind) {
    case 'session': return <SessionNode id={refId} mode={mode} />;
    case 'app': return <AppNode id={refId} />;
    case 'checkout': return h.checkouts[refId] ? <CheckoutNode co={h.checkouts[refId]} host={h.hosts[h.checkouts[refId].host_id]} sessionCount={sessionCount} /> : null;
    case 'project': return <ProjectNode id={refId} mode={mode} />;
    case 'branch': return <BranchNode id={refId} mode={mode} />;
    case 'cluster': return <ClusterNode id={refId} mode={mode} />;
    case 'machine': return <MachineNode id={refId} canvasId={id} mode={mode} />;
    case 'device': return <DeviceNode id={refId} mode={mode} />;
    case 'hil': return <HilNode id={refId} mode={mode} />;
    case 'agentref': return <AgentRefNode id={refId} mode={mode} />;
    case 'grant': return <GrantNode id={refId} mode={mode} />;
    case 'note': return <NoteNode id={refId} mode={mode} />;
    case 'todos': return <TodosNode id={refId} mode={mode} />;
    case 'htodo': return <HTodoNode id={refId} mode={mode} />;
    case 'suggest': return <SuggestNode id={refId} mode={mode} />;
    case 'review': return <ReviewNode id={refId} mode={mode} />;
    case 'file': return <FileNode id={refId} mode={mode} />;
    case 'terminal': return <TerminalNode id={refId} mode={mode} />;
    default: return null;
  }
}

/** Kinds that open as a full-screen sheet on the phone when expanded. */
export const SHEET_KINDS = new Set<Kind>(['project', 'branch', 'machine', 'todos', 'review', 'file', 'terminal']);

/** Resolve an expanded canvas id to a kind + ref for phone sheets (ids are raw ids for these kinds). */
export function sheetTarget(id: string, h: HubData): { kind: Kind; ref: string } | null {
  if (h.projects[id]) return { kind: 'project', ref: id };
  if (h.branches[id]) return { kind: 'branch', ref: id };
  if (h.cnodes[id] && SHEET_KINDS.has(h.cnodes[id].type as Kind)) return { kind: h.cnodes[id].type as Kind, ref: id };
  const mid = id.startsWith('m:') ? id.slice(2) : id;
  if (h.machines[mid]) return { kind: 'machine', ref: mid };
  return null;
}
