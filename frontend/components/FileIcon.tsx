import React, { useEffect, useState } from 'react';
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
  Play,
} from 'lucide-react';
import TelegramIcon from './Icons/TelegramIcon';

export function getFileTintClasses(type: string, isTg = false): string {
  if (type === 'folder') return 'bg-[#F59E0B]/12 text-[#D97706] dark:text-[#F59E0B]';
  if (isTg && type === 'other') return 'bg-[#38BDF8]/12 text-[#0284C7] dark:text-[#38BDF8]';
  if (type === 'pdf') return 'bg-[#F43F5E]/12 text-[#E11D48] dark:text-[#FB7185]';
  if (type === 'sheet') return 'bg-[#10B981]/12 text-[#059669] dark:text-[#34D399]';
  if (type === 'doc') return 'bg-[#3B82F6]/12 text-[#2563EB] dark:text-[#60A5FA]';
  if (type === 'video') return 'bg-[#A855F7]/12 text-[#9333EA] dark:text-[#C084FC]';
  if (type === 'zip') return 'bg-[#94A3B8]/15 text-[#475569] dark:text-[#94A3B8]';
  if (type === 'slide') return 'bg-[#F97316]/12 text-[#EA580C] dark:text-[#FB923C]';
  if (type === 'image') return 'bg-[#14B8A6]/12 text-[#0D9488] dark:text-[#2DD4BF]';
  if (type === 'audio') return 'bg-[#EC4899]/12 text-[#DB2777] dark:text-[#F472B6]';
  return 'bg-[var(--hover)] text-[var(--sub)]';
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

function getFileExtensionLabel(file?: any, type?: string): string {
  const name = String(file?.name || '');
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < name.length - 1) {
    const ext = name.slice(dotIdx + 1).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (ext.length >= 2 && ext.length <= 5) return ext;
  }
  if (type === 'pdf') return 'PDF';
  if (type === 'sheet') return 'SHEET';
  if (type === 'doc') return 'DOC';
  if (type === 'slide') return 'SLIDE';
  if (type === 'video') return 'VIDEO';
  if (type === 'audio') return 'AUDIO';
  if (type === 'zip') return 'ZIP';
  if (type === 'image') return 'IMG';
  return '';
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
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [file?.id, accountId]);

  const iconSize = size === 'card' ? 36 : size === 'lg' ? 36 : 19;
  const containerClass =
    size === 'card'
      ? 'w-full h-[124px]'
      : size === 'lg'
      ? 'w-20 h-20 rounded-2xl'
      : 'w-9 h-9 rounded-xl';
  const tintClass = getFileTintClasses(type, isTg);
  const extLabel = getFileExtensionLabel(file, type);

  if (file?.type === 'image' && accountId && showThumbnails && !imgFailed) {
    const token = localStorage.getItem('cloudyte_token');
    const url = `/api/download/${accountId}/${file.id}?preview=1&token=${token}`;
    return (
      <div
        className={`${containerClass} shrink-0 overflow-hidden bg-[var(--hover)] relative flex items-center justify-center ${
          size === 'card' ? '' : 'border border-[var(--bd)]/70'
        }`}
      >
        <img
          src={url}
          alt={file.name}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
          loading="lazy"
          onError={() => setImgFailed(true)}
        />
      </div>
    );
  }

  if (size === 'card') {
    return (
      <div
        className={`${containerClass} ${tintClass} relative flex flex-col items-center justify-center shrink-0 transition-colors select-none overflow-hidden`}
      >
        {/* Subtle document sheet motif */}
        <div className="w-16 h-20 rounded-xl bg-[var(--sf)]/85 dark:bg-[var(--sf)]/65 border border-[var(--bd)]/70 shadow-xs flex flex-col items-center justify-center gap-1.5 relative">
          {type === 'video' ? (
            <span className="w-9 h-9 rounded-full bg-[#9333EA]/15 text-[#9333EA] dark:text-[#C084FC] flex items-center justify-center">
              <Play size={16} fill="currentColor" className="ml-0.5" />
            </span>
          ) : (
            renderFileTypeGlyph(type, 26, isTg)
          )}
          {extLabel && (
            <span className="text-[10px] font-mono font-semibold tracking-wider text-[var(--sub)]">
              {extLabel}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`${containerClass} ${tintClass} flex items-center justify-center shrink-0 transition-colors`}>
      {renderFileTypeGlyph(type, iconSize, isTg)}
    </div>
  );
}
