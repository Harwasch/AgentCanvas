// Web push subscription (service worker registered in main.tsx).
import { api } from './api';

function b64ToBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('service worker not active')), 4000)),
  ]);
  return reg;
}

export async function pushEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try { return !!(await (await registration()).pushManager.getSubscription()); } catch { return false; }
}

export async function enablePush(vapidHint?: string): Promise<void> {
  if (!pushSupported()) throw new Error('Push is not supported in this browser (on iOS: add to Home Screen first)');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notification permission was not granted');
  const reg = await registration();
  const key = vapidHint || (await api.vapid()).publicKey;
  if (!key) throw new Error('Hub has no VAPID key configured');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) as BufferSource });
  await api.pushSubscribe(sub.toJSON());
}

export async function disablePush(): Promise<void> {
  try { const sub = await (await registration()).pushManager.getSubscription(); await sub?.unsubscribe(); } catch { /* */ }
}
