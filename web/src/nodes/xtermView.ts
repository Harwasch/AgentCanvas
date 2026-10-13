// xterm.js terminal bound to WS /api/terminals/:id/ws (loaded on demand). The hub side is a tmux
// session, so reconnecting simply re-attaches.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { openTerminalSocket, type TermSocket } from '../api';

export type TermStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface XtermHandle { dispose(): string[]; focus(): void; setFontSize(px: number): void }

export function mountXterm(el: HTMLElement, id: string, opts: { onStatus: (s: TermStatus) => void; shouldReconnect: () => boolean; fontSize?: number }): XtermHandle {
  const term = new Terminal({
    fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: opts.fontSize || 12, lineHeight: 1.2, cursorBlink: true, scrollback: 3000, allowProposedApi: false,
    theme: { background: '#08090A', foreground: '#E7E8EA', cursor: '#E7E8EA', selectionBackground: '#3A3E46', black: '#15171B', brightBlack: '#5A5E67' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  let ws: TermSocket | null = null;
  let disposed = false;
  let backoff = 800;
  let timer: number | undefined;
  const dec = new TextDecoder();

  const sendResize = () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  const doFit = () => {
    if (disposed || !el.clientWidth || !el.clientHeight) return;
    const before = `${term.cols}x${term.rows}`;
    try { fit.fit(); } catch { /* not measurable yet */ }
    if (`${term.cols}x${term.rows}` !== before) sendResize();
  };
  const connect = () => {
    if (disposed) return;
    opts.onStatus(ws ? 'reconnecting' : 'connecting');
    const s = openTerminalSocket(id);
    ws = s;
    s.binaryType = 'arraybuffer';
    s.onopen = () => { backoff = 800; opts.onStatus('open'); doFit(); sendResize(); };
    s.onmessage = (e) => {
      const d = e.data;
      if (typeof d === 'string') term.write(d);
      else if (d instanceof ArrayBuffer) term.write(new Uint8Array(d));
      else if (d instanceof Blob) void d.arrayBuffer().then((b) => term.write(new Uint8Array(b)));
      else if (ArrayBuffer.isView(d)) term.write(dec.decode(d as ArrayBufferView));
    };
    s.onclose = () => {
      if (disposed || ws !== s) return;
      if (!opts.shouldReconnect()) { opts.onStatus('closed'); return; }
      opts.onStatus('reconnecting');
      timer = window.setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
    s.onerror = () => { try { s.close(); } catch { /* */ } };
  };
  term.onData((data) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data })); });
  const ro = new ResizeObserver(() => doFit());
  ro.observe(el);
  requestAnimationFrame(doFit);
  connect();

  return {
    focus: () => term.focus(),
    // expand / collapse: same terminal and socket, new font size, refit (sends the new cols/rows)
    setFontSize: (px: number) => {
      if (disposed || term.options.fontSize === px) return;
      term.options.fontSize = px;
      requestAnimationFrame(doFit);
    },
    dispose: () => {
      disposed = true;
      window.clearTimeout(timer);
      ro.disconnect();
      const lines: string[] = [];
      const buf = term.buffer.active;
      for (let i = Math.max(0, buf.length - 40); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      try { ws?.close(); } catch { /* */ }
      ws = null;
      term.dispose();
      return lines;
    },
  };
}
