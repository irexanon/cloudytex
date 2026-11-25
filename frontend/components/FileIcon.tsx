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

function getFileExtensionLabel(file?: any, type?: string): string {
  const name = String(file?.name || '');
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < name.length - 1) {
    const ext = name.slice(dotIdx + 1).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (ext.length >= 1) return ext;
  }
  if (type === 'pdf') return 'PDF';
  if (type === 'sheet') return 'XLS';
  if (type === 'doc') return 'DOC';
  if (type === 'slide') return 'PPT';
  if (type === 'video') return 'MP4';
  if (type === 'audio') return 'MP3';
  if (type === 'zip') return 'ZIP';
  if (type === 'image') return 'IMG';
  return 'FILE';
}

function getBadgeStyleVars(extLabel: string, type: string): { bg: string; fg: string } {
  if (extLabel === 'PDF' || type === 'pdf') {
    return { bg: 'var(--cat-media-bg)', fg: 'var(--cat-media-fg)' };
  }
  if (extLabel === 'ZIP' || extLabel === 'RAR' || extLabel === '7Z' || extLabel === 'TAR' || extLabel === 'GZ' || type === 'zip') {
    return { bg: 'var(--cat-zip-bg)', fg: 'var(--cat-zip-fg)' };
  }
  if (
    extLabel === 'DOC' ||
    extLabel === 'DOCX' ||
    extLabel === 'TXT' ||
    extLabel === 'MD' ||
    extLabel === 'PPT' ||
    extLabel === 'PPTX' ||
    type === 'doc' ||
    type === 'slide'
  ) {
    return { bg: 'var(--cat-doc-bg)', fg: 'var(--cat-doc-fg)' };
  }
  return { bg: 'var(--cat-other-bg)', fg: 'var(--cat-other-fg)' };
}

function getRowIconColor(type: string, isTg = false): string {
  if (type === 'folder') return 'var(--folder-tint)';
  if (isTg && type === 'other') return 'var(--tt)';
  if (type === 'video' || type === 'pdf') return 'var(--cat-media-bg)';
  if (type === 'image') return 'var(--cat-img-bg)';
  if (type === 'audio' || type === 'sheet') return 'var(--cat-other-bg)';
  if (type === 'doc' || type === 'slide') return 'var(--cat-doc-bg)';
  if (type === 'zip') return 'var(--cat-zip-bg)';
  return 'var(--sub)';
}

export function getFileTintClasses(type: string, isTg = false): string {
  if (type === 'folder') return 'bg-[var(--hover)] text-[var(--folder-tint)]';
  if (isTg && type === 'other') return 'bg-[var(--hover)] text-[var(--tt)]';
  if (type === 'pdf' || type === 'video') return 'bg-[var(--hover)] text-[var(--cat-media-bg)]';
  if (type === 'image') return 'bg-[var(--hover)] text-[var(--cat-img-bg)]';
  if (type === 'audio' || type === 'sheet') return 'bg-[var(--hover)] text-[var(--cat-other-bg)]';
  if (type === 'doc' || type === 'slide') return 'bg-[var(--hover)] text-[var(--cat-doc-bg)]';
  if (type === 'zip') return 'bg-[var(--hover)] text-[var(--cat-zip-bg)]';
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
  size?: 'sm' | 'row' | 'lg' | 'card';
  isTg?: boolean;
  accountId?: string | null;
  showThumbnails?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [file?.id, accountId]);

  const extLabel = getFileExtensionLabel(file, type);
  const badgeVars = getBadgeStyleVars(extLabel, type);
  const iconColor = getRowIconColor(type, isTg);

  // Full-bleed Android FileGridItem / FolderGridItem top preview area
  if (size === 'card') {
    if (file?.type === 'image' && accountId && showThumbnails && !imgFailed) {
      const token = localStorage.getItem('cloudyte_token');
      const url = `/api/download/${accountId}/${file.id}?preview=1&token=${token}`;
      return (
        <div className="w-full h-full overflow-hidden bg-[var(--hover)]/50 relative flex items-center justify-center">
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

    if (type === 'folder') {
      return (
        <div className="w-full h-full flex items-center justify-center select-none" style={{ color: 'var(--folder-tint)' }}>
          <Folder size={52} fill="currentColor" strokeWidth={1.6} />
        </div>
      );
    }

    if (type === 'video') {
      return (
        <div className="w-full h-full bg-[var(--hover)]/55 relative flex items-center justify-center select-none">
          <span style={{ color: 'var(--cat-media-bg)' }}>
            <Video size={42} strokeWidth={1.7} />
          </span>
          <span className="absolute w-10 h-10 rounded-full bg-black/55 text-white flex items-center justify-center shadow-sm">
            <Play size={18} fill="currentColor" className="ml-0.5" />
          </span>
        </div>
      );
    }

    if (type === 'image') {
      return (
        <div className="w-full h-full bg-[var(--hover)]/45 flex items-center justify-center select-none" style={{ color: 'var(--cat-img-bg)' }}>
          <ImageIcon size={44} strokeWidth={1.7} />
        </div>
      );
    }

    // Android FileThumb non-media grid card: centered bold colored extension pill (PDF, ZIP, DOC, APK, TXT, etc.)
    return (
      <div className="w-full h-full flex items-center justify-center select-none">
        <span
          className="px-3.5 py-1.5 rounded-xl text-[13px] font-extrabold tracking-wide uppercase shadow-xs"
          style={{ backgroundColor: badgeVars.bg, color: badgeVars.fg }}
        >
          {extLabel}
        </span>
      </div>
    );
  }

  // Standard thumbnail / row / detail sizes (Android FileThumb rounded-xl box)
  const iconSize = size === 'lg' ? 38 : size === 'row' ? 22 : 20;
  const containerClass =
    size === 'lg'
      ? 'w-20 h-20 rounded-2xl'
      : size === 'row'
      ? 'w-11 h-11 rounded-xl'
      : 'w-9 h-9 rounded-xl';

  if (file?.type === 'image' && accountId && showThumbnails && !imgFailed) {
    const token = localStorage.getItem('cloudyte_token');
    const url = `/api/download/${accountId}/${file.id}?preview=1&token=${token}`;
    return (
      <div
        className={`${containerClass} shrink-0 overflow-hidden bg-[var(--hover)] relative flex items-center justify-center`}
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

  return (
    <div
      className={`${containerClass} bg-[var(--hover)]/80 flex items-center justify-center shrink-0 transition-colors`}
      style={{ color: iconColor }}
    >
      {renderFileTypeGlyph(type, iconSize, isTg)}
    </div>
  );
}
