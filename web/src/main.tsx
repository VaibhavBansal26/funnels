import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, makeQueryClient, Providers } from './App';
import './styles.css';
import { applyTheme } from './ui/theme';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startMonitoring } from './monitoring';

applyTheme(); // before the first paint: the stored light/dark choice wins over the system setting

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Providers client={makeQueryClient()}>
        <App />
      </Providers>
    </ErrorBoundary>
  </StrictMode>,
);

void startMonitoring(); // asks /api/config; without a DSN nothing else happens
