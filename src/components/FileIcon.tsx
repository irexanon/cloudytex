import React from 'react';
import { Folder, File as FileIconLucide, Eye, RefreshCw, Video, HardDrive, LayoutGrid, Settings } from 'lucide-react';
import TelegramIcon from './Icons/TelegramIcon';

export default function FileIcon({ file, type, size = 'sm', isTg = false, accountId, showThumbnails = true }: { file?: any; type: string; size?: 'sm' | 'lg'; isTg?: boolean; accountId?: string | null; showThumbnails?: boolean }) {
  const container = size === 'lg' ? 'w-20 h-20 rounded-3xl' : 'w-10 h-10 rounded-xl';
  const iconSize  = size === 'lg' ? 32 : 18;
  const base      = `${container} flex items-center justify-center shrink-0 shadow-sm transition-all`;

  if (file?.type === 'image' && accountId && showThumbnails) {
    const token = localStorage.getItem('cloudyte_token');
    const url = `/api/download/${accountId}/${file.id}?preview=1&token=${token}`;
    return (
      <div className={`${container} shrink-0 overflow-hidden shadow-sm bg-slate-100 dark:bg-slate-800`}>
        <img src={url} alt={file.name} className="w-full h-full object-cover" loading="lazy" />
      </div>
    );
  }

  if (type === 'folder') return <div className={`${base} bg-amber-50 dark:bg-amber-900/20 text-amber-500 group-hover:scale-110`}><Folder size={iconSize} fill="currentColor" /></div>;
  if (isTg)             return <div className={`${base} bg-sky-50 dark:bg-sky-900/20 text-sky-500 group-hover:scale-110`}><TelegramIcon size={iconSize} /></div>;
  if (type === 'pdf')   return <div className={`${base} bg-rose-50 dark:bg-rose-900/20 text-rose-500`}><FileIconLucide size={iconSize} /></div>;
  if (type === 'image') return <div className={`${base} bg-blue-50 dark:bg-blue-900/20 text-blue-500 group-hover:scale-110`}><Eye size={iconSize} /></div>;
  if (type === 'audio') return <div className={`${base} bg-pink-50 dark:bg-pink-900/20 text-pink-500 group-hover:scale-110`}><RefreshCw size={iconSize} /></div>;
  if (type === 'video') return <div className={`${base} bg-purple-50 dark:bg-purple-900/20 text-purple-500 group-hover:scale-110`}><Video size={iconSize} /></div>;
  if (type === 'sheet') return <div className={`${base} bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600`}><HardDrive size={iconSize} /></div>;
  if (type === 'doc')   return <div className={`${base} bg-blue-50 dark:bg-blue-900/20 text-blue-600`}><FileIconLucide size={iconSize} /></div>;
  if (type === 'slide') return <div className={`${base} bg-orange-50 dark:bg-orange-900/20 text-orange-600`}><LayoutGrid size={iconSize} /></div>;
  if (type === 'zip')   return <div className={`${base} bg-slate-100 dark:bg-slate-800 text-slate-600`}><Settings size={iconSize} /></div>;
  
  return <div className={`${base} bg-slate-50 dark:bg-slate-900 text-slate-400`}><FileIconLucide size={iconSize} /></div>;
}
