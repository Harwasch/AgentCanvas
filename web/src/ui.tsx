// Shared small UI bits: icons, provider badge, helpers.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { Host, Session } from './types';

export const CLOUD_COLORS: Record<string, string> = { 'cloud:claude': '#E0896B', 'cloud:codex': '#A48BFA' };
export const CLOUD_NAMES: Record<string, string> = { 'cloud:claude': 'Claude cloud', 'cloud:codex': 'Codex cloud' };

export const computeKey = (s: Pick<Session, 'kind' | 'vendor' | 'host_id'>) => (s.kind === 'cloud' ? `cloud:${s.vendor}` : s.host_id || 'unknown');
export function computeColor(key: string, hosts: Record<string, Host>) {
  return CLOUD_COLORS[key] || hosts[key]?.color || '#8A8F98';
}
export function computeName(key: string, hosts: Record<string, Host>) {
  return CLOUD_NAMES[key] || hosts[key]?.label || key;
}

export const isActive = (s: Session) => !['ended', 'error', 'applied'].includes(s.status);
export const isRunningStatus = (st: string) => st === 'running' || st === 'starting';

export function timeAgo(t: string | number | null | undefined): string {
  if (t == null || t === '') return '';
  const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function duration(t: string | number | null | undefined): string {
  if (t == null) return '';
  const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  if (!Number.isFinite(ms)) return '';
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
export const shortSha = (h?: string | null) => (h ? h.slice(0, 7) : '');

export function ProviderBadge({ vendor, size = 20 }: { vendor: string; size?: number }) {
  const cx = vendor === 'codex';
  return (
    <span
      title={cx ? 'Codex' : 'Claude Code'}
      aria-label={cx ? 'Codex' : 'Claude Code'}
      role="img"
      style={{
        width: size, height: size, flex: 'none', boxSizing: 'border-box', borderRadius: 6, background: cx ? '#1E2025' : '#2A2320',
        border: '1px solid #3A3E46', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.43, fontWeight: 700, color: '#E7E8EA', letterSpacing: '-.02em',
      }}
    >
      {cx ? 'CX' : 'CC'}
    </span>
  );
}

const P = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
export function Icon({ name, size = 14, sw = 2, style }: { name: string; size?: number; sw?: number; style?: CSSProperties }) {
  let d: ReactNode = null;
  switch (name) {
    case 'logo': d = <><circle cx="5" cy="12" r="2.5" /><circle cx="19" cy="5" r="2.5" /><circle cx="19" cy="19" r="2.5" /><path d="M7.3 11l9.4-5M7.3 13l9.4 5" /></>; break;
    case 'plus': d = <path d="M12 5v14M5 12h14" />; break;
    case 'chev': d = <path d="M6 9l6 6 6-6" />; break;
    case 'back': d = <path d="M15 6l-6 6 6 6" />; break;
    case 'search': d = <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>; break;
    case 'bell': d = <><path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 003.4 0" /></>; break;
    case 'x': d = <path d="M6 6l12 12M18 6L6 18" />; break;
    case 'check': d = <path d="M5 12l5 5 9-10" />; break;
    case 'repo': d = <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M8 8h8M8 12h8M8 16h5" /></>; break;
    case 'branch': d = <><circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="8" r="2.2" /><path d="M6 7.2v9.6M18 10.2c0 4-6 3-11 6.6" /></>; break;
    case 'app': d = <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>; break;
    case 'expand': d = <path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" />; break;
    case 'ext': d = <path d="M7 17L17 7M9 7h8v8" />; break;
    case 'menu': d = <path d="M4 7h16M4 12h16M4 17h16" />; break;
    case 'stop': d = <rect x="6" y="6" width="12" height="12" rx="2" />; break;
    case 'file': d = <path d="M6 3h9l4 4v14H6z" />; break;
    case 'refresh': d = <><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>; break;
    case 'shield': d = <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />; break;
    case 'pin': d = <path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />; break;
    default: d = null;
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={sw} {...P} aria-hidden="true" style={style}>{d}</svg>;
}

export function StatusPill({ status, onClick }: { status: string; onClick?: () => void }) {
  if (status === 'waiting') {
    return (
      <button onPointerDown={(e) => e.stopPropagation()} onClick={onClick} style={{ background: '#FFD23F', color: '#0B0C0E', fontWeight: 700, border: 0, borderRadius: 999, padding: '2px 9px', fontSize: 11, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
        Has a question <span aria-hidden="true">→</span>
      </button>
    );
  }
  if (status === 'running') return <><span className="spin" /><span>Running</span></>;
  if (status === 'starting') return <><span style={{ width: 9, height: 9, border: '1.5px dashed #A3A7AF', borderRadius: '50%', boxSizing: 'border-box' }} /><span style={{ color: '#C9CCD2' }}>Starting</span></>;
  if (status === 'pending') return <><span style={{ width: 9, height: 9, border: '1.5px dashed #A3A7AF', borderRadius: '50%', boxSizing: 'border-box' }} /><span style={{ color: '#C9CCD2' }}>Pending</span></>;
  if (status === 'ready') return <span style={{ border: '1px solid #FFD23F', color: '#FFD23F', borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>Ready</span>;
  if (status === 'idle') return <><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#5A5E67' }} /><span style={{ color: '#A3A7AF' }}>Idle</span></>;
  if (status === 'error') return <><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#E5484D' }} /><span style={{ color: '#FFB3B6' }}>Error</span></>;
  if (status === 'applied') return <><Icon name="check" size={13} sw={2.2} style={{ color: '#A3A7AF' }} /><span style={{ color: '#A3A7AF' }}>Applied</span></>;
  return <><Icon name="check" size={13} sw={2.2} style={{ color: '#A3A7AF' }} /><span style={{ color: '#A3A7AF' }}>Ended</span></>;
}

export function useIsPhone(): boolean {
  const q = '(max-width: 640px)';
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return m;
}
