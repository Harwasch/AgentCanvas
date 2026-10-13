// Hub event stream: every state change is published here and fanned out to
// PWA clients over a WebSocket. Canvas contract: node.upsert / node.remove.
import { EventEmitter } from 'node:events';

export interface HubEvent {
  seq: number;
  type: string;
  data: any;
  ts: number;
}

export class EventBus extends EventEmitter {
  private seq = 0;
  private ring: HubEvent[] = [];
  publish(type: string, data: any) {
    const ev: HubEvent = { seq: ++this.seq, type, data, ts: Date.now() };
    this.ring.push(ev);
    if (this.ring.length > 2000) this.ring.splice(0, 500);
    this.emit('event', ev);
    return ev;
  }
  since(seq: number) {
    return this.ring.filter((e) => e.seq > seq);
  }
}

export const log = (scope: string) => {
  const on = !process.env.HUB_QUIET;
  return (...a: any[]) => {
    if (on) console.log(new Date().toISOString().slice(11, 23), `[${scope}]`, ...a);
  };
};
