import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../lib/clientLog';

interface Props {
  children: ReactNode;
  /** Short tag for the server log line, e.g. "app" or "image viewer". */
  label: string;
  /** Rendered in place of the subtree that threw. */
  fallback: (error: Error) => ReactNode;
  /** Called once per caught error, after it has been reported. */
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
}

/** Catches render errors in its subtree. React 19 doesn't hand errors caught by a boundary to
 *  window 'error', so the forwarder in main.tsx never sees them — this reports them itself. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError(`[${this.props.label}] ${error.message}`, `${error.stack ?? ''}\n${info.componentStack ?? ''}`);
    this.props.onError?.(error);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/** Full-screen recovery for a crash anywhere in the app. A home-screen install has no browser
 *  chrome, so without this Reload button the only way out of a crash is force-quitting. */
export function AppCrashScreen({ error }: { error: Error }) {
  return (
    <div className="h-dvh flex flex-col items-center justify-center gap-4 p-6 text-center bg-gray-950 text-gray-100">
      <div className="text-lg font-semibold">Something went wrong</div>
      <div className="text-xs text-gray-500 max-w-sm break-words">{error.message}</div>
      <button
        onClick={() => location.reload()}
        className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
      >
        Reload Clauder
      </button>
    </div>
  );
}
