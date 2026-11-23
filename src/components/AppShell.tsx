import React, { useEffect, useRef, useState } from 'react';
import {
  CheckSquare,
  CopyCheck,
  Download,
  FolderTree,
  LogOut,
  MapPin,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  UploadCloud,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { useTheme } from '../contexts/ThemeContext.tsx';
import { MarsforceLogo } from './MarsforceLogo.tsx';

export type NavSection =
  | 'upload'
  | 'geo'
  | 'review'
  | 'categories'
  | 'duplicates'
  | 'exports'
  | 'admin';

interface AppShellProps {
  activeSection: NavSection;
  onNavigate: (sec: NavSection) => void;
  globalSearch: string;
  onGlobalSearchChange: (val: string) => void;
  onGlobalSearchSubmit: () => void;
  children: React.ReactNode;
}

export function AppShell({
  activeSection,
  onNavigate,
  globalSearch,
  onGlobalSearchChange,
  onGlobalSearchSubmit,
  children,
}: AppShellProps) {
  const { user, hasPermission, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const primaryNavItems: Array<{ id: NavSection; label: string; icon: React.ReactNode; visible: boolean }> = [
    {
      id: 'upload',
      label: 'Upload & Convert',
      icon: <UploadCloud className="w-4 h-4 shrink-0" />,
      visible: hasPermission('view'),
    },
    {
      id: 'geo',
      label: 'Areas & Downloads',
      icon: <MapPin className="w-4 h-4 shrink-0" />,
      visible: hasPermission('view'),
    },
    {
      id: 'review',
      label: 'Review Records',
      icon: <CheckSquare className="w-4 h-4 shrink-0" />,
      visible: hasPermission('view'),
    },
    {
      id: 'exports',
      label: 'All Exports',
      icon: <Download className="w-4 h-4 shrink-0" />,
      visible: hasPermission('view'),
    },
  ];

  const toolNavItems: Array<{ id: NavSection; label: string; icon: React.ReactNode; visible: boolean }> = [
    {
      id: 'categories',
      label: 'Categories & Rules',
      icon: <FolderTree className="w-4 h-4 shrink-0" />,
      visible: hasPermission('view'),
    },
    {
      id: 'duplicates',
      label: 'Duplicates',
      icon: <CopyCheck className="w-4 h-4 shrink-0" />,
      visible: hasPermission('view'),
    },
    {
      id: 'admin',
      label: 'Admin & Audit',
      icon: <Settings className="w-4 h-4 shrink-0" />,
      visible: hasPermission('manage_users') || hasPermission('manage_settings'),
    },
  ];

  const handleSelectNav = (id: NavSection) => {
    onNavigate(id);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-60 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="h-14 px-4 flex items-center gap-2.5 border-b border-slate-200 dark:border-slate-800">
          <MarsforceLogo size={32} />
          <div className="flex flex-col min-w-0">
            <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white leading-none whitespace-nowrap">
              MARSFORCE
            </span>
            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 leading-tight mt-0.5 whitespace-nowrap">
              Excel Management
            </span>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Primary Navigation">
          {primaryNavItems
            .filter((i) => i.visible)
            .map((item) => {
              const active = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectNav(item.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}

          {toolNavItems.some((i) => i.visible) && (
            <div className="pt-4 mt-4 border-t border-slate-200 dark:border-slate-800 space-y-1">
              <div className="px-3 pb-1 text-xs font-medium text-slate-400 dark:text-slate-500">
                Tools
              </div>
              {toolNavItems
                .filter((i) => i.visible)
                .map((item) => {
                  const active = activeSection === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectNav(item.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {item.icon}
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
            </div>
          )}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="text-xs">
            <div className="font-semibold text-slate-900 dark:text-white truncate">{user?.fullName}</div>
            <div className="text-slate-500 dark:text-slate-400 truncate mt-0.5">
              {user?.role.replace('_', ' ')} · {user?.email}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-slate-900/50" onClick={() => setMobileMenuOpen(false)} />
          <aside className="relative w-64 max-w-full bg-white dark:bg-slate-900 h-full flex flex-col border-r border-slate-200 dark:border-slate-800">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2.5 min-w-0">
                <MarsforceLogo size={30} />
                <div className="flex flex-col min-w-0">
                  <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white leading-none">
                    MARSFORCE
                  </span>
                  <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 leading-tight mt-0.5">
                    Excel Management
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation"
                className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
              {[...primaryNavItems, ...toolNavItems]
                .filter((i) => i.visible)
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectNav(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                      activeSection === item.id
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
            </nav>
            <div className="p-4 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => void logout()}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 px-4 lg:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Menu className="w-5 h-5" />
            </button>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                onGlobalSearchSubmit();
              }}
              className="relative flex-1 max-w-lg"
            >
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="search"
                value={globalSearch}
                onChange={(e) => onGlobalSearchChange(e.target.value)}
                placeholder="Search approved & processed records by name, city, street, phone, PIN (Ctrl+K)"
                aria-label="Global record search"
                className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </form>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle color theme"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>
          </div>
        </header>

        <main className="flex-1 min-w-0 p-4 lg:p-6 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
