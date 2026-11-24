import React, { useState } from 'react';
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { apiRequest, ApiError, setClientAuthTokens } from '../../api/client.ts';
import { MarsforceLogo } from '../../components/MarsforceLogo.tsx';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { useTheme } from '../../contexts/ThemeContext.tsx';
import type { AuthUser } from '../../types/api.ts';

interface AuthResponse {
  user: AuthUser;
  accessToken?: string;
  refreshToken?: string;
}

export function LoginView() {
  const { needsInitialSetup, vercelEphemeralWarning, setUserDirect } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (needsInitialSetup) {
        const res = await apiRequest<AuthResponse>('/api/v1/auth/setup', {
          method: 'POST',
          body: JSON.stringify({ email, fullName, password }),
        });
        setClientAuthTokens(res.accessToken, res.refreshToken);
        setUserDirect(res.user);
      } else {
        const res = await apiRequest<AuthResponse>('/api/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        setClientAuthTokens(res.accessToken, res.refreshToken);
        setUserDirect(res.user);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Unable to reach server. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

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
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
        >
          {theme === 'light' ? 'Dark mode' : 'Light mode'}
        </button>
      </div>

      <main className="max-w-md w-full mx-auto my-12 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8">
        <div className="flex items-center gap-2.5 mb-2 text-blue-600 dark:text-blue-400">
          {needsInitialSetup ? <ShieldCheck className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
          <span className="text-xs font-semibold tracking-wide">
            {needsInitialSetup ? 'Initial Workspace Setup' : 'Workspace Sign In'}
          </span>
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-2">
          {needsInitialSetup ? 'Create Super Admin Account' : 'Sign in to MARSFORCE'}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
          {needsInitialSetup
            ? 'No administrator exists yet. Create the primary Super Admin account to initialize this workspace.'
            : 'Enter your corporate credentials to access the data structuring pipeline.'}
        </p>

        {vercelEphemeralWarning && (
          <div className="mb-5 p-3 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
            Vercel serverless mode needs <code className="font-semibold">DATABASE_URL</code> (or <code className="font-semibold">POSTGRES_URL</code>) and <code className="font-semibold">SESSION_SECRET</code> in Vercel Project Environment Variables so sessions persist across serverless instances.
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-5 p-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {needsInitialSetup && (
            <div>
              <label htmlFor="fullName" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Full name
              </label>
              <input
                id="fullName"
                type="text"
                required
                minLength={2}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Priya Ramanathan"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Work email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete={needsInitialSetup ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full px-3.5 py-2.5 pr-10 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {needsInitialSetup && (
              <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                Minimum 6 characters.
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
          >
            {submitting
              ? 'Authenticating...'
              : needsInitialSetup
                ? 'Initialize Workspace'
                : 'Sign In'}
          </button>
        </form>
      </main>

      <footer className="max-w-5xl w-full mx-auto text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
        <span>MARSFORCE — Excel Management</span>
        <span>Persistent sign-in · Role-based access</span>
      </footer>
    </div>
  );
}
