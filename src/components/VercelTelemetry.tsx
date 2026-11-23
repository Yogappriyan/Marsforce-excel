import { Analytics, track } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';

function isVercelHosted(): boolean {
  if (typeof window === 'undefined') return false;
  if (import.meta.env.VITE_VERCEL_BUILD === true) return true;
  if (import.meta.env.VITE_VERCEL_BUILD === 'true') return true;
  return window.location.hostname.endsWith('.vercel.app');
}

export function trackVercelEvent(
  name: string,
  properties?: Record<string, string | number | boolean | null | undefined>
): void {
  if (!isVercelHosted()) return;
  try {
    track(name, properties);
  } catch {
    // Ignore telemetry errors
  }
}

export function VercelTelemetry({ route }: { route: string }) {
  if (!isVercelHosted()) {
    return null;
  }

  return (
    <>
      <Analytics route={route} path={route} />
      <SpeedInsights route={route} />
    </>
  );
}
