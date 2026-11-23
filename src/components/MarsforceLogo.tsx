import { useState } from 'react';

interface MarsforceLogoProps {
  size?: number;
  className?: string;
}

export function MarsforceLogo({ size = 34, className = '' }: MarsforceLogoProps) {
  const [failed, setFailed] = useState(false);

  return (
    <div
      style={{ width: size, height: size }}
      className={`shrink-0 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-[#0B2545] flex items-center justify-center shadow-xs ${className}`}
    >
      {!failed ? (
        <img
          src="/src/assets/images/marsforce_logo_1795342817280.jpg"
          alt="MARSFORCE logo"
          width={size}
          height={size}
          onError={() => setFailed(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <svg
          viewBox="0 0 36 36"
          fill="none"
          aria-label="MARSFORCE logo"
          className="w-full h-full"
        >
          <rect width="36" height="36" rx="6" fill="#0B2545" />
          <path
            d="M8 26V10L18 19.5L28 10V26"
            stroke="#38BDF8"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x="15.5" y="21.5" width="5" height="4.5" rx="1" fill="#10B981" />
        </svg>
      )}
    </div>
  );
}
