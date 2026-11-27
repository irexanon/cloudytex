import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Check,
  Clock,
  Cloud,
  Copy,
  Download,
  File as FileIconLucide,
  FolderUp,
  HardDrive,
  Inbox,
  KeyRound,
  Link2,
  Lock,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Terminal,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { saveAs } from 'file-saver';
import FileIcon from './FileIcon';

export interface TempRoomSummary {
  roomCode: string;
  title: string;
  note: string;
  accessMode: 'both' | 'upload_only' | 'download_only';
  storageMode: 'temp_disk' | 'drive';
  targetAccountId: string | null;
  targetAccountName: string | null;
  targetAccountType: string | null;
  targetFolderId: string | null;
  targetFolderName: string | null;
  deleteOnExpire: boolean;
  hasPasscode: boolean;
  isOwner: boolean;
  hasAccountOwner: boolean;
  maxBytes: number;
  usedBytes: number;
  maxFileBytes: number;
  fileCount: number;
  downloadCount: number;
  expiresAt: string;
  createdAt: string;
  sharePath: string;
  shareUrl: string;
}

export interface TempDropFile {
  id: string;
  roomCode: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string | null;
  storageMode?: 'temp_disk' | 'drive';
  uploadedByLabel: string;
  downloadCount: number;
  expiresAt: string | null;
  createdAt: string;
  downloadPath: string;
}

interface DriveFolderOption {
  id: string;
  name: string;
}

interface UploadQueueEntry {
  id: string;
  name: string;
  size: number;
  percent: number;
  status: 'uploading' | 'completed' | 'failed';
  error?: string;
}

interface TempDropViewProps {
  isStandalone?: boolean;
  isAuthenticated: boolean;
  initialRoomCode: string | null;
  accounts?: any[];
  getAuthHeaders: () => Record<string, string>;
  onRoomCodeChange: (roomCode: string | null) => void;
  onShowToast: (message: string, type?: 'success' | 'error') => void;
  onNavigateLogin?: () => void;
  onNavigateFiles?: () => void;
  isDarkMode?: boolean;
  onToggleDarkMode?: () => void;
}

const CREATOR_TOKENS_STORAGE_KEY = 'cloudyte_temp_creator_tokens';

