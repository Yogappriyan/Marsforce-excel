import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiRequest } from '../api/client.ts';
import type { AuthUser, PermissionCode } from '../types/api.ts';

const ALL_PERMISSIONS: PermissionCode[] = [
  'view',
  'upload',
  'process',
  'edit',
  'approve',
  'export',
  'manage_users',
  'manage_settings',
  'delete',
];

const DEFAULT_WORKSPACE_USER: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'workspace@marsforce.local',
  fullName: 'MARSFORCE Workspace',
  role: 'SUPER_ADMIN',
  isActive: true,
  permissions: ALL_PERMISSIONS,
};

interface AuthContextValue {
  user: AuthUser;
  loading: boolean;
  hasPermission: (perm: PermissionCode) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser>(DEFAULT_WORKSPACE_USER);

  useEffect(() => {
    void apiRequest<{ user?: AuthUser }>('/api/v1/auth/me', { skipAutoRefresh: true })
      .then((res) => {
        if (res?.user) {
          setUser(res.user);
        }
      })
      .catch(() => {
        // Keep default open workspace operator if API is warming up
      });
  }, []);

  const hasPermission = useCallback(
    (perm: PermissionCode) => Boolean(user.permissions?.includes(perm) ?? true),
    [user]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        loading: false,
        hasPermission,
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
