const rawBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '';
export const API_BASE_URL = rawBase.replace(/\/+$/, '');

const ACCESS_KEY = 'marsforce_access_token';
const REFRESH_KEY = 'marsforce_refresh_token';
const LEGACY_ACCESS_KEY = 'structiq_access_token';
const LEGACY_REFRESH_KEY = 'structiq_refresh_token';

let memAccessToken: string | null = null;
let memRefreshToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

function readStorage(key: string, legacyKey?: string): string | null {
  try {
    const val = window.sessionStorage.getItem(key);
    if (val) return val;
    if (legacyKey) {
      const legacy = window.sessionStorage.getItem(legacyKey);
      if (legacy) {
        window.sessionStorage.setItem(key, legacy);
        window.sessionStorage.removeItem(legacyKey);
        return legacy;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, val: string | null, legacyKey?: string) {
  try {
    if (val) window.sessionStorage.setItem(key, val);
    else window.sessionStorage.removeItem(key);
    if (legacyKey) window.sessionStorage.removeItem(legacyKey);
  } catch {
    // Ignore storage restrictions
  }
}

export function setClientAuthTokens(accessToken?: string | null, refreshToken?: string | null) {
  if (accessToken !== undefined) {
    memAccessToken = accessToken || null;
    writeStorage(ACCESS_KEY, memAccessToken, LEGACY_ACCESS_KEY);
  }
  if (refreshToken !== undefined) {
    memRefreshToken = refreshToken || null;
    writeStorage(REFRESH_KEY, memRefreshToken, LEGACY_REFRESH_KEY);
  }
}

export function clearClientAuthTokens() {
  memAccessToken = null;
  memRefreshToken = null;
  writeStorage(ACCESS_KEY, null, LEGACY_ACCESS_KEY);
  writeStorage(REFRESH_KEY, null, LEGACY_REFRESH_KEY);
}

export function getAccessToken(): string | null {
  return memAccessToken || readStorage(ACCESS_KEY, LEGACY_ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return memRefreshToken || readStorage(REFRESH_KEY, LEGACY_REFRESH_KEY);
}

export function getAuthHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function registerUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function tryRefreshSession(): Promise<boolean> {
  if (!refreshPromise) {
    const rt = getRefreshToken();
    refreshPromise = fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rt ? { refreshToken: rt } : {}),
    })
      .then(async (res) => {
        if (!res.ok) {
          clearClientAuthTokens();
          return false;
        }
        try {
          const data = await res.json();
          if (data?.accessToken || data?.refreshToken) {
            setClientAuthTokens(data.accessToken, data.refreshToken);
          }
        } catch {
          // Ignore non-JSON refresh payload
        }
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { skipAutoRefresh?: boolean } = {}
): Promise<T> {
  const { skipAutoRefresh, headers, ...rest } = options;
  const isFormData = rest.body instanceof FormData;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...getAuthHeaders(),
      ...(headers || {}),
    },
  });

  const isPublicAuthRoute =
    path.includes('/auth/login') ||
    path.includes('/auth/setup') ||
    path.includes('/auth/refresh') ||
    path.includes('/auth/status') ||
    path.includes('/auth/logout');

  if (res.status === 401 && !isPublicAuthRoute) {
    if (!skipAutoRefresh) {
      const refreshed = await tryRefreshSession();
      if (refreshed) {
        return apiRequest<T>(path, { ...options, skipAutoRefresh: true });
      }
    }
    clearClientAuthTokens();
    unauthorizedHandler?.();
  }

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    const errObj = data?.error;
    throw new ApiError(
      res.status,
      errObj?.code || `HTTP_${res.status}`,
      errObj?.message || `Request failed with status ${res.status}`,
      errObj?.details
    );
  }

  return data as T;
}

export function buildApiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export async function downloadAuthenticatedFile(path: string, fallbackFilename: string): Promise<void> {
  const doFetch = () =>
    fetch(`${API_BASE_URL}${path}`, {
      credentials: 'include',
      headers: getAuthHeaders(),
    });
  let res = await doFetch();
  if (res.status === 401) {
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      res = await doFetch();
    }
    if (res.status === 401) {
      clearClientAuthTokens();
      unauthorizedHandler?.();
    }
  }
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error?.message) msg = data.error.message;
    } catch {
      // ignore non-json
    }
    throw new ApiError(res.status, `HTTP_${res.status}`, msg);
  }

  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const match = cd.match(/filename="?([^"]+)"?/i);
  const filename = match?.[1] || fallbackFilename;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function generateAndDownloadExport(params: {
  exportMode: import('../types/api.ts').ExportMode;
  splitBy?: 'NONE' | 'CITY' | 'DISTRICT' | 'STATE' | 'CATEGORY';
  includeOriginalSheet?: boolean;
  columnOrder?: string[];
  filters?: Record<string, unknown>;
  onUpdate?: (exportRecord: import('../types/api.ts').ExportDTO) => void;
}): Promise<import('../types/api.ts').ExportDTO> {
  const created = await apiRequest<{ exportRecord: import('../types/api.ts').ExportDTO }>('/api/v1/exports', {
    method: 'POST',
    body: JSON.stringify({
      exportMode: params.exportMode,
      splitBy: params.splitBy ?? 'NONE',
      includeOriginalSheet: params.includeOriginalSheet ?? true,
      ...(params.columnOrder ? { columnOrder: params.columnOrder } : {}),
      filters: params.filters ?? {},
    }),
  });

  let current = created.exportRecord;
  params.onUpdate?.(current);

  const deadline = Date.now() + 180_000;
  while (['QUEUED', 'RUNNING'].includes(current.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    const check = await apiRequest<{ exportRecord: import('../types/api.ts').ExportDTO }>(
      `/api/v1/exports/${current.id}`
    );
    current = check.exportRecord;
    params.onUpdate?.(current);
  }

  if (current.status === 'FAILED') {
    throw new Error(current.error_message || 'Export generation failed.');
  }
  if (current.status !== 'COMPLETED') {
    throw new Error('Export is still processing. Check All Exports shortly.');
  }

  await downloadAuthenticatedFile(`/api/v1/exports/${current.id}/download`, current.filename);
  return current;
}

