// Web push (VAPID). The PWA's service worker shows the notification.
import webpush from 'web-push';
import type { Ctx } from './ctx.js';
import { saveSecrets } from './config.js';
import { log } from './events.js';

const L = log('push');

export class Push {
  sent: { title: string; body: string; ts: number; delivered: number }[] = [];
  constructor(private c: Ctx) {
    if (!c.secrets.vapid) {
      c.secrets.vapid = webpush.generateVAPIDKeys();
      saveSecrets(c.cfg.dataDir, c.secrets);
    }
    webpush.setVapidDetails(c.cfg.push.subject, c.secrets.vapid.publicKey, c.secrets.vapid.privateKey);
  }
  get publicKey() {
    return this.c.secrets.vapid!.publicKey;
  }
  subscribe(sub: any) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('invalid push subscription');
    this.c.db.upsert('push_sub', { endpoint: sub.endpoint, keys: sub.keys, created_at: Date.now() }, 'endpoint');
  }
  /** Fire-and-forget; also emitted as a toast so open PWAs see it without push. */
  notify(n: { title: string; body: string; tag?: string; url?: string }) {
    this.c.bus.publish('toast', { text: `${n.title}: ${n.body}`, level: 'info' });
    const subs = this.c.db.all('SELECT * FROM push_sub');
    const rec = { title: n.title, body: n.body, ts: Date.now(), delivered: 0 };
    this.sent.push(rec);
    if (this.sent.length > 100) this.sent.shift();
    for (const s of subs) {
      webpush
        .sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(n), { TTL: 600 })
        .then(() => rec.delivered++)
        .catch((e: any) => {
          if (e.statusCode === 404 || e.statusCode === 410) this.c.db.run('DELETE FROM push_sub WHERE endpoint=?', s.endpoint);
          else L(`push to ${String(s.endpoint).slice(0, 40)}… failed: ${e.statusCode || e.message}`);
        });
    }
  }
}
