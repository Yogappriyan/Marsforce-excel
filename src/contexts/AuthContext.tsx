import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  apiRequest,
  clearClientAuthTokens,
  registerUnauthorizedHandler,
} from '../api/client.ts';
import type { AuthUser, PermissionCode } from '../types/api.ts';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  needsInitialSetup: boolean;
  hasPermission: (perm: PermissionCode) => boolean;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
  setUserDirect: (u: AuthUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsInitialSetup, setNeedsInitialSetup] = useState(false);

  const refreshUser = useCallback(async () => {
    setLoading(true);
    try {
      const status = await apiRequest<{ needsInitialSetup: boolean }>('/api/v1/auth/status', {
        skipAutoRefresh: true,
      });
      setNeedsInitialSetup(status.needsInitialSetup);

      if (!status.needsInitialSetup) {
        const me = await apiRequest<{ user: AuthUser }>('/api/v1/auth/me');
        setUser(me.user);
      } else {
        clearClientAuthTokens();
        setUser(null);
      }
    } catch {
      clearClientAuthTokens();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    registerUnauthorizedHandler(() => {
      setUser(null);
    });
    void refreshUser();
    return () => registerUnauthorizedHandler(null);
  }, [refreshUser]);

  const logout = useCallback(async () => {
    try {
      await apiRequest('/api/v1/auth/logout', { method: 'POST', skipAutoRefresh: true });
    } catch {
      // Clear local auth regardless
    }
    clearClientAuthTokens();
    setUser(null);
  }, []);

  const hasPermission = useCallback(
    (perm: PermissionCode) => Boolean(user?.permissions?.includes(perm)),
    [user]
  );

  const setUserDirect = useCallback((u: AuthUser | null) => {
    setUser(u);
    if (u) setNeedsInitialSetup(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        needsInitialSetup,
        hasPermission,
        refreshUser,
        logout,
        setUserDirect,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
