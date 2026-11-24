import { ShieldCheck } from 'lucide-react';
import { MarsforceLogo } from '../../components/MarsforceLogo.tsx';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { useTheme } from '../../contexts/ThemeContext.tsx';

export function LoginView() {
  const { authenticating, authError, authorizedPrimaryEmail, loginWithGoogle } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen flex flex-col justify-between bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 px-6 py-8">
      <div className="max-w-5xl w-full mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MarsforceLogo size={36} />
          <div className="flex flex-col">
            <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white leading-none whitespace-nowrap">
              MARSFORCE
            </span>
            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 leading-tight mt-0.5 whitespace-nowrap">
              Excel Management
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer"
        >
          {theme === 'light' ? 'Dark mode' : 'Light mode'}
        </button>
      </div>

      <main className="max-w-md w-full mx-auto my-12 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 space-y-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
            <ShieldCheck className="w-5 h-5" />
            <span className="text-xs font-semibold tracking-wide">
              Google Authorized Access
            </span>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            MARSFORCE Workspace
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Access is restricted to authorized Google accounts. Continue with{' '}
            <span className="font-semibold text-slate-900 dark:text-white">{authorizedPrimaryEmail}</span>{' '}
            to open the Excel management workspace.
          </p>
        </div>

        {authError && (
          <div
            role="alert"
            className="p-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300 leading-relaxed"
          >
            {authError}
          </div>
        )}

        <div className="space-y-3">
          <button
            type="button"
            disabled={authenticating}
            onClick={() => void loginWithGoogle()}
            className="w-full py-3 px-4 text-sm font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 transition-colors flex items-center justify-center gap-3 cursor-pointer"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
              />
            </svg>
            <span>{authenticating ? 'Verifying Google account...' : 'Continue with Google'}</span>
          </button>

          <p className="text-center text-xs text-slate-500 dark:text-slate-400">
            Authorized administrator: <span className="font-medium text-slate-700 dark:text-slate-300">{authorizedPrimaryEmail}</span>
          </p>
        </div>
      </main>

      <footer className="max-w-5xl w-full mx-auto text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
        <span>MARSFORCE — Excel Management</span>
        <span>Google OAuth · Role-based access</span>
      </footer>
    </div>
  );
}
