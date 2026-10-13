import { createRoot } from 'react-dom/client';
import App from './App';
import { setMockHandler, setMockRaw, setMockTerminal } from './api';
import { startLive, startMock } from './store';
import './styles.css';

const params = new URLSearchParams(location.search);
// The mock hub exists in `vite dev` (?mock=1) and in demo builds (VITE_DEMO=1) only: in a production build this
// condition is the constant false, so the dynamic import below and the whole mock chunk are dropped.
const MOCK_BUILD = import.meta.env.DEV || import.meta.env.VITE_DEMO === '1';
const mock = MOCK_BUILD && (params.get('mock') === '1' || import.meta.env.VITE_DEMO === '1');

async function boot() {
  if (MOCK_BUILD && mock) {
    const m = await import('./mock');
    setMockHandler(m.handle);
    setMockTerminal(m.mockTerminal);
    setMockRaw(m.mockRaw);
    startMock(m.subscribe, m.snapshot());
  } else {
    void startLive();
    if ('serviceWorker' in navigator && !params.has('shot') && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('sw registration failed', e));
      });
    }
  }
  createRoot(document.getElementById('root')!).render(<App />);
}

void boot();
