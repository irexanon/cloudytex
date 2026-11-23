import React from 'react';

export default function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-2.5 border-b border-[var(--bd)]/70 last:border-b-0 gap-4">
      <span className="text-xs font-medium text-[var(--sub)] shrink-0">{label}</span>
      <span className="text-xs font-medium text-[var(--tx)] truncate max-w-[200px] tabular-nums text-right">
        {value}
      </span>
    </div>
  );
}
