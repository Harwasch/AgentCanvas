import { createRoot } from 'react-dom/client';
import App from './App';
import { setMockHandler } from './api';
import { startLive, startMock } from './store';
import './styles.css';

const params = new URLSearchParams(location.search);
const mock = params.get('mock') === '1';

async function boot() {
  if (mock) {
    const m = await import('./mock');
    setMockHandler(m.handle);
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
