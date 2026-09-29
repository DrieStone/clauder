import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { GuestApp } from './components/GuestView';
import { ErrorBoundary, AppCrashScreen } from './components/ErrorBoundary';
import { reportClientError } from './lib/clientLog';
import './styles/globals.css';

// Forward uncaught browser errors to the server log (/api/client-log → `[client:mobile]` lines in
// ~/.clauder/clauder.log). The browser had zero telemetry before this — every mobile bug was
// diagnosed blind from screenshots. Dedupe and rate-limiting live in lib/clientLog.
window.addEventListener('error', (e) => {
  reportClientError(e.message || 'Unknown error', e.error?.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r: unknown = e.reason;
  if (r instanceof Error) reportClientError(`Unhandled rejection: ${r.message}`, r.stack);
  else reportClientError(`Unhandled rejection: ${String(r).slice(0, 200)}`);
});

// A share link (/s/<token>) opens one session for a guest; everything else is the full app.
const shareToken = /^\/s\/([A-Za-z0-9_-]{16,})\/?$/.exec(window.location.pathname)?.[1];

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Without a boundary, one render error unmounts the whole app and a home-screen install is
        left on a black screen whose only exit is force-quitting (the image-viewer pan crash). */}
    <ErrorBoundary label="app" fallback={(error) => <AppCrashScreen error={error} />}>
      {shareToken ? <GuestApp token={shareToken} /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
