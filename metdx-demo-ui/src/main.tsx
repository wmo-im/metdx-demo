import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import 'ol/ol.css';
import App from './App';
import { loadConfig } from './lib/config';
import { enableMockMode, isMockMode } from './lib/mockFetch';

if (isMockMode()) enableMockMode();

void loadConfig().then(() => {
  render();
});

// VITE_ROUTER=hash: routes live in the URL fragment, so reloads and deep links work on static hosts (GitHub Pages).
const Router = import.meta.env.VITE_ROUTER === 'hash' ? HashRouter : BrowserRouter;

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </Router>
    </StrictMode>,
  );
}
