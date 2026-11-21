import React from 'react';
import {
  Folder,
  File as FileIconLucide,
  Image as ImageIcon,
  Music,
  Video,
  FileSpreadsheet,
  FileText,
  Presentation,
  FileArchive,
} from 'lucide-react';
import TelegramIcon from './Icons/TelegramIcon';

export function getFileTintClasses(type: string, isTg = false): string {
  if (type === 'folder') return 'bg-[#F59E0B]/15 text-[#F59E0B]';
  if (isTg && type === 'other') return 'bg-[#38BDF8]/15 text-[#0EA5E9] dark:text-[#38BDF8]';
  if (type === 'pdf') return 'bg-[#F43F5E]/15 text-[#F43F5E]';
  if (type === 'sheet') return 'bg-[#10B981]/15 text-[#10B981]';
  if (type === 'doc') return 'bg-[#3B82F6]/15 text-[#3B82F6]';
  if (type === 'video') return 'bg-[#A855F7]/15 text-[#A855F7]';
  if (type === 'zip') return 'bg-[#94A3B8]/18 text-[#64748B] dark:text-[#94A3B8]';
  if (type === 'slide') return 'bg-[#F97316]/15 text-[#F97316]';
  if (type === 'image') return 'bg-[#14B8A6]/15 text-[#14B8A6]';
  if (type === 'audio') return 'bg-[#EC4899]/15 text-[#EC4899]';
  return 'bg-slate-200/60 dark:bg-slate-800 text-[var(--sub)]';
}

export function renderFileTypeGlyph(type: string, iconSize: number, isTg = false) {
  if (type === 'folder') return <Folder size={iconSize} fill="currentColor" />;
  if (isTg && type === 'other') return <TelegramIcon size={iconSize} />;
  if (type === 'pdf') return <FileText size={iconSize} />;
  if (type === 'image') return <ImageIcon size={iconSize} />;
  if (type === 'audio') return <Music size={iconSize} />;
  if (type === 'video') return <Video size={iconSize} />;
  if (type === 'sheet') return <FileSpreadsheet size={iconSize} />;
  if (type === 'doc') return <FileText size={iconSize} />;
  if (type === 'slide') return <Presentation size={iconSize} />;
  if (type === 'zip') return <FileArchive size={iconSize} />;
  return <FileIconLucide size={iconSize} />;
}

export default function FileIcon({
  file,
  type,
  size = 'sm',
  isTg = false,
  accountId,
  showThumbnails = true,
}: {
  file?: any;
  type: string;
  size?: 'sm' | 'lg' | 'card';
  isTg?: boolean;
  accountId?: string | null;
  showThumbnails?: boolean;
}) {
  const iconSize = size === 'card' ? 42 : size === 'lg' ? 40 : 20;
  const containerClass =
    size === 'card'
      ? 'w-full h-[108px]'
      : size === 'lg'
      ? 'w-20 h-20 rounded-2xl'
      : 'w-10 h-10 rounded-xl';
  const tintClass = getFileTintClasses(type, isTg);

  if (file?.type === 'image' && accountId && showThumbnails) {
    const token = localStorage.getItem('cloudyte_token');
    const url = `/api/download/${accountId}/${file.id}?preview=1&token=${token}`;
    return (
      <div className={`${containerClass} shrink-0 overflow-hidden bg-[var(--sf)] relative flex items-center justify-center ${size === 'card' ? '' : 'border border-[var(--bd)]'}`}>
        <img
          src={url}
          alt={file.name}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div className={`${containerClass} ${tintClass} flex items-center justify-center shrink-0 transition-colors`}>
      {renderFileTypeGlyph(type, iconSize, isTg)}
    </div>
  );
}
