import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, makeQueryClient, Providers } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers client={makeQueryClient()}>
      <App />
    </Providers>
  </StrictMode>,
);
