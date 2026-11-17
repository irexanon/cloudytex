import React from 'react';

export default function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-3 border-b border-slate-50 dark:border-slate-700/50">
      <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest">{label}</span>
      <span className="text-xs font-bold text-slate-700 dark:text-slate-300">{value}</span>
    </div>
  );
}
