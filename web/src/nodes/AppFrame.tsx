// Live MCP App iframe + host bridge. Mounted only while `live` is true; before
// removal of an initialized view we send `ui/resource-teardown` (best effort).
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppBridge } from '../bridge';
import type { AppNode } from '../types';

export function AppFrame({ node, live, width, height, reloadKey = 0, onReady }: {
  node: AppNode; live: boolean; width: number; height: number; reloadKey?: number; onReady?: () => void;
}) {
  const [mounted, setMounted] = useState(live);
  const [ready, setReady] = useState(false);
  const bridgeRef = useRef<AppBridge | null>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const liveRef = useRef(live);
  liveRef.current = live;
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };
  const readyCb = useRef(onReady);
  readyCb.current = onReady;

  useEffect(() => {
    if (live) { setMounted(true); return; }
    if (!mounted) return;
    const b = bridgeRef.current;
    let cancelled = false;
    (b ? b.teardown(250) : Promise.resolve()).then(() => { if (!cancelled && !liveRef.current) setMounted(false); });
    return () => { cancelled = true; };
  }, [live, mounted]);

  // tell the view when its state changes (e.g. promoted)
  useEffect(() => {
    bridgeRef.current?.notify('ui/notifications/host-context-changed', { appState: node.state });
  }, [node.state]);

  const iframeRef = useCallback((el: HTMLIFrameElement | null) => {
    if (bridgeRef.current) {
      const old = bridgeRef.current;
      bridgeRef.current = null;
      void old.teardown(150).finally(() => old.detach());
      setReady(false);
    }
    if (el) {
      const b = new AppBridge(el, {
        getNode: () => nodeRef.current,
        getSize: () => sizeRef.current,
        onReady: () => { setReady(true); readyCb.current?.(); },
      });
      b.attach();
      bridgeRef.current = b;
    }
  }, []);

  useEffect(() => () => {
    const b = bridgeRef.current;
    if (b) { void b.teardown(100).finally(() => b.detach()); bridgeRef.current = null; }
  }, []);

  if (!mounted) return null;
  return (
    <iframe
      key={`${node.url}#${reloadKey}`}
      ref={iframeRef}
      title={node.title}
      {...(mockSrcdoc(node.url) != null ? { srcDoc: mockSrcdoc(node.url)! } : { src: node.url })}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      data-ready={ready ? '1' : '0'}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: '#0B0C0E', colorScheme: 'dark' }}
    />
  );
}

/** Mock/demo builds hand the app HTML over as srcdoc (works where blob: frames are blocked). */
function mockSrcdoc(url: string): string | null {
  return ((window as any).__mockAppHtml || {})[url] ?? null;
}
