const rawBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '';
export const API_BASE_URL = rawBase.replace(/\/+$/, '');

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

async function parseErrorResponse(res: Response, fallbackPrefix: string): Promise<{ code: string; message: string; details?: unknown }> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await res.json();
      const errObj = data?.error;
      if (errObj?.message) {
        return {
          code: errObj.code || `HTTP_${res.status}`,
          message: errObj.message,
          details: errObj.details,
        };
      }
    } catch {
      // Fall through to text handling
    }
  }

  let textSnippet = '';
  try {
    const rawText = await res.text();
    const trimmed = rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (trimmed) {
      textSnippet = trimmed.slice(0, 220);
    }
  } catch {
    // Ignore read error
  }

  if (res.status === 413) {
    return {
      code: 'FILE_TOO_LARGE',
      message: textSnippet || 'Uploaded file exceeds the request body limit (4.5 MB on Vercel serverless or configured server limit).',
    };
  }

  return {
    code: `HTTP_${res.status}`,
    message: textSnippet || `${fallbackPrefix} (status ${res.status})`,
  };
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { skipAutoRefresh?: boolean } = {}
): Promise<T> {
  const { skipAutoRefresh: _ignored, headers, ...rest } = options;
  const isFormData = rest.body instanceof FormData;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(headers || {}),
    },
  });

  if (!res.ok) {
    const parsed = await parseErrorResponse(res, 'Request failed');
    throw new ApiError(res.status, parsed.code, parsed.message, parsed.details);
  }

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;
  return data as T;
}

export function buildApiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export async function downloadAuthenticatedFile(path: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
  });

  if (!res.ok) {
    const parsed = await parseErrorResponse(res, 'Download failed');
    throw new ApiError(res.status, parsed.code, parsed.message, parsed.details);
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
