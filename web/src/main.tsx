import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, makeQueryClient, Providers } from './App';
import './styles.css';
import { applyTheme } from './ui/theme';

applyTheme(); // before the first paint: the stored light/dark choice wins over the system setting

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers client={makeQueryClient()}>
      <App />
    </Providers>
  </StrictMode>,
);
