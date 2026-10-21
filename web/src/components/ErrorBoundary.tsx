import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useRouteError } from 'react-router';
import { reportRenderError } from '../monitoring';

function Fallback({ onReload }: { onReload: () => void }) {
  return (
    <div className="mx-auto mt-24 max-w-md px-4 text-center" role="alert">
      <h1>Something went wrong</h1>
      <p className="muted">The page hit an unexpected error. Your work is saved as far as the last save. Reloading usually fixes it.</p>
      <p><button type="button" className="btn primary" onClick={onReload}>Reload the page</button></p>
    </div>
  );
}

/** Catches render errors outside the router, reports them (when monitoring is on) and shows a plain fallback instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    reportRenderError(error);
  }
  render() {
    return this.state.failed ? <Fallback onReload={() => location.reload()} /> : this.props.children;
  }
}

/** The router's `errorElement`: render and loader errors of any route land here. */
export function RouteErrorPage() {
  const error = useRouteError();
  reportRenderError(error);
  return <Fallback onReload={() => location.reload()} />;
}