function readStoredCreatorTokens(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CREATOR_TOKENS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function storeCreatorToken(roomCode: string, token: string): void {
  if (!roomCode || !token) return;
  try {
    const map = readStoredCreatorTokens();
    map[roomCode] = token;
    localStorage.setItem(CREATOR_TOKENS_STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

function removeCreatorToken(roomCode: string): void {
  try {
    const map = readStoredCreatorTokens();
    delete map[roomCode];
    localStorage.setItem(CREATOR_TOKENS_STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatRemainingTime(expiresAtIso: string, nowMs: number): string {
  const diffMs = new Date(expiresAtIso).getTime() - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 'Expired';
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}m left`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours < 48) return `${hours}h ${mins}m left`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h left`;
}

function inferIconType(mimeType: string, name: string): string {
  const m = String(mimeType || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/.test(n)) return 'image';
  if (m.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/.test(n)) return 'video';
  if (m.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/.test(n)) return 'audio';
  if (m.includes('pdf') || n.endsWith('.pdf')) return 'pdf';
  if (m.includes('zip') || /\.(zip|rar|7z|tar|gz)$/.test(n)) return 'zip';
  if (m.startsWith('text/') || /\.(txt|md|json|csv|doc|docx)$/.test(n)) return 'doc';
  return 'other';
}

function accessModeLabel(mode: TempRoomSummary['accessMode']): string {
  if (mode === 'upload_only') return 'Upload only';
  if (mode === 'download_only') return 'Download only';
  return 'Upload & Download';
}

function providerShortLabel(accountType?: string | null): string {
  const t = String(accountType || '').toLowerCase();
  if (t === 'tgdrive') return 'TG Drive';
  if (t === 'onedrive') return 'OneDrive';
  return 'Google Drive';
}

function formatDriveOptionLabel(acc: any): string {
  const baseName = acc?.name || acc?.email || providerShortLabel(acc?.accountType);
  return `${baseName} (${providerShortLabel(acc?.accountType)})`;
}

export default function TempDropView({
  isStandalone = false,
  isAuthenticated,
  initialRoomCode,
  accounts = [],
  getAuthHeaders,
  onRoomCodeChange,
  onShowToast,
  onNavigateLogin,
  onNavigateFiles,
  isDarkMode,
  onToggleDarkMode,
}: TempDropViewProps) {
  const [fetchedAccounts, setFetchedAccounts] = useState<any[]>([]);
  const availableAccounts = useMemo(
    () => (accounts.length > 0 ? accounts : fetchedAccounts),
    [accounts, fetchedAccounts]
  );

  const [rooms, setRooms] = useState<TempRoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [activeRoomCode, setActiveRoomCode] = useState<string | null>(initialRoomCode);
  const [activeRoom, setActiveRoom] = useState<TempRoomSummary | null>(null);
  const [roomFiles, setRoomFiles] = useState<TempDropFile[]>([]);
  const [filesHidden, setFilesHidden] = useState(false);
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);

  const [passcodeRequired, setPasscodeRequired] = useState<{ roomCode: string; title: string; expiresAt: string } | null>(null);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [unlockedPasscodes, setUnlockedPasscodes] = useState<Record<string, string>>({});

  const [showCreateForm, setShowCreateForm] = useState(!initialRoomCode);
  const [newTitle, setNewTitle] = useState('');
  const [newNote, setNewNote] = useState('');
  const [newTtlHours, setNewTtlHours] = useState<number>(24);
  const [newAccessMode, setNewAccessMode] = useState<'both' | 'upload_only' | 'download_only'>('both');
  const [newPasscode, setNewPasscode] = useState('');
  const [newTargetAccountId, setNewTargetAccountId] = useState<string>('');
  const [newTargetFolderId, setNewTargetFolderId] = useState<string>('root');
  const [createFolders, setCreateFolders] = useState<DriveFolderOption[]>([]);
  const [createFoldersLoading, setCreateFoldersLoading] = useState(false);
  const [keepFilesOnExpire, setKeepFilesOnExpire] = useState(true);
  const [creatingRoom, setCreatingRoom] = useState(false);

  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [senderLabel, setSenderLabel] = useState('');
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueEntry[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showCliSnippet, setShowCliSnippet] = useState(false);
  const [confirmDeleteRoom, setConfirmDeleteRoom] = useState(false);
  const [saveTargetFile, setSaveTargetFile] = useState<TempDropFile | null>(null);
  const [saveTargetAccountId, setSaveTargetAccountId] = useState<string>('');
  const [saveTargetFolderId, setSaveTargetFolderId] = useState<string>('root');
  const [saveFolders, setSaveFolders] = useState<DriveFolderOption[]>([]);
  const [saveFoldersLoading, setSaveFoldersLoading] = useState(false);
  const [savingToDrive, setSavingToDrive] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setActiveRoomCode(initialRoomCode);
    if (initialRoomCode) setShowCreateForm(false);
  }, [initialRoomCode]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!isAuthenticated || accounts.length > 0) return;
    let cancelled = false;
    fetch('/api/accounts', { headers: getAuthHeaders() })
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setFetchedAccounts(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [accounts.length, getAuthHeaders, isAuthenticated]);

  useEffect(() => {
    if (!saveTargetAccountId && availableAccounts.length > 0) {
      setSaveTargetAccountId(availableAccounts[0].id);
    }
  }, [availableAccounts, saveTargetAccountId]);

  const loadDriveFolders = useCallback(
    async (
      accountId: string,
      setFolders: React.Dispatch<React.SetStateAction<DriveFolderOption[]>>,
      setLoadingFlag: React.Dispatch<React.SetStateAction<boolean>>
    ) => {
      if (!isAuthenticated || !accountId) {
        setFolders([]);
        return;
      }
      setLoadingFlag(true);
      try {
        const res = await fetch(`/api/files?accountId=${encodeURIComponent(accountId)}`, {
          headers: getAuthHeaders(),
        });
        if (!res.ok) {
          setFolders([]);
          return;
        }
        const items = await res.json();
        const folders: DriveFolderOption[] = (Array.isArray(items) ? items : [])
          .filter((it: any) => it?.type === 'folder' && it?.id)
          .map((it: any) => {
            const rawId = String(it.id);
            const normalizedId = rawId.startsWith('folder:') ? rawId.slice('folder:'.length) : rawId;
            return {
              id: normalizedId || rawId,
              name: String(it.name || normalizedId || 'Folder'),
            };
          });
        setFolders(folders);
      } catch {
        setFolders([]);
      } finally {
        setLoadingFlag(false);
      }
    },
    [getAuthHeaders, isAuthenticated]
  );

  useEffect(() => {
    setNewTargetFolderId('root');
    loadDriveFolders(newTargetAccountId, setCreateFolders, setCreateFoldersLoading);
  }, [loadDriveFolders, newTargetAccountId]);

  useEffect(() => {
    if (!saveTargetFile || !saveTargetAccountId) return;
    setSaveTargetFolderId('root');
    loadDriveFolders(saveTargetAccountId, setSaveFolders, setSaveFoldersLoading);
  }, [loadDriveFolders, saveTargetAccountId, saveTargetFile]);

  const buildTempHeaders = useCallback(
    (roomCode?: string | null, explicitPasscode?: string): Record<string, string> => {
      const headers: Record<string, string> = isAuthenticated ? { ...getAuthHeaders() } : {};
      if (roomCode) {
        const tokens = readStoredCreatorTokens();
        if (tokens[roomCode]) headers['X-Temp-Creator-Token'] = tokens[roomCode];
        const pass = explicitPasscode ?? unlockedPasscodes[roomCode];
        if (pass) headers['X-Temp-Passcode'] = pass;
      }
      return headers;
    },
    [getAuthHeaders, isAuthenticated, unlockedPasscodes]
  );

  const fetchMyRooms = useCallback(async () => {
    if (!isAuthenticated) return;
    setRoomsLoading(true);
    try {
      const res = await fetch('/api/temp-rooms', { headers: getAuthHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data?.rooms) ? (data.rooms as TempRoomSummary[]) : [];
      setRooms(list);
      if (!activeRoomCode && list.length > 0 && !initialRoomCode) {
        // Keep create panel accessible if user hasn't opened one yet
      }
    } catch { /* ignore */ } finally {
      setRoomsLoading(false);
    }
  }, [activeRoomCode, getAuthHeaders, initialRoomCode, isAuthenticated]);

  useEffect(() => {
    fetchMyRooms();
  }, [fetchMyRooms]);

  const fetchRoomDetail = useCallback(
    async (roomCode: string, explicitPasscode?: string) => {
      setRoomLoading(true);
      setRoomError(null);
      setPasscodeRequired(null);
      setConfirmDeleteRoom(false);
      try {
        const res = await fetch(`/api/temp-rooms/${encodeURIComponent(roomCode)}`, {
          headers: buildTempHeaders(roomCode, explicitPasscode),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 403 && data?.code === 'TEMP_PASSCODE_REQUIRED') {
          setActiveRoom(null);
          setRoomFiles([]);
          setPasscodeRequired(data.roomSummary || { roomCode, title: 'Locked Temp Room', expiresAt: '' });
          if (explicitPasscode) {
            onShowToast('Incorrect passcode', 'error');
          }
          return;
        }
        if (!res.ok) {
          setActiveRoom(null);
          setRoomFiles([]);
          setRoomError(data?.error || 'Temp room not found or expired');
          return;
        }
        if (explicitPasscode) {
          setUnlockedPasscodes((prev) => ({ ...prev, [roomCode]: explicitPasscode }));
        }
        setActiveRoom(data.room);
        setFilesHidden(Boolean(data.filesHidden));
        setRoomFiles(Array.isArray(data.files) ? data.files : []);
      } catch {
        setRoomError('Could not reach server');
      } finally {
        setRoomLoading(false);
      }
    },
    [buildTempHeaders, onShowToast]
  );

  useEffect(() => {
    if (activeRoomCode) {
      fetchRoomDetail(activeRoomCode);
    } else {
      setActiveRoom(null);
      setRoomFiles([]);
      setRoomError(null);
      setPasscodeRequired(null);
    }
  }, [activeRoomCode, fetchRoomDetail]);

  const openRoom = useCallback(
    (code: string | null) => {
      const cleaned = code ? code.trim() : null;
      setActiveRoomCode(cleaned);
      setShowCreateForm(!cleaned);
      onRoomCodeChange(cleaned);
    },
    [onRoomCodeChange]
  );

  const handleJoinByInput = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = joinCodeInput.trim();
    if (!raw) return;
    const match = raw.match(/\/drop\/([A-Za-z0-9_-]{6,32})/);
    const code = match ? match[1] : raw.replace(/[^A-Za-z0-9_-]/g, '');
    if (code.length < 6) {
      onShowToast('Enter a valid room code or /drop link', 'error');
      return;
    }
    setJoinCodeInput('');
    openRoom(code);
  };

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingRoom) return;
    setCreatingRoom(true);
    try {
      const chosenFolder = createFolders.find((f) => f.id === newTargetFolderId);
      const res = await fetch('/api/temp-rooms', {
        method: 'POST',
        headers: {
          ...(isAuthenticated ? getAuthHeaders() : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: newTitle.trim() || 'Temp Drop',
          note: newNote.trim(),
          ttlHours: newTtlHours,
          accessMode: newAccessMode,
          passcode: newPasscode.trim() || undefined,
          ...(newTargetAccountId
            ? {
                targetAccountId: newTargetAccountId,
                targetFolderId: newTargetFolderId || 'root',
                targetFolderName: newTargetFolderId !== 'root' ? (chosenFolder?.name || newTargetFolderId) : '',
                deleteOnExpire: !keepFilesOnExpire,
              }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not create temp room');
      const createdCode = String(data.room?.roomCode || '');
      if (createdCode && data.creatorToken) {
        storeCreatorToken(createdCode, String(data.creatorToken));
      }
      setNewTitle('');
      setNewNote('');
      setNewPasscode('');
      setShowCreateForm(false);
      onShowToast('Temp drop room created');
      if (isAuthenticated) fetchMyRooms();
      openRoom(createdCode);
    } catch (err: any) {
      onShowToast(err?.message || 'Failed to create temp room', 'error');
    } finally {
      setCreatingRoom(false);
    }
  };

  const handleCopyText = async (value: string, id: string, label = 'Copied link') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      onShowToast(label);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
    } catch {
      onShowToast('Could not copy to clipboard', 'error');
    }
  };

  const uploadSingleFile = useCallback(
    (file: File, roomCode: string): Promise<void> => {
      return new Promise((resolve) => {
        const entryId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setUploadQueue((prev) => [
          { id: entryId, name: file.name, size: file.size, percent: 0, status: 'uploading' },
          ...prev.slice(0, 14),
        ]);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/temp-rooms/${encodeURIComponent(roomCode)}/upload`, true);
        const headers = buildTempHeaders(roomCode);
        for (const key of Object.keys(headers)) {
          const val = headers[key];
          if (typeof val === 'string' && val) xhr.setRequestHeader(key, val);
        }

        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable && ev.total > 0) {
            const pct = Math.min(99, Math.round((ev.loaded / ev.total) * 100));
            setUploadQueue((prev) => prev.map((q) => (q.id === entryId ? { ...q, percent: pct } : q)));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadQueue((prev) =>
              prev.map((q) => (q.id === entryId ? { ...q, percent: 100, status: 'completed' } : q))
            );
            resolve();
          } else {
            let errMsg = `Upload failed (${xhr.status})`;
            try {
              const parsed = JSON.parse(xhr.responseText);
              if (parsed?.error) errMsg = parsed.error;
            } catch { /* ignore */ }
            setUploadQueue((prev) =>
              prev.map((q) => (q.id === entryId ? { ...q, status: 'failed', error: errMsg } : q))
            );
            onShowToast(errMsg, 'error');
            resolve();
          }
        };

        xhr.onerror = () => {
          setUploadQueue((prev) =>
            prev.map((q) => (q.id === entryId ? { ...q, status: 'failed', error: 'Network error' } : q))
          );
          onShowToast(`Upload failed for ${file.name}`, 'error');
          resolve();
        };

        const formData = new FormData();
        formData.append('file', file);
        if (senderLabel.trim()) {
          formData.append('uploadedByLabel', senderLabel.trim());
        }
        xhr.send(formData);
      });
    },
    [buildTempHeaders, onShowToast, senderLabel]
  );

  const handleFilesSelected = useCallback(
    async (fileList: FileList | File[]) => {
      if (!activeRoom) return;
      const items = Array.from(fileList);
      if (items.length === 0) return;
      for (const f of items) {
        await uploadSingleFile(f, activeRoom.roomCode);
      }
      await fetchRoomDetail(activeRoom.roomCode);
      if (isAuthenticated) fetchMyRooms();
    },
    [activeRoom, fetchMyRooms, fetchRoomDetail, isAuthenticated, uploadSingleFile]
  );

  const handleUpdateRoom = async (updates: Record<string, any>, message: string) => {
    if (!activeRoom) return;
    try {
      const res = await fetch(`/api/temp-rooms/${encodeURIComponent(activeRoom.roomCode)}`, {
        method: 'PATCH',
        headers: { ...buildTempHeaders(activeRoom.roomCode), 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Update failed');
      setActiveRoom(data.room);
      if (isAuthenticated) fetchMyRooms();
      onShowToast(message);
    } catch (err: any) {
      onShowToast(err?.message || 'Could not update temp room', 'error');
    }
  };

  const handleDeleteRoom = async () => {
    if (!activeRoom) return;
    const code = activeRoom.roomCode;
    try {
      const res = await fetch(`/api/temp-rooms/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: buildTempHeaders(code),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Delete failed');
      removeCreatorToken(code);
      onShowToast('Temp room deleted');
      if (isAuthenticated) fetchMyRooms();
      openRoom(null);
    } catch (err: any) {
      onShowToast(err?.message || 'Could not delete temp room', 'error');
    }
  };

  const handleDeleteTempFile = async (file: TempDropFile) => {
    if (!activeRoom) return;
    try {
      const res = await fetch(
        `/api/temp-rooms/${encodeURIComponent(activeRoom.roomCode)}/files/${encodeURIComponent(file.id)}`,
        { method: 'DELETE', headers: buildTempHeaders(activeRoom.roomCode) }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not delete file');
      onShowToast(`Removed "${file.name}"`);
      await fetchRoomDetail(activeRoom.roomCode);
      if (isAuthenticated) fetchMyRooms();
    } catch (err: any) {
      onShowToast(err?.message || 'Could not delete file', 'error');
    }
  };

  const handleDownloadTempFile = async (file: TempDropFile) => {
    if (!activeRoom) return;
    const needsCustomHeaders =
      Boolean(unlockedPasscodes[activeRoom.roomCode]) ||
      (activeRoom.accessMode === 'upload_only' && activeRoom.isOwner) ||
      Boolean(readStoredCreatorTokens()[activeRoom.roomCode]);

    if (!needsCustomHeaders) {
      const a = document.createElement('a');
      a.href = file.downloadPath;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => fetchRoomDetail(activeRoom.roomCode), 800);
      return;
    }

    try {
      const res = await fetch(file.downloadPath, { headers: buildTempHeaders(activeRoom.roomCode) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Download failed');
      }
      const blob = await res.blob();
      saveAs(blob, file.name);
      fetchRoomDetail(activeRoom.roomCode);
    } catch (err: any) {
      onShowToast(err?.message || 'Download failed', 'error');
    }
  };

  const handleDownloadAllZip = async () => {
    if (!activeRoom) return;
    const zipUrl = `/api/temp-rooms/${encodeURIComponent(activeRoom.roomCode)}/zip`;
    const needsCustomHeaders =
      Boolean(unlockedPasscodes[activeRoom.roomCode]) ||
      (activeRoom.accessMode === 'upload_only' && activeRoom.isOwner) ||
      Boolean(readStoredCreatorTokens()[activeRoom.roomCode]);

    if (!needsCustomHeaders) {
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = `${activeRoom.title || activeRoom.roomCode}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }

    try {
      const res = await fetch(zipUrl, { headers: buildTempHeaders(activeRoom.roomCode) });
      if (!res.ok) throw new Error('Archive download failed');
      const blob = await res.blob();
      saveAs(blob, `${activeRoom.title || activeRoom.roomCode}.zip`);
    } catch (err: any) {
      onShowToast(err?.message || 'Could not download ZIP archive', 'error');
    }
  };

  const handleSaveToDrive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!saveTargetFile || !activeRoom || !saveTargetAccountId || savingToDrive) return;
    setSavingToDrive(true);
    try {
      const res = await fetch(
        `/api/temp-rooms/${encodeURIComponent(activeRoom.roomCode)}/files/${encodeURIComponent(saveTargetFile.id)}/save-to-drive`,
        {
          method: 'POST',
          headers: { ...buildTempHeaders(activeRoom.roomCode), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetAccountId: saveTargetAccountId,
            targetFolderId: saveTargetFolderId || 'root',
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not save to cloud drive');
      onShowToast(`Saved "${saveTargetFile.name}" to your drive`);
      setSaveTargetFile(null);
    } catch (err: any) {
      onShowToast(err?.message || 'Save to drive failed', 'error');
    } finally {
      setSavingToDrive(false);
    }
  };

  const publicShareUrl = useMemo(() => {
    if (!activeRoom) return '';
    return `${window.location.origin}/drop/${activeRoom.roomCode}`;
  }, [activeRoom]);

  const canUpload = activeRoom ? activeRoom.accessMode !== 'download_only' || activeRoom.isOwner : false;
  const capacityPct = activeRoom && activeRoom.maxBytes > 0
    ? Math.min(100, Math.round((activeRoom.usedBytes / activeRoom.maxBytes) * 100))
    : 0;

  return (
    <div className={isStandalone ? `min-h-screen bg-[var(--bg)] text-[var(--tx)] flex flex-col ${isDarkMode ? 'dark' : ''}` : 'flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-5'}>
      {/* Standalone Top Bar (3-zone contract when visited without auth at /drop) */}
      {isStandalone && (
        <header className="h-14 shrink-0 border-b border-[var(--bd)] bg-[var(--rail)] px-4 md:px-8 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => openRoom(null)}
            className="flex items-center gap-2.5 text-base font-bold tracking-tight text-[var(--tx)] whitespace-nowrap shrink-0"
          >
            <span className="w-8 h-8 rounded-xl bg-[var(--primary)] text-[var(--on-primary)] flex items-center justify-center">
              <Cloud size={17} fill="currentColor" />
            </span>
            <span>Cloudyte</span>
          </button>

          <nav className="hidden sm:flex items-center gap-6 text-sm font-medium text-[var(--sub)]">
            <button
              type="button"
              onClick={() => {
                setShowCreateForm(true);
                openRoom(null);
              }}
              className="hover:text-[var(--tx)] transition-colors whitespace-nowrap shrink-0"
            >
              New Drop Room
            </button>
            {activeRoom && (
              <button
                type="button"
                onClick={() => fetchRoomDetail(activeRoom.roomCode)}
                className="hover:text-[var(--tx)] transition-colors whitespace-nowrap shrink-0"
              >
                Refresh Room
              </button>
            )}
          </nav>

          <div className="flex items-center gap-2.5 shrink-0">
            {onToggleDarkMode && (
              <button
                type="button"
                onClick={onToggleDarkMode}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--bd)] bg-[var(--sf)] text-[var(--sub)] hover:text-[var(--tx)] transition-colors whitespace-nowrap shrink-0"
              >
                {isDarkMode ? 'Light' : 'Dark'}
              </button>
            )}
            {onNavigateLogin && (
              <button
                type="button"
                onClick={onNavigateLogin}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] transition-colors whitespace-nowrap shrink-0"
              >
                Sign in
              </button>
            )}
          </div>
        </header>
      )}

      <div className={isStandalone ? 'w-full max-w-[1160px] mx-auto px-4 md:px-8 py-6 flex-1' : 'max-w-[1200px] mx-auto pb-16'}>
        {/* Top Action Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-[var(--bd)]">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight text-[var(--tx)]">
              Temp Drop Area
            </h1>
            <p className="text-sm text-[var(--sub)] mt-1">
              Share temporary upload &amp; download rooms by link — no account or sign-in required for anyone.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <form onSubmit={handleJoinByInput} className="flex items-center gap-1.5">
              <input
                type="text"
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value)}
                placeholder="Paste /drop link or code"
                className="h-9 w-44 sm:w-52 px-3 rounded-lg bg-[var(--sf)] border border-[var(--bd)] focus:border-[var(--primary)] outline-none text-xs font-medium text-[var(--tx)] placeholder:text-[var(--sub)]/70"
              />
              <button
                type="submit"
                className="h-9 px-3 rounded-lg border border-[var(--bd)] bg-[var(--sf)] hover:bg-[var(--hover)] text-xs font-semibold text-[var(--tx)] transition-colors whitespace-nowrap shrink-0"
              >
                Open
              </button>
            </form>

            <button
              type="button"
              onClick={() => {
                setShowCreateForm((prev) => !prev);
              }}
              className="h-9 px-4 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus size={15} />
              <span>Create Temp Room</span>
            </button>
          </div>
        </div>

        {/* Create Temp Room Form */}
        {showCreateForm && (
          <form
            onSubmit={handleCreateRoom}
            className="mt-5 bg-[var(--sf)] border border-[var(--bd)] rounded-2xl p-5 space-y-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[var(--tx)]">Create Temporary Room</h2>
                <p className="text-xs text-[var(--sub)] mt-0.5">
                  Anyone with the generated link can upload and download until the room expires.
                </p>
              </div>
              {activeRoom && (
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="p-1.5 rounded-lg text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--hover)]"
                  title="Close"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-[var(--sub)] mb-1.5">Room name</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Quick Drop, Client Files"
                  maxLength={80}
                  className="w-full h-10 px-3 rounded-lg bg-[var(--bg)] border border-[var(--bd)] focus:border-[var(--primary)] outline-none text-sm text-[var(--tx)]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--sub)] mb-1.5">Auto-expire after</label>
                <select
                  value={newTtlHours}
                  onChange={(e) => setNewTtlHours(Number(e.target.value))}
                  className="w-full h-10 px-3 rounded-lg bg-[var(--bg)] border border-[var(--bd)] focus:border-[var(--primary)] outline-none text-sm text-[var(--tx)]"
                >
                  <option value={1}>1 hour</option>
                  <option value={6}>6 hours</option>
                  <option value={24}>24 hours (Default)</option>
                  <option value={72}>3 days</option>
                  <option value={168}>7 days</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--sub)] mb-1.5">Optional passcode</label>
                <input
                  type="password"
                  value={newPasscode}
                  onChange={(e) => setNewPasscode(e.target.value)}
                  placeholder="Leave blank for no auth"
                  maxLength={64}
                  className="w-full h-10 px-3 rounded-lg bg-[var(--bg)] border border-[var(--bd)] focus:border-[var(--primary)] outline-none text-sm text-[var(--tx)]"
                />
              </div>
            </div>

            {/* Storage / Drive Selection */}
            <div className="p-4 rounded-xl bg-[var(--bg)] border border-[var(--bd)] space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                <div>
                  <label className="block text-xs font-medium text-[var(--sub)] mb-1.5">
                    Storage destination (Drive)
                  </label>
                  {isAuthenticated ? (
                    <select
                      value={newTargetAccountId}
                      onChange={(e) => setNewTargetAccountId(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg bg-[var(--sf)] border border-[var(--bd)] focus:border-[var(--primary)] outline-none text-sm text-[var(--tx)]"
                    >
                      <option value="">Server Temp Storage (1 GB · Auto-deletes)</option>
                      {availableAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {formatDriveOptionLabel(acc)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="h-10 px-3 rounded-lg bg-[var(--sf)] border border-[var(--bd)] flex items-center justify-between gap-2 text-xs text-[var(--sub)]">
                      <span className="truncate">Server Temp Storage (No sign-in required)</span>
                      {onNavigateLogin && (
                        <button
                          type="button"
                          onClick={onNavigateLogin}
                          className="text-[var(--primary)] font-semibold hover:underline shrink-0"
                        >
                          Sign in to pick Drive
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {isAuthenticated && newTargetAccountId && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--sub)] mb-1.5">
                      Destination folder in Drive
                    </label>
                    <select
                      value={newTargetFolderId}
                      onChange={(e) => setNewTargetFolderId(e.target.value)}
                      disabled={createFoldersLoading}
                      className="w-full h-10 px-3 rounded-lg bg-[var(--sf)] border border-[var(--bd)] focus:border-[var(--primary)] outline-none text-sm text-[var(--tx)] disabled:opacity-60"
                    >
                      <option value="root">{createFoldersLoading ? 'Loading folders...' : 'Root (Top level)'}</option>
                      {createFolders.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {isAuthenticated && newTargetAccountId && (
                <label className="inline-flex items-center gap-2 text-xs text-[var(--sub)] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={keepFilesOnExpire}
                    onChange={(e) => setKeepFilesOnExpire(e.target.checked)}
                    className="rounded border-[var(--bd)] accent-[var(--primary)]"
                  />
                  <span>Keep uploaded files in this Drive after the temporary share link expires</span>
                </label>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
              <div>
                <label className="block text-xs font-medium text-[var(--sub)] mb-1.5">Visitor permissions</label>
                <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[var(--bg)] border border-[var(--bd)]">
                  {([
                    { id: 'both', label: 'Upload & Download' },
                    { id: 'upload_only', label: 'Upload Only' },
                    { id: 'download_only', label: 'Download Only' },
                  ] as const).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setNewAccessMode(opt.id)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        newAccessMode === opt.id
                          ? 'bg-[var(--sf)] text-[var(--tx)] shadow-xs border border-[var(--bd)]'
                          : 'text-[var(--sub)] hover:text-[var(--tx)]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--sub)] mb-1.5">Note for visitors (optional)</label>
                <input
                  type="text"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Optional instructions or description"
                  maxLength={400}
                  className="w-full h-10 px-3 rounded-lg bg-[var(--bg)] border border-[var(--bd)] focus:border-[var(--primary)] outline-none text-sm text-[var(--tx)]"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="submit"
                disabled={creatingRoom}
                className="h-9 px-5 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-semibold flex items-center gap-2 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {creatingRoom ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                <span>Create &amp; Get Share Link</span>
              </button>
            </div>
          </form>
        )}

        {/* Workspace Layout: Optional My Rooms Rail (when logged in) + Active Room Canvas */}
        <div className={`mt-5 grid gap-5 ${isAuthenticated && !isStandalone ? 'grid-cols-1 lg:grid-cols-[290px_1fr]' : 'grid-cols-1'}`}>
          {isAuthenticated && !isStandalone && (
            <aside className="bg-[var(--sf)] border border-[var(--bd)] rounded-2xl p-4 h-fit lg:max-h-[calc(100dvh-13rem)] flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <h2 className="text-sm font-semibold text-[var(--tx)]">Your Temp Rooms</h2>
                <button
                  type="button"
                  onClick={fetchMyRooms}
                  className="p-1.5 rounded-lg text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--hover)]"
                  title="Refresh rooms"
                >
                  <RefreshCw size={14} className={roomsLoading ? 'animate-spin' : ''} />
                </button>
              </div>

              {roomsLoading && rooms.length === 0 ? (
                <div className="space-y-2 py-2">
                  {[1, 2, 3].map((k) => (
                    <div key={k} className="h-14 rounded-xl bg-[var(--hover)]/60 animate-pulse" />
                  ))}
                </div>
              ) : rooms.length === 0 ? (
                <div className="py-6 text-center text-xs text-[var(--sub)] space-y-2">
                  <Inbox size={24} className="mx-auto opacity-60" />
                  <p>No active temp rooms yet.</p>
                </div>
              ) : (
                <div className="divide-y divide-[var(--bd)] overflow-y-auto min-h-0 overscroll-contain max-h-[340px] lg:max-h-none pr-0.5">
                  {rooms.map((r) => {
                    const isSelected = activeRoomCode === r.roomCode;
                    return (
                      <button
                        key={r.roomCode}
                        type="button"
                        onClick={() => openRoom(r.roomCode)}
                        className={`w-full text-left py-2.5 px-2.5 first:pt-2 rounded-lg transition-colors ${
                          isSelected ? 'bg-[var(--sel)] text-[var(--tx)]' : 'hover:bg-[var(--hover)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold truncate text-[var(--tx)]">{r.title}</span>
                          {r.hasPasscode && <Lock size={12} className="text-[var(--sub)] shrink-0" />}
                        </div>
                        <div className="text-[11px] text-[var(--sub)] mt-0.5 tabular-nums flex items-center gap-1.5 truncate">
                          <span>{r.storageMode === 'drive' && r.targetAccountName ? r.targetAccountName : 'Temp Disk'}</span>
                          <span aria-hidden="true">·</span>
                          <span>{r.fileCount} files</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatRemainingTime(r.expiresAt, nowMs)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </aside>
          )}

          {/* Active Room Main Area */}
          <section className="min-w-0">
            {roomLoading && !activeRoom && (
              <div className="bg-[var(--sf)] border border-[var(--bd)] rounded-2xl p-8 flex items-center justify-center gap-3 text-sm text-[var(--sub)]">
                <RefreshCw size={18} className="animate-spin" />
                <span>Loading temp room...</span>
              </div>
            )}

            {passcodeRequired && (
              <div className="bg-[var(--sf)] border border-[var(--bd)] rounded-2xl p-8 max-w-md mx-auto text-center space-y-4">
                <div className="w-11 h-11 rounded-xl bg-[var(--hover)] text-[var(--tx)] flex items-center justify-center mx-auto">
                  <KeyRound size={20} />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[var(--tx)]">{passcodeRequired.title}</h2>
                  <p className="text-xs text-[var(--sub)] mt-1">
                    This temp room is protected by an optional creator passcode.
                  </p>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!passcodeInput.trim()) return;
                    fetchRoomDetail(passcodeRequired.roomCode, passcodeInput.trim());
                  }}
                  className="flex items-center gap-2"
                >
                  <input
                    type="password"
                    value={passcodeInput}
                    onChange={(e) => setPasscodeInput(e.target.value)}
                    placeholder="Enter passcode"
                    autoFocus
                    className="flex-1 h-10 px-3 rounded-lg bg-[var(--bg)] border border-[var(--bd)] focus:border-[var(--primary)] outline-none text-sm text-[var(--tx)]"
                  />
                  <button
                    type="submit"
                    className="h-10 px-4 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-semibold whitespace-nowrap shrink-0"
                  >
                    Unlock
                  </button>
                </form>
              </div>
            )}

            {roomError && !passcodeRequired && (
              <div className="bg-[var(--sf)] border border-[var(--bd)] rounded-2xl p-8 text-center space-y-3">
                <p className="text-base font-semibold text-[var(--tx)]">{roomError}</p>
                <p className="text-xs text-[var(--sub)]">
                  Temp rooms are automatically deleted after expiry or when closed by the creator.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateForm(true);
                    openRoom(null);
                  }}
                  className="h-9 px-4 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Plus size={14} />
                  <span>Create a new Temp Room</span>
                </button>
              </div>
            )}

            {!activeRoomCode && !roomLoading && !roomError && !passcodeRequired && !showCreateForm && (
              <div className="bg-[var(--sf)] border border-[var(--bd)] rounded-2xl p-8 text-center space-y-3">
                <UploadCloud size={28} className="mx-auto text-[var(--primary)]" />
                <h2 className="text-base font-semibold text-[var(--tx)]">Select a room or create a Temp Drop</h2>
                <p className="text-xs text-[var(--sub)] max-w-md mx-auto">
                  Share a temporary `/drop` link with anyone so they can download files or upload files directly without signing in.
                </p>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(true)}
                  className="h-9 px-4 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Plus size={14} />
                  <span>Create Temp Room</span>
                </button>
              </div>
            )}

            {activeRoom && (
              <div className="space-y-5">
                {/* Room Header & Share Bar */}
                <div className="bg-[var(--sf)] border border-[var(--bd)] rounded-2xl p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="text-lg font-bold text-[var(--tx)] truncate">{activeRoom.title}</h2>
                        {activeRoom.hasPasscode && <Lock size={14} className="text-[var(--sub)] shrink-0" />}
                      </div>
                      {activeRoom.note && (
                        <p className="text-sm text-[var(--sub)] mt-1 break-words">{activeRoom.note}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--sub)] mt-2 tabular-nums">
                        <span className="inline-flex items-center gap-1 text-[var(--tx)] font-medium">
                          <HardDrive size={12} />
                          {activeRoom.storageMode === 'drive' && activeRoom.targetAccountName
                            ? `Drive: ${activeRoom.targetAccountName}${activeRoom.targetFolderName ? ` / ${activeRoom.targetFolderName}` : ''}`
                            : 'Server Temp Storage'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{accessModeLabel(activeRoom.accessMode)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{activeRoom.fileCount} files</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {formatBytes(activeRoom.usedBytes)} / {formatBytes(activeRoom.maxBytes)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock size={12} />
                          {formatRemainingTime(activeRoom.expiresAt, nowMs)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{activeRoom.downloadCount} downloads</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {roomFiles.length > 0 && (activeRoom.accessMode !== 'upload_only' || activeRoom.isOwner) && (
                        <button
                          type="button"
                          onClick={handleDownloadAllZip}
                          className="h-9 px-3 rounded-lg border border-[var(--bd)] bg-[var(--bg)] hover:bg-[var(--hover)] text-xs font-semibold text-[var(--tx)] flex items-center gap-1.5 whitespace-nowrap shrink-0"
                        >
                          <Archive size={14} />
                          <span>Download ZIP</span>
                        </button>
                      )}

                      {activeRoom.isOwner && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleUpdateRoom({ ttlHours: 24 }, 'Extended expiry to 24 hours from now')}
                            className="h-9 px-3 rounded-lg border border-[var(--bd)] bg-[var(--bg)] hover:bg-[var(--hover)] text-xs font-medium text-[var(--tx)] whitespace-nowrap shrink-0"
                          >
                            +24h Expiry
                          </button>

                          {!confirmDeleteRoom ? (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteRoom(true)}
                              className="h-9 px-3 rounded-lg border border-[var(--bd)] bg-[var(--bg)] hover:bg-rose-500/10 text-xs font-medium text-rose-600 dark:text-rose-400 flex items-center gap-1.5 whitespace-nowrap shrink-0"
                            >
                              <Trash2 size={14} />
                              <span>Delete Room</span>
                            </button>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={handleDeleteRoom}
                                className="h-9 px-3 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                              >
                                Confirm Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteRoom(false)}
                                className="h-9 px-2.5 rounded-lg border border-[var(--bd)] text-xs text-[var(--sub)] whitespace-nowrap shrink-0"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Capacity hairline progress */}
                  <div className="w-full h-1.5 rounded-full bg-[var(--bg)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--primary)] transition-all duration-300"
                      style={{ width: `${capacityPct}%` }}
                    />
                  </div>

                  {/* Public No-Auth Share Link Bar + Owner Mode Switcher */}
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-1">
                    <div className="flex-1 flex items-center gap-2 min-w-0 bg-[var(--bg)] border border-[var(--bd)] rounded-xl px-3 py-2">
                      <Link2 size={15} className="text-[var(--sub)] shrink-0" />
                      <input
                        type="text"
                        readOnly
                        value={publicShareUrl}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 min-w-0 bg-transparent text-xs font-mono text-[var(--tx)] outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleCopyText(publicShareUrl, `room_${activeRoom.roomCode}`, 'Share link copied — anyone can open without login')}
                        className="h-7 px-3 rounded-md bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        {copiedId === `room_${activeRoom.roomCode}` ? <Check size={13} /> : <Copy size={13} />}
                        <span>{copiedId === `room_${activeRoom.roomCode}` ? 'Copied' : 'Copy Link'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowCliSnippet((prev) => !prev)}
                        className="h-7 px-2.5 rounded-md border border-[var(--bd)] bg-[var(--sf)] hover:bg-[var(--hover)] text-[var(--tx)] text-xs font-medium flex items-center gap-1 whitespace-nowrap shrink-0"
                        title="Terminal / curl upload & download commands"
                      >
                        <Terminal size={12} />
                        <span>CLI</span>
                      </button>
                    </div>

                    {activeRoom.isOwner && (
                      <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[var(--bg)] border border-[var(--bd)] shrink-0">
                        {([
                          { id: 'both', label: 'Both' },
                          { id: 'upload_only', label: 'Upload Only' },
                          { id: 'download_only', label: 'Read Only' },
                        ] as const).map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => handleUpdateRoom({ accessMode: opt.id }, `Access mode set to ${opt.label}`)}
                            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                              activeRoom.accessMode === opt.id
                                ? 'bg-[var(--sf)] text-[var(--tx)] shadow-xs border border-[var(--bd)]'
                                : 'text-[var(--sub)] hover:text-[var(--tx)]'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {showCliSnippet && (
                    <div className="p-3 rounded-xl bg-[var(--bg)] border border-[var(--bd)] space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-[var(--tx)]">Terminal upload / download (no login required)</span>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              handleCopyText(
                                [
                                  `You can upload and download files in this public Cloudyte Temp Drop room (no login required).`,
                                  ``,
                                  `Room URL: ${publicShareUrl}`,
                                  `Room Code: ${activeRoom.roomCode}`,
                                  ``,
                                  `Option 1 — Using Cloudyte CLI:`,
                                  `curl -fsSL "${window.location.origin}/api/cli/download" -o cloudyte.mjs`,
                                  `export CLOUDYTE_URL="${window.location.origin}"`,
                                  `node cloudyte.mjs temp ls ${activeRoom.roomCode}`,
                                  `node cloudyte.mjs temp upload ${activeRoom.roomCode} ./yourfile.zip`,
                                  `node cloudyte.mjs temp download ${activeRoom.roomCode} all`,
                                  ``,
                                  `Option 2 — Using curl directly:`,
                                  `curl -F "file=@./yourfile.zip" "${window.location.origin}/api/temp-rooms/${activeRoom.roomCode}/upload"`,
                                  `curl -L -o "${activeRoom.roomCode}.zip" "${window.location.origin}/api/temp-rooms/${activeRoom.roomCode}/zip"`,
                                ].join('\n'),
                                `cli_ai_${activeRoom.roomCode}`,
                                'CLI AI prompt copied'
                              )
                            }
                            className="text-[var(--primary)] font-semibold hover:underline inline-flex items-center gap-1"
                          >
                            {copiedId === `cli_ai_${activeRoom.roomCode}` ? <Check size={12} /> : <Copy size={12} />}
                            <span>Copy AI Prompt</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleCopyText(
                                [
                                  `curl -F "file=@./yourfile.zip" "${window.location.origin}/api/temp-rooms/${activeRoom.roomCode}/upload"`,
                                  `curl -L -o "${activeRoom.roomCode}.zip" "${window.location.origin}/api/temp-rooms/${activeRoom.roomCode}/zip"`,
                                ].join('\n'),
                                `cli_${activeRoom.roomCode}`,
                                'CLI commands copied'
                              )
                            }
                            className="text-[var(--primary)] font-semibold hover:underline inline-flex items-center gap-1"
                          >
                            {copiedId === `cli_${activeRoom.roomCode}` ? <Check size={12} /> : <Copy size={12} />}
                            <span>Copy Commands</span>
                          </button>
                        </div>
                      </div>
                      <pre className="font-mono text-[11px] text-[var(--tx)] overflow-x-auto leading-relaxed">{`# Upload from terminal:
curl -F "file=@./yourfile.zip" "${window.location.origin}/api/temp-rooms/${activeRoom.roomCode}/upload"

# Download all as ZIP:
curl -L -o "${activeRoom.roomCode}.zip" "${window.location.origin}/api/temp-rooms/${activeRoom.roomCode}/zip"`}</pre>
                    </div>
                  )}
                </div>

                {/* Upload Dropzone */}
                {canUpload && (
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDraggingOver(true);
                    }}
                    onDragLeave={() => setIsDraggingOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDraggingOver(false);
                      if (e.dataTransfer.files?.length) {
                        handleFilesSelected(e.dataTransfer.files);
                      }
                    }}
                    className={`bg-[var(--sf)] border border-dashed rounded-2xl p-6 transition-colors ${
                      isDraggingOver ? 'border-[var(--primary)] bg-[var(--sel)]/40' : 'border-[var(--bd)]'
                    }`}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.length) {
                          handleFilesSelected(e.target.files);
                          e.target.value = '';
                        }
                      }}
                    />

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-center gap-3.5">
                        <div className="w-11 h-11 rounded-xl bg-[var(--hover)] text-[var(--primary)] flex items-center justify-center shrink-0">
                          <UploadCloud size={22} />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-[var(--tx)]">
                            Drop files here or browse to upload
                          </p>
                          <p className="text-xs text-[var(--sub)] mt-0.5 tabular-nums">
                            {activeRoom.storageMode === 'drive' && activeRoom.targetAccountName
                              ? `No login required · Saves directly to ${activeRoom.targetAccountName} · Max ${formatBytes(activeRoom.maxFileBytes)} per file`
                              : `No login required · Max ${formatBytes(activeRoom.maxFileBytes)} per file · Auto-deletes after expiry`}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <input
                          type="text"
                          value={senderLabel}
                          onChange={(e) => setSenderLabel(e.target.value)}
                          placeholder="Your name (optional)"
                          maxLength={40}
                          className="h-9 w-36 px-3 rounded-lg bg-[var(--bg)] border border-[var(--bd)] focus:border-[var(--primary)] outline-none text-xs text-[var(--tx)]"
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="h-9 px-4 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
                        >
                          <FolderUp size={14} />
                          <span>Select Files</span>
                        </button>
                      </div>
                    </div>

                    {uploadQueue.length > 0 && (
                      <div className="mt-4 pt-3 border-t border-[var(--bd)] space-y-2">
                        {uploadQueue.map((item) => (
                          <div key={item.id} className="flex items-center justify-between gap-3 text-xs">
                            <span className="truncate font-medium text-[var(--tx)] flex-1">{item.name}</span>
                            <span className="text-[var(--sub)] font-mono tabular-nums shrink-0">{formatBytes(item.size)}</span>
                            <div className="w-28 h-1.5 rounded-full bg-[var(--bg)] overflow-hidden shrink-0">
                              <div
                                className={`h-full transition-all ${
                                  item.status === 'failed'
                                    ? 'bg-rose-500'
                                    : item.status === 'completed'
                                    ? 'bg-emerald-500'
                                    : 'bg-[var(--primary)]'
                                }`}
                                style={{ width: `${item.percent}%` }}
                              />
                            </div>
                            <span className="w-16 text-right font-mono tabular-nums shrink-0 text-[var(--sub)]">
                              {item.status === 'failed' ? 'Failed' : `${item.percent}%`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Files Table */}
                <div className="bg-[var(--sf)] border border-[var(--bd)] rounded-2xl overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-[var(--bd)] flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[var(--tx)]">
                      Shared Files ({roomFiles.length})
                    </h3>
                    <button
                      type="button"
                      onClick={() => fetchRoomDetail(activeRoom.roomCode)}
                      className="text-xs font-medium text-[var(--sub)] hover:text-[var(--tx)] flex items-center gap-1.5"
                    >
                      <RefreshCw size={13} className={roomLoading ? 'animate-spin' : ''} />
                      <span>Refresh</span>
                    </button>
                  </div>

                  {filesHidden ? (
                    <div className="p-8 text-center text-xs text-[var(--sub)] space-y-1.5">
                      <ShieldCheck size={22} className="mx-auto text-[var(--sub)]" />
                      <p className="font-medium text-[var(--tx)]">Upload-only dropbox mode</p>
                      <p>Existing files uploaded to this room are hidden from other visitors. Only the room creator can view and download them.</p>
                    </div>
                  ) : roomFiles.length === 0 ? (
                    <div className="p-10 text-center space-y-2">
                      <FileIconLucide size={24} className="mx-auto text-[var(--sub)] opacity-60" />
                      <p className="text-sm font-medium text-[var(--tx)]">No files in this temp room yet</p>
                      <p className="text-xs text-[var(--sub)]">
                        {canUpload
                          ? 'Upload files above or share the link so others can drop files here.'
                          : 'Waiting for the room creator to upload files.'}
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-[var(--bd)] text-[11px] font-semibold text-[var(--sub)]">
                            <th className="py-2.5 px-5">File</th>
                            <th className="py-2.5 px-3">Sender</th>
                            <th className="py-2.5 px-3 text-right">Size</th>
                            <th className="py-2.5 px-3 text-right">Downloads</th>
                            <th className="py-2.5 px-5 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--bd)] text-xs">
                          {roomFiles.map((file) => {
                            const directUrl = `${window.location.origin}${file.downloadPath}`;
                            return (
                              <tr key={file.id} className="hover:bg-[var(--hover)]/50 transition-colors">
                                <td className="py-2.5 px-5">
                                  <div className="flex items-center gap-2.5 min-w-0 max-w-[340px]">
                                    <FileIcon type={inferIconType(file.mimeType, file.name)} size="row" />
                                    <span className="font-medium text-[var(--tx)] truncate" title={file.name}>
                                      {file.name}
                                    </span>
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 text-[var(--sub)] whitespace-nowrap">
                                  {file.uploadedByLabel}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[var(--tx)] whitespace-nowrap">
                                  {formatBytes(file.size)}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[var(--sub)] whitespace-nowrap">
                                  {file.downloadCount}
                                </td>
                                <td className="py-2.5 px-5 text-right whitespace-nowrap">
                                  <div className="inline-flex items-center justify-end gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => handleDownloadTempFile(file)}
                                      className="h-7 px-2.5 rounded-md bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                                      title="Download file"
                                    >
                                      <Download size={12} />
                                      <span>Download</span>
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => handleCopyText(directUrl, `dl_${file.id}`, 'Direct download link copied')}
                                      className="h-7 px-2 rounded-md border border-[var(--bd)] bg-[var(--bg)] hover:bg-[var(--hover)] text-[var(--tx)] inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                                      title="Copy direct download link"
                                    >
                                      {copiedId === `dl_${file.id}` ? <Check size={12} /> : <Copy size={12} />}
                                    </button>

                                    {isAuthenticated && availableAccounts.length > 0 && (
                                      <button
                                        type="button"
                                        onClick={() => setSaveTargetFile(file)}
                                        className="h-7 px-2.5 rounded-md border border-[var(--bd)] bg-[var(--bg)] hover:bg-[var(--hover)] text-[var(--tx)] font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                                        title="Save to one of your connected Cloudyte drives"
                                      >
                                        <Send size={12} />
                                        <span className="hidden sm:inline">Save to Drive</span>
                                      </button>
                                    )}

                                    {activeRoom.isOwner && (
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteTempFile(file)}
                                        className="h-7 px-2 rounded-md border border-[var(--bd)] bg-[var(--bg)] hover:bg-rose-500/10 text-rose-600 dark:text-rose-400 inline-flex items-center whitespace-nowrap shrink-0"
                                        title="Remove file"
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Save-to-Drive Inline Modal (authenticated users) */}
      {saveTargetFile && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/60 backdrop-blur-[2px] p-4">
          <form
            onSubmit={handleSaveToDrive}
            className="w-full max-w-md bg-[var(--sf)] border border-[var(--bd)] rounded-2xl p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-[var(--tx)]">Save Temp File to Cloud Drive</h3>
              <button
                type="button"
                onClick={() => setSaveTargetFile(null)}
                className="p-1 rounded-lg text-[var(--sub)] hover:text-[var(--tx)]"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-[var(--sub)] truncate">
              File: <span className="font-semibold text-[var(--tx)]">{saveTargetFile.name}</span> ({formatBytes(saveTargetFile.size)})
            </p>
            <div>
              <label className="block text-xs font-medium text-[var(--sub)] mb-1.5">Destination drive</label>
              <select
                value={saveTargetAccountId}
                onChange={(e) => setSaveTargetAccountId(e.target.value)}
                className="w-full h-10 px-3 rounded-lg bg-[var(--bg)] border border-[var(--bd)] text-sm text-[var(--tx)] outline-none"
              >
                {availableAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {formatDriveOptionLabel(acc)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--sub)] mb-1.5">Destination folder</label>
              <select
                value={saveTargetFolderId}
                onChange={(e) => setSaveTargetFolderId(e.target.value)}
                disabled={saveFoldersLoading}
                className="w-full h-10 px-3 rounded-lg bg-[var(--bg)] border border-[var(--bd)] text-sm text-[var(--tx)] outline-none disabled:opacity-60"
              >
                <option value="root">{saveFoldersLoading ? 'Loading folders...' : 'Root (Top level)'}</option>
                {saveFolders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSaveTargetFile(null)}
                className="h-9 px-4 rounded-lg border border-[var(--bd)] text-xs font-semibold text-[var(--tx)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingToDrive || !saveTargetAccountId}
                className="h-9 px-4 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
              >
                {savingToDrive ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
                <span>Save to Drive</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
