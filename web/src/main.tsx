import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { SessionProvider } from './lib/session';
import { UiProvider } from './lib/ui-state';
import './styles.css';

// Theme before first paint: the saved choice, else the command-center look. (Inline scripts are blocked by CSP.)
try {
  const t = localStorage.getItem('cos-theme-v2');
  document.documentElement.dataset.theme = t === 'light' || t === 'dark' ? t : 'command';
} catch {
  document.documentElement.dataset.theme = 'command';
}

const qc = new QueryClient({
  defaultOptions: { queries: { retry: (n, e: any) => e?.status !== 401 && e?.status !== 403 && n < 2, refetchOnWindowFocus: true, staleTime: 15_000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <UiProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </UiProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
