import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
  details: string | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '', details: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let message = error.message || 'An unexpected application error occurred.';
    let details: string | null = null;
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === 'object' && parsed.operationType && parsed.error) {
        message = `Firestore ${parsed.operationType} error at "${parsed.path || 'unknown'}": ${parsed.error}`;
        details = JSON.stringify(parsed, null, 2);
      }
    } catch {
      // Plain error message
    }
    return { hasError: true, message, details };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[MARSFORCE ErrorBoundary]', error, info.componentStack);
  }

  override render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-6">
        <div className="max-w-lg w-full bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900 rounded-xl p-6 space-y-4 shadow-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-red-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h1 className="text-base font-bold text-slate-900 dark:text-white">
                Something went wrong
              </h1>
              <p className="text-sm text-red-700 dark:text-red-300 mt-1 break-words">
                {this.state.message}
              </p>
            </div>
          </div>

          {this.state.details && (
            <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono text-slate-600 dark:text-slate-400 overflow-auto max-h-48">
              {this.state.details}
            </pre>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: '', details: null })}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              Try Again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload Workspace
            </button>
          </div>
        </div>
      </div>
    );
  }
}
