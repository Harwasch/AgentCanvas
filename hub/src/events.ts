// Hub event stream: every state change is published here and fanned out to
// PWA clients over a WebSocket. Canvas contract: node.upsert / node.remove.
import { EventEmitter } from 'node:events';

export interface HubEvent {
  seq: number;
  type: string;
  data: any;
  ts: number;
}

interface Kept {
  ev: HubEvent;
  /** serialized once on publish; every client and every replay sends these bytes */
  json: string;
}

/**
 * Replay ring bounded by count and by bytes: a reconnecting client gets what it missed, or a resync (hello) when its
 * `since` is older than the oldest event still kept. Listeners get `(ev, json)`.
 */
export class EventBus extends EventEmitter {
  seq = 0;
  private ring: Kept[] = [];
  ringBytes = 0;
  constructor(private limits: { maxEvents?: number; maxBytes?: number } = {}) {
    super();
  }
  publish(type: string, data: any) {
    const ev: HubEvent = { seq: ++this.seq, type, data, ts: Date.now() };
    const json = JSON.stringify(ev);
    this.ring.push({ ev, json });
    this.ringBytes += json.length;
    const maxEvents = this.limits.maxEvents ?? 2000;
    const maxBytes = this.limits.maxBytes ?? 8 * 1024 * 1024;
    if (this.ring.length > maxEvents || this.ringBytes > maxBytes) {
      // drop from the front in one splice: a quarter of the count bound, or as much as needed to get back under the byte bound
      let n = this.ring.length > maxEvents ? Math.max(1, Math.floor(maxEvents / 4)) : 0;
      let bytes = 0;
      for (let i = 0; i < n; i++) bytes += this.ring[i].json.length;
      while (n < this.ring.length - 1 && this.ringBytes - bytes > maxBytes) bytes += this.ring[n++].json.length;
      this.ring.splice(0, n);
      this.ringBytes -= bytes;
    }
    this.emit('event', ev, json);
    return ev;
  }
  since(seq: number): HubEvent[] {
    return this.sinceJson(seq).map((k) => k.ev);
  }
  sinceJson(seq: number): Kept[] {
    let i = this.ring.length;
    while (i > 0 && this.ring[i - 1].ev.seq > seq) i--;
    return this.ring.slice(i);
  }
  /** seq of the oldest event still in the ring (seq + 1 when empty) */
  oldest() {
    return this.ring.length ? this.ring[0].ev.seq : this.seq + 1;
  }
  /**
   * The event socket's first frame. A client must reload the snapshot when the hub restarted (another boot id),
   * its seq is ahead of ours, or events after its `since` were already dropped from the ring.
   */
  hello(since: number, boot: string | null, bootId: string) {
    const gap = (!!boot && boot !== bootId) || since > this.seq || (since > 0 && since < this.seq && this.oldest() > since + 1);
    return { boot: bootId, seq: this.seq, resync: gap };
  }
}

export const log = (scope: string) => {
  const on = !process.env.HUB_QUIET;
  return (...a: any[]) => {
    if (on) console.log(new Date().toISOString().slice(11, 23), `[${scope}]`, ...a);
  };
};
