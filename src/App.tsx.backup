import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Plus, Search, Trash2, Edit3, Download, Folder, File as FileIconLucide, ChevronRight, ChevronLeft, 
  LogOut, Cloud, HardDrive, Menu, X, RefreshCw, Check, LayoutGrid, 
  List as ListIcon, Info, Moon, Sun, Eye, Settings, MoreVertical, 
  Share2, Video, Send, ArrowLeft, ExternalLink, Archive, FileArchive, Maximize, Copy
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

import ConfirmModal from "./components/modals/ConfirmModal";
import PromptModal from "./components/modals/PromptModal";
import DetailRow from "./components/DetailRow";
import FileIcon from "./components/FileIcon";
import TelegramIcon from "./components/Icons/TelegramIcon";

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => !!localStorage.getItem('cloudyte_token'));
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('cloudyte_theme');
    return saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  });
  const [authToken, setAuthToken]   = useState<string | null>(() => localStorage.getItem('cloudyte_token'));
  const [tokenType, setTokenType]   = useState<string>(() => localStorage.getItem('cloudyte_token_type') || 'Bearer');
  const [username, setUsername]     = useState<string | null>(() => {
    const saved = localStorage.getItem('cloudyte_username');
    if (saved === 'undefined' || saved === 'null' || !saved) return null;
    return saved;
  });
  const [isAdmin, setIsAdmin]       = useState<boolean>(() => localStorage.getItem('cloudyte_isAdmin') === 'true');
  const [loginError, setLoginError]       = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [userProfile, setUserProfile]     = useState<any>(null);
  const [loading, setLoading]             = useState(false);
  const [accounts, setAccounts]           = useState<any[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [files, setFiles]                 = useState<any[]>([]);
  const [selectedFile, setSelectedFile]   = useState<any | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [path, setPath]                   = useState<{ id: string | null; name: string }[]>([{ id: null, name: 'My Drive' }]);
  const [searchQuery, setSearchQuery]     = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [viewMode, setViewMode]           = useState<'list' | 'grid'>('grid');
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth >= 1024);
  const [userSettings, setUserSettings]   = useState<any>(null);
  const [linkProviderModal, setLinkProviderModal] = useState(false);
  const [tgDriveModal, setTgDriveModal]   = useState(false);
  const [tgChannelInput, setTgChannelInput] = useState('');
  const [tgDriveNameInput, setTgDriveNameInput] = useState('');
  const [tgRegisterLoading, setTgRegisterLoading] = useState(false);
  const [tgRegisterError, setTgRegisterError] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; percent: number } | null>(null);
  const [promptModal, setPromptModal]     = useState<{ isOpen: boolean; title: string; defaultValue: string; onConfirm: (val: string) => void; onCancel: () => void } | null>(null);
  const [confirmModal, setConfirmModal]   = useState<{ isOpen: boolean; title: string; message: string; onConfirm: () => void; onCancel: () => void } | null>(null);
  const [promptValue, setPromptValue]     = useState('');
  const [contextMenu, setContextMenu]     = useState<{ file: any; x: number; y: number } | null>(null);
  const [previewFile, setPreviewFile]     = useState<any | null>(null);
  const [fullScreenGalleryFile, setFullScreenGalleryFile] = useState<any | null>(null);
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
  const [modalAction, setModalAction] = useState<'move' | 'copy'>('move');
  const [moveTargetAccountId, setMoveTargetAccountId] = useState<string | null>(null);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string>('root');
  const [moveFoldersList, setMoveFoldersList] = useState<any[]>([]);
  const [moveModalTab, setMoveModalTab] = useState<'current' | 'all'>('current');
  const [moveLoading, setMoveLoading] = useState(false);
  const [toast, setToast]                 = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [isLoggingIn, setIsLoggingIn]     = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [regSettings, setRegSettings]     = useState<any>(null);
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false);
  const [adminStats, setAdminStats]       = useState<any>(null);
  const [adminRegSettings, setAdminRegSettings] = useState<any>(null);
  const [usersList, setUsersList]         = useState<any[]>([]);
  const [selectedAdminUserId, setSelectedAdminUserId] = useState<string | null>(null);
  const [selectedAdminUserDetails, setSelectedAdminUserDetails] = useState<any>(null);
  const [loadingUserDetails, setLoadingUserDetails] = useState(false);

  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);

  const toggleSelection = (e: React.MouseEvent, fileId: string) => {
    e.stopPropagation();
    const next = new Set(selectedFileIds);
    if (next.has(fileId)) next.delete(fileId);
    else next.add(fileId);
    setSelectedFileIds(next);
  };

  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleSingleClick = (file: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.innerWidth < 768) {
      if (file.type === 'folder') navigateToFolder(file);
      else if (['image', 'video', 'audio', 'pdf'].includes(file.type)) openPreview(file);
      else setSelectedFile(file);
      return;
    }
    if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    clickTimeoutRef.current = setTimeout(() => {
      setSelectedFile(file);
      clickTimeoutRef.current = null;
    }, 250);
  };

  const handleDoubleClick = (file: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    if (file.type === 'folder') navigateToFolder(file);
    else if (['image', 'video', 'audio', 'pdf'].includes(file.type)) openPreview(file);
  };

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    if (promptModal?.isOpen) setPromptValue(promptModal.defaultValue);
  }, [promptModal?.isOpen, promptModal?.defaultValue]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    localStorage.setItem('cloudyte_theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  useEffect(() => {
    const fetchPlatformSettings = async () => {
      try {
        const res = await fetch('/api/public/settings');
        if (res.ok) setRegSettings(await res.json());
        else setRegSettings({});
      } catch { setRegSettings({}); }
    };
    fetchPlatformSettings();
  }, []);

  const getAuthHeaders = useCallback(() => {
    const headers: any = {};
    if (authToken) headers['Authorization'] = `${tokenType} ${authToken}`;
    return headers;
  }, [authToken, tokenType]);

  const fetchUserProfile = useCallback(async () => {
    if (!authToken) {
      setIsInitializing(false);
      return;
    }
    try {
      const res = await fetch('/api/me', { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setUserProfile(data);
        if (data.username) { setUsername(data.username); localStorage.setItem('cloudyte_username', data.username); }
        setIsAdmin(!!data.isAdmin);
        localStorage.setItem('cloudyte_isAdmin', String(!!data.isAdmin));
        setUserSettings(data.settings);
      } else if (res.status === 401) {
        setIsAuthenticated(false);
        setAuthToken(null);
        localStorage.removeItem('cloudyte_token');
      }
    } catch { 
      /* ignore */ 
    } finally {
      setIsInitializing(false);
    }
  }, [authToken, getAuthHeaders]);

  useEffect(() => { fetchUserProfile(); }, [fetchUserProfile]);

  const fetchAccounts = useCallback(async () => {
    if (!isAuthenticated) return;
    const controller = new AbortController();
    const tId = setTimeout(() => controller.abort(), 15000);
    try {
      setLoading(true);
      const res = await fetch('/api/accounts', { headers: getAuthHeaders(), signal: controller.signal });
      clearTimeout(tId);
      if (res.status === 401) { setIsAuthenticated(false); setAuthToken(null); localStorage.removeItem('cloudyte_token'); return; }
      const data = await res.json();
      setAccounts(Array.isArray(data) ? data : []);
      if (Array.isArray(data) && data.length > 0 && !selectedAccountId) setSelectedAccountId(data[0].id);
    } catch { /* ignore */ } finally { setLoading(false); clearTimeout(tId); }
  }, [getAuthHeaders, selectedAccountId, isAuthenticated]);

  const fetchFiles = useCallback(async (accId: string, foldId: string | null, search?: string) => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.append('accountId', accId);
      if (foldId) params.append('folderId', foldId);
      if (search) params.append('search', search);
      const res = await fetch(`/api/files?${params.toString()}`, { headers: getAuthHeaders() });
      if (res.status === 401) { setIsAuthenticated(false); setAuthToken(null); localStorage.removeItem('cloudyte_token'); return; }
      const data = await res.json();
      setFiles(Array.isArray(data) ? data : []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [getAuthHeaders]);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);
  useEffect(() => { const t = setTimeout(() => setDebouncedSearch(searchQuery), 400); return () => clearTimeout(t); }, [searchQuery]);
  useEffect(() => { if (selectedAccountId) fetchFiles(selectedAccountId, currentFolderId, debouncedSearch); }, [selectedAccountId, currentFolderId, debouncedSearch, fetchFiles]);

  // ── Account selection: reset path & folder ────────────────────────────────
  const selectAccount = (id: string) => {
    const acc = accounts.find(a => a.id === id);
    setSelectedAccountId(id);
    setCurrentFolderId(null);
    setPath([{ id: null, name: acc?.accountType === 'tgdrive' ? `📡 TG Drive` : 'My Drive' }]);
    setSearchQuery('');
    setSelectedFile(null);
    setSelectedFileIds(new Set());
  };

  // ── Connect Google / OneDrive ─────────────────────────────────────────────
  const handleConnect = async (type: 'google' | 'onedrive') => {
    setLinkProviderModal(false);
    try {
      const endpoint = type === 'google' ? '/api/auth/drive-link' : '/api/auth/onedrive-link';
      const res      = await fetch(endpoint, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error('Failed to get auth link');
      const { url } = await res.json();
      const authWin = window.open(url, type + '_auth', 'width=600,height=700');
      const timer   = setInterval(() => { if (authWin?.closed) { clearInterval(timer); fetchAccounts(); } }, 2000);
    } catch (err: any) { showToast('Connection failed: ' + err.message, 'error'); }
  };

  // ── Register TG Drive channel ─────────────────────────────────────────────
  const handleRegisterTgDrive = async () => {
    if (!tgChannelInput.trim()) return;
    setTgRegisterLoading(true);
    setTgRegisterError('');
    try {
      const res  = await fetch('/api/tgdrive/register', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: tgChannelInput.trim(), driveName: tgDriveNameInput.trim() || 'TG Drive' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      setTgDriveModal(false);
      setTgChannelInput('');
      setTgDriveNameInput('');
      showToast(`✅ TG Drive "${data.name}" registered!`);
      fetchAccounts();
    } catch (err: any) { setTgRegisterError(err.message); }
    finally { setTgRegisterLoading(false); }
  };

  const handleUnlink = async (accountId: string) => {
    setConfirmModal({
      isOpen: true, title: 'Unlink Account', message: 'Are you sure you want to unlink this account?',
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await fetch(`/api/accounts/${accountId}`, { method: 'DELETE', headers: getAuthHeaders() });
          const newAccounts = accounts.filter(a => a.id !== accountId);
          setAccounts(newAccounts);
          if (selectedAccountId === accountId) setSelectedAccountId(newAccounts[0]?.id || null);
        } catch { showToast('Failed to unlink account', 'error'); }
      },
      onCancel: () => setConfirmModal(null),
    });
  };

  const handleDeleteFile = async (fileId: string) => {
    setConfirmModal({
      isOpen: true, title: 'Delete File', message: 'Are you sure you want to delete this file?',
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await fetch(`/api/files/${fileId}?accountId=${selectedAccountId}`, { method: 'DELETE', headers: getAuthHeaders() });
          if (!res.ok) throw new Error('Delete failed');
          setFiles(files.filter(f => f.id !== fileId));
          if (selectedFile?.id === fileId) setSelectedFile(null);
          showToast('File deleted');
        } catch { showToast('Delete failed', 'error'); }
      },
      onCancel: () => setConfirmModal(null),
    });
  };

  const handleRename = async (fileId: string, currentName: string) => {
    setPromptModal({
      isOpen: true, title: 'Rename File', defaultValue: currentName,
      onConfirm: async (newName) => {
        setPromptModal(null);
        if (!newName || newName === currentName) return;
        try {
          const res = await fetch(`/api/files/${fileId}?accountId=${selectedAccountId}`, {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
          });
          if (!res.ok) throw new Error(await res.text());
          fetchFiles(selectedAccountId!, currentFolderId);
          if (selectedFile?.id === fileId) setSelectedFile({ ...selectedFile, name: newName });
          showToast('Renamed successfully');
        } catch (err: any) { showToast('Rename failed: ' + err.message, 'error'); }
      },
      onCancel: () => setPromptModal(null),
    });
  };

  // ── Download: works for all account types via share → public/download ─────
  const handleDownload = async (fileId: string) => {
    try {
      const res  = await fetch('/api/share', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId, fileId }),
      });
      const data = await res.json();
      if (data.success && data.shareUrl) {
        const shareId = data.shareUrl.split('/').pop();
        window.open(`/api/public/download/${shareId}`, '_blank');
      } else { throw new Error(data.error || 'Failed to generate download link'); }
    } catch (err: any) { showToast('Download failed: ' + err.message, 'error'); }
  };

  // ── Share: works for all account types ────────────────────────────────────
  const handleShare = async (fileId: string) => {
    try {
      const res  = await fetch('/api/share', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId, fileId }),
      });
      const data = await res.json();
      if (data.success) {
        await navigator.clipboard.writeText(data.shareUrl).catch(() => {});
        showToast('Share link copied to clipboard!');
      } else { throw new Error(data.error); }
    } catch (err: any) { showToast('Share failed: ' + err.message, 'error'); }
  };

  const updateUserSettings = async (updates: any) => {
    try {
      const res = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) { setUserSettings((prev: any) => ({ ...prev, ...updates })); showToast('Settings updated!'); }
    } catch { showToast('Update failed', 'error'); }
  };

  const handleCreateFolder = async () => {
    setPromptModal({
      isOpen: true, title: 'New Folder', defaultValue: 'Untitled Folder',
      onConfirm: async (folderName) => {
        setPromptModal(null);
        if (!folderName || !selectedAccountId) return;
        try {
          setLoading(true);
          const res = await fetch(`/api/folders?accountId=${selectedAccountId}`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: folderName, parentId: currentFolderId }),
          });
          if (!res.ok) throw new Error('Failed to create folder');
          fetchFiles(selectedAccountId, currentFolderId);
          showToast('Folder created');
        } catch (err: any) { showToast(err.message, 'error'); }
        finally { setLoading(false); }
      },
      onCancel: () => setPromptModal(null),
    });
  };

  const uploadFiles = async (filesToUpload: FileList | File[] | null) => {
    if (!filesToUpload || filesToUpload.length === 0 || !selectedAccountId) return;
    let successCount = 0;
    try {
      for (let i = 0; i < filesToUpload.length; i++) {
        const file = filesToUpload[i];
        setUploadProgress({ name: file.name, percent: 0 });
        try {
          await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const formData = new FormData();
            formData.append('file', file);
            if (currentFolderId) formData.append('folderId', currentFolderId);
            xhr.upload.addEventListener('progress', (ev) => { if (ev.lengthComputable) setUploadProgress({ name: file.name, percent: Math.round((ev.loaded / ev.total) * 100) }); });
            xhr.addEventListener('load', () => { if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response); else reject(new Error(`Upload failed for ${file.name}`)); });
            xhr.addEventListener('error', () => reject(new Error(`Upload failed for ${file.name}`)));
            xhr.open('POST', `/api/upload/${selectedAccountId}`);
            const h = getAuthHeaders();
            if (h['Authorization']) xhr.setRequestHeader('Authorization', h['Authorization']);
            xhr.send(formData);
          });
          successCount++;
        } catch (uploadErr: any) {
          showToast(uploadErr.message, 'error');
        }
      }
      fetchFiles(selectedAccountId, currentFolderId);
      if (successCount > 0) showToast(`${successCount} file(s) uploaded successfully`);
    } catch (err: any) {
      showToast(err.message || 'Upload process failed', 'error');
    }
    finally { setUploadProgress(null); }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await uploadFiles(e.target.files);
    e.target.value = '';
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (e.currentTarget === e.target) setIsDragging(false);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
  };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false);
    if (e.dataTransfer.files) await uploadFiles(e.dataTransfer.files);
  };

  const handleBulkDelete = async () => {
    if (selectedFileIds.size === 0) return;
    setConfirmModal({
      isOpen: true,
      title: 'Delete Selected',
      message: `Are you sure you want to delete ${selectedFileIds.size} file(s)?`,
      onConfirm: async () => {
        setConfirmModal(null);
        let successCount = 0;
        for (const id of selectedFileIds) {
          try {
            const res = await fetch(`/api/files/${id}?accountId=${selectedAccountId}`, { method: 'DELETE', headers: getAuthHeaders() });
            if (res.ok) successCount++;
          } catch { /* ignore */ }
        }
        setFiles(files.filter(f => !selectedFileIds.has(f.id)));
        if (selectedFile && selectedFileIds.has(selectedFile.id)) setSelectedFile(null);
        setSelectedFileIds(new Set());
        showToast(`${successCount} file(s) deleted`);
      },
      onCancel: () => setConfirmModal(null),
    });
  };

  const fetchMoveFolders = useCallback(async (accountId: string, folderId: string) => {
    setMoveLoading(true);
    try {
      const res = await fetch(`/api/files?accountId=${accountId}&folderId=${folderId}`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setMoveFoldersList(Array.isArray(data) ? data.filter(f => f.type === 'folder') : []);
      }
    } catch {}
    setMoveLoading(false);
  }, [getAuthHeaders]);

  const handleOpenMoveModal = (action: 'move' | 'copy' = 'move') => {
    setModalAction(action);
    setMoveTargetAccountId(selectedAccountId);
    setMoveTargetFolderId('root');
    setMoveModalTab('current');
    if (selectedAccountId) fetchMoveFolders(selectedAccountId, 'root');
    setIsMoveModalOpen(true);
  };

  const navigateMoveFolder = (folderId: string) => {
    setMoveTargetFolderId(folderId);
    if (moveTargetAccountId) fetchMoveFolders(moveTargetAccountId, folderId);
  };

  const navigateMoveAccount = (accountId: string) => {
    setMoveTargetAccountId(accountId);
    setMoveTargetFolderId('root');
    setMoveModalTab('current'); 
    fetchMoveFolders(accountId, 'root');
  };

  const handleMoveConfirm = async () => {
    if (selectedFileIds.size === 0 || !moveTargetAccountId) return;
    showToast(`${modalAction === 'move' ? 'Moving' : 'Copying'} files...`);
    setIsMoveModalOpen(false);
    let successCount = 0;
    
    for (const fileId of selectedFileIds) {
      try {
        const res = await fetch(`/api/files/${modalAction}`, {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            sourceAccountId: selectedAccountId,
            fileId, 
            targetAccountId: moveTargetAccountId, 
            targetFolderId: moveTargetFolderId 
          }),
        });
        if (res.ok) successCount++;
      } catch {}
    }
    
    if (successCount > 0) {
      showToast(`${modalAction === 'move' ? 'Moved' : 'Copied'} ${successCount} file(s)`);
      fetchFiles(selectedAccountId!, currentFolderId, debouncedSearch);
      setSelectedFileIds(new Set());
    } else {
      showToast(`${modalAction === 'move' ? 'Move' : 'Copy'} failed for all files`, 'error');
    }
  };

  const handleBulkDownload = async () => {
    if (selectedFileIds.size === 0) return;
    showToast('Starting downloads...');
    for (const id of selectedFileIds) {
      handleDownload(id);
    }
    setSelectedFileIds(new Set());
  };

  const handleBulkZipToCloud = async (specificIds?: Set<string>) => {
    const idsToProcess = specificIds || selectedFileIds;
    if (idsToProcess.size === 0) return;
    showToast('Preparing ZIP archive to save here...', 'success');
    try {
      const zip = new JSZip();
      for (const id of idsToProcess) {
        const file = files.find(f => f.id === id);
        if (!file || file.type === 'folder') continue;
        
        const res  = await fetch('/api/share', {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: selectedAccountId, fileId: id }),
        });
        const data = await res.json();
        if (data.success && data.shareUrl) {
          const shareId = data.shareUrl.split('/').pop();
          const blobRes = await fetch(`/api/public/download/${shareId}`);
          if (!blobRes.ok) throw new Error(`Failed to download ${file.name}`);
          const blob = await blobRes.blob();
          zip.file(file.name, blob);
        } else {
          throw new Error(data.error || 'Failed to generate download link');
        }
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const zipFile = new File([content], `archive_${Date.now()}.zip`, { type: 'application/zip' });
      showToast('Uploading ZIP archive to current folder...');
      await uploadFiles([zipFile] as any);
      if (!specificIds) setSelectedFileIds(new Set());
    } catch (err: any) {
      showToast('Failed to create ZIP: ' + err.message, 'error');
    }
  };

  const openPreview = async (file: any) => {
    const token = localStorage.getItem('cloudyte_token');
    const url = `/api/download/${selectedAccountId}/${file.id}?preview=1&token=${token}`;
    setPreviewFile({ ...file, url });
  };

  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchEndX.current = null;
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;
    const distance = touchStartX.current - touchEndX.current;
    const minSwipeDistance = 50;
    if (distance > minSwipeDistance && hasNextMedia) navigateGallery('next');
    if (distance < -minSwipeDistance && hasPrevMedia) navigateGallery('prev');
    touchStartX.current = null;
    touchEndX.current = null;
  };

  const openFullScreenGallery = (file: any) => {
    setPreviewFile(null); // Close the smaller modal
    setFullScreenGalleryFile(file);
  };

  const getMediaUrl = useCallback((file: any) => {
    if (!file) return '';
    if (file.url) return file.url;
    const token = localStorage.getItem('cloudyte_token');
    return `/api/download/${selectedAccountId}/${file.id}?preview=1&token=${token}`;
  }, [selectedAccountId]);

  const mediaFiles = files.filter(f => ['image', 'video', 'audio'].includes(f.type));
  const currentGalleryIndex = fullScreenGalleryFile ? mediaFiles.findIndex(f => f.id === fullScreenGalleryFile.id) : -1;
  const hasNextMedia = currentGalleryIndex >= 0 && currentGalleryIndex < mediaFiles.length - 1;
  const hasPrevMedia = currentGalleryIndex > 0;

  const navigateGallery = useCallback((direction: 'next' | 'prev', e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (direction === 'next' && currentGalleryIndex >= 0 && currentGalleryIndex < mediaFiles.length - 1) setFullScreenGalleryFile(mediaFiles[currentGalleryIndex + 1]);
    if (direction === 'prev' && currentGalleryIndex > 0) setFullScreenGalleryFile(mediaFiles[currentGalleryIndex - 1]);
  }, [currentGalleryIndex, mediaFiles]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!fullScreenGalleryFile) return;
      if (e.key === 'ArrowRight') navigateGallery('next');
      if (e.key === 'ArrowLeft') navigateGallery('prev');
      if (e.key === 'Escape') setFullScreenGalleryFile(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fullScreenGalleryFile, navigateGallery]);

  const handleBulkZip = async (specificIds?: Set<string>) => {
    const idsToProcess = specificIds || selectedFileIds;
    if (idsToProcess.size === 0) return;
    showToast('Preparing ZIP archive... this may take a while.', 'success');
    try {
      const zip = new JSZip();
      for (const id of idsToProcess) {
        const file = files.find(f => f.id === id);
        if (!file || file.type === 'folder') continue;
        
        const res  = await fetch('/api/share', {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: selectedAccountId, fileId: id }),
        });
        const data = await res.json();
        if (data.success && data.shareUrl) {
          const shareId = data.shareUrl.split('/').pop();
          const blobRes = await fetch(`/api/public/download/${shareId}`);
          if (!blobRes.ok) throw new Error(`Failed to download ${file.name}`);
          const blob = await blobRes.blob();
          zip.file(file.name, blob);
        } else {
          throw new Error(data.error || 'Failed to generate download link');
        }
      }
      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, 'archive.zip');
      showToast('ZIP downloaded successfully');
      if (!specificIds) setSelectedFileIds(new Set());
    } catch (err: any) {
      showToast('Failed to create ZIP: ' + err.message, 'error');
    }
  };

  const handleUnzip = async (file: any) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      showToast('Only ZIP files can be unzipped', 'error');
      return;
    }
    showToast('Downloading ZIP for extraction...');
    try {
      const res  = await fetch('/api/share', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId, fileId: file.id }),
      });
      const data = await res.json();
      if (!data.success || !data.shareUrl) throw new Error(data.error || 'Failed to generate download link');
      
      const shareId = data.shareUrl.split('/').pop();
      const blobRes = await fetch(`/api/public/download/${shareId}`);
      if (!blobRes.ok) throw new Error(`Failed to download ${file.name}`);
      const blob = await blobRes.blob();
      
      const zip = new JSZip();
      const loadedZip = await zip.loadAsync(blob);
      
      const extractedFiles: File[] = [];
      for (const [filename, zipEntry] of Object.entries(loadedZip.files)) {
        if (!zipEntry.dir) {
          const entryBlob = await zipEntry.async('blob');
          const extractedFile = new File([entryBlob], filename, { type: 'application/octet-stream' });
          extractedFiles.push(extractedFile);
        }
      }
      
      if (extractedFiles.length === 0) {
        showToast('ZIP file is empty');
        return;
      }
      
      showToast(`Extracting and uploading ${extractedFiles.length} file(s)...`);
      await uploadFiles(extractedFiles);
    } catch (err: any) {
      showToast('Failed to unzip: ' + err.message, 'error');
    }
  };

  const navigateToFolder = (folder: any) => {
    // TG Drive folders use path strings prefixed with "folder:"
    const folderId = folder.id.startsWith('folder:') ? folder.id.replace('folder:', '') : folder.id;
    setCurrentFolderId(folderId);
    setPath([...path, { id: folderId, name: folder.name }]);
    setSearchQuery('');
    setSelectedFileIds(new Set());
  };

  const navigateUp = (index: number) => {
    const newPath = path.slice(0, index + 1);
    setPath(newPath);
    setCurrentFolderId(newPath[newPath.length - 1].id);
    setSearchQuery('');
    setSelectedFileIds(new Set());
  };

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoginError(null);
    setIsLoggingIn(true);
    const formData = new FormData(e.currentTarget);
    const uname    = formData.get('username') as string;
    const pass     = formData.get('password') as string;
    const abort    = new AbortController();
    const tid      = setTimeout(() => abort.abort(), 10000);
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, password: pass }), signal: abort.signal });
      clearTimeout(tid);
      if (!res.ok) { const e = await res.json().catch(() => ({ error: 'Login failed' })); throw new Error(e.error || 'Login failed'); }
      const data = await res.json();
      if (data.success && data.token) {
        const type = 'Bearer';
        localStorage.setItem('cloudyte_token', data.token);
        localStorage.setItem('cloudyte_username', data.username);
        localStorage.setItem('cloudyte_token_type', type);
        localStorage.setItem('cloudyte_isAdmin', String(!!data.isAdmin));
        setAuthToken(data.token); setTokenType(type); setUsername(data.username); setIsAdmin(!!data.isAdmin); setUserProfile(data); setIsAuthenticated(true);
      } else { throw new Error('Invalid response'); }
    } catch (err: any) {
      setLoginError(err.name === 'AbortError' ? 'Login timed out.' : (err.message || 'Login failed'));
    } finally { setIsLoggingIn(false); clearTimeout(tid); }
  };

  const handleRegister = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoginError(null);
    setIsLoggingIn(true);
    const formData = new FormData(e.currentTarget);
    const uname    = formData.get('username') as string;
    const pass     = formData.get('password') as string;
    const confirm  = formData.get('confirm_password') as string;

    if (pass !== confirm) {
      setLoginError('Passwords do not match');
      setIsLoggingIn(false);
      return;
    }

    try {
      const res = await fetch('/api/register', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ username: uname, password: pass }) 
      });
      if (!res.ok) { 
        const err = await res.json().catch(() => ({ error: 'Registration failed' })); 
        throw new Error(err.error || 'Registration failed'); 
      }
      showToast('Account created! You can now login.');
      setIsRegisterMode(false);
    } catch (err: any) {
      setLoginError(err.message);
    } finally { setIsLoggingIn(false); }
  };

  const fetchAdminData = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const h = getAuthHeaders();
      const [statsRes, settingsRes, usersRes] = await Promise.all([
        fetch('/api/admin/stats', { headers: h }),
        fetch('/api/admin/settings', { headers: h }),
        fetch('/api/admin/users', { headers: h })
      ]);
      if (statsRes.ok) setAdminStats(await statsRes.json());
      if (settingsRes.ok) {
        setAdminRegSettings(await settingsRes.json());
      }
      if (usersRes.ok) setUsersList(await usersRes.json());
    } catch { /* ignore */ }
  }, [isAdmin, getAuthHeaders]);

  useEffect(() => { if (isAdminPanelOpen) fetchAdminData(); }, [isAdminPanelOpen, fetchAdminData]);

  const toggleRegSetting = async (key: string, value: boolean) => {
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      });
      if (res.ok) {
        setAdminRegSettings((prev: any) => ({ ...prev, [key]: value }));
        // Also update the public regSettings so login page reflects it immediately if needed
        setRegSettings((prev: any) => ({ ...prev, [key]: value }));
        showToast('Setting updated');
      }
    } catch { showToast('Update failed', 'error'); }
  };

  const handleToggleUser = async (uId: string, active: boolean) => {
    try {
      const res = await fetch(`/api/admin/users/${uId}/toggle`, {
        method: 'POST',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        setUsersList(usersList.map((u: any) => u.id === uId ? { ...u, isActive: !active } : u));
        showToast(`User ${active ? 'disabled' : 'enabled'}`);
      }
    } catch { showToast('Action failed', 'error'); }
  };

  const handleDeleteUser = async (uId: string) => {
    setConfirmModal({
      isOpen: true, title: 'Delete User', message: 'DANGER: This will permanently delete this user and all their linked accounts. Proceed?',
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await fetch(`/api/admin/users/${uId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
          });
          if (res.ok) {
            setUsersList(usersList.filter((u: any) => u.id !== uId));
            showToast('User deleted');
          }
        } catch { showToast('Delete failed', 'error'); }
      },
      onCancel: () => setConfirmModal(null)
    });
  };

  const fetchUserDetails = async (uId: string) => {
    setSelectedAdminUserId(uId);
    setLoadingUserDetails(true);
    try {
      const res = await fetch(`/api/admin/users/${uId}`, { headers: getAuthHeaders() });
      if (res.ok) setSelectedAdminUserDetails(await res.json());
    } catch { showToast('Failed to load user details', 'error'); }
    finally { setLoadingUserDetails(false); }
  };

  // ── Derived: selected account type ───────────────────────────────────────
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const isTgDrive = selectedAccount?.accountType === 'tgdrive';

  // ── Loading Screen ─────────────────────────────────────────────────────────
  if (isInitializing || (isAuthenticated && !userProfile)) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center gap-4">
        <motion.div 
          animate={{ rotate: 360 }} 
          transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} 
          className="text-blue-500"
        >
          <RefreshCw size={48} />
        </motion.div>
        <p className="text-slate-500 font-bold text-sm">Initializing Cloudyte...</p>
      </div>
    );
  }

  // ── Login page ────────────────────────────────────────────────────────────
  if (!isAuthenticated) {
    const isRegDisabled = regSettings?.registrationEnabled === false;
    const isWebRegDisabled = regSettings?.webRegistrationEnabled === false;
    const canRegisterOnWeb = regSettings && !isRegDisabled && !isWebRegDisabled;

    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6 bg-[radial-gradient(circle_at_50%_-20%,#1e293b,transparent)]">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl max-w-md w-full border border-slate-100 dark:border-slate-700">
          <div className="w-20 h-20 bg-blue-700 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-xl shadow-blue-900/20">
            <Cloud size={40} className="text-white" />
          </div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white mb-2 text-center tracking-tight">Cloudyte</h1>
          <p className="text-slate-400 mb-8 text-center font-medium">
            {isRegisterMode ? 'Create a new account' : 'Login with your credentials'}
          </p>

          <form onSubmit={isRegisterMode ? handleRegister : handleLogin} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-slate-400 px-2 tracking-widest">Username</label>
              <input name="username" type="text" placeholder="e.g. john_doe" required className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-500 rounded-2xl outline-none transition-all font-bold text-slate-700 dark:text-white" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-slate-400 px-2 tracking-widest">Password</label>
              <input name="password" type="password" placeholder="••••••••" required className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-500 rounded-2xl outline-none transition-all font-bold text-slate-700 dark:text-white" />
            </div>
            {isRegisterMode && (
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase text-slate-400 px-2 tracking-widest">Confirm Password</label>
                <input name="confirm_password" type="password" placeholder="••••••••" required className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-500 rounded-2xl outline-none transition-all font-bold text-slate-700 dark:text-white" />
              </div>
            )}
            
            {loginError && <motion.p initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="text-red-500 text-xs font-bold px-2">{loginError}</motion.p>}
            
            <button disabled={isLoggingIn} className="w-full bg-slate-900 dark:bg-blue-700 text-white py-4 rounded-2xl font-black text-lg hover:bg-slate-800 transition-all active:scale-[0.98] shadow-lg flex items-center justify-center gap-2 disabled:opacity-50 mt-4">
              {isLoggingIn ? (
                <><RefreshCw size={20} className="animate-spin" /><span>{isRegisterMode ? 'Creating Account...' : 'Authenticating...'}</span></>
              ) : (
                <span>{isRegisterMode ? 'Create Account' : 'Access Dashboard'}</span>
              )}
            </button>
          </form>

          <div className="mt-8 pt-8 border-t border-slate-100 dark:border-slate-700 flex flex-col items-center gap-4 min-h-[60px]">
            {!regSettings ? (
              <div className="flex items-center gap-2 text-slate-500 text-xs font-medium">
                <RefreshCw size={12} className="animate-spin" />
                <span>Fetching platform settings...</span>
              </div>
            ) : isRegisterMode ? (
              <button 
                onClick={() => { setIsRegisterMode(false); setLoginError(null); }}
                className="text-xs font-bold text-blue-500 hover:underline"
              >
                Already have an account? Login
              </button>
            ) : (
              <>
                {canRegisterOnWeb ? (
                  <button 
                    onClick={() => { setIsRegisterMode(true); setLoginError(null); }}
                    className="text-xs font-bold text-blue-500 hover:underline"
                  >
                    Don't have an account? Register here
                  </button>
                ) : (
                  <div className="text-center space-y-2">
                    <p className="text-xs text-slate-400 font-medium italic">
                      Registration is managed by platform security.
                    </p>
                    {regSettings?.botRegistrationEnabled !== false && !isRegDisabled && (
                      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-tight">
                        Use <span className="text-blue-500">/register</span> in the Telegram bot.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className={`flex h-screen transition-colors duration-200 ${isDarkMode ? 'dark bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'} font-sans overflow-hidden relative`}>
      {/* Sidebar Backdrop */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsSidebarOpen(false)} className="fixed inset-0 bg-slate-950/40 backdrop-blur-[2px] z-[45] lg:hidden" />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className={`fixed lg:relative inset-y-0 left-0 bg-white dark:bg-slate-950 border-r border-slate-200 dark:border-slate-900 transition-[transform,opacity,width] duration-200 z-50 flex flex-col shadow-2xl lg:shadow-none ${isSidebarOpen ? 'w-72 translate-x-0 opacity-100' : 'w-0 -translate-x-full lg:translate-x-0 opacity-0 overflow-hidden'}`}>
        <div className="p-6 flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-700 rounded-xl flex items-center justify-center text-white shadow-lg shrink-0"><Cloud size={24} /></div>
          <span className="font-black text-xl tracking-tight text-slate-900 dark:text-white">Cloudyte</span>
        </div>

        <div className="flex-1 px-4 py-4 overflow-y-auto no-scrollbar space-y-6">
          <div>
            <div className="px-3 flex items-center justify-between mb-3">
              <h3 className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest">Drive Accounts</h3>
            </div>
            <div className="space-y-1">
              {accounts.map(acc => (
                <button key={acc.id} onClick={() => selectAccount(acc.id)}
                  className={`w-full group flex items-center gap-3 px-3 py-3 rounded-xl transition-colors duration-150 ${selectedAccountId === acc.id ? 'bg-blue-50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-400 ring-1 ring-blue-600/40 dark:ring-blue-500/40' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shadow-sm ${acc.accountType === 'tgdrive' ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-500' : selectedAccountId === acc.id ? 'bg-white dark:bg-slate-800' : 'bg-slate-100 dark:bg-slate-900'}`}>
                    {acc.accountType === 'tgdrive' ? <TelegramIcon size={16} /> : <HardDrive size={16} />}
                  </div>
                  <div className="flex-1 text-left overflow-hidden">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-bold truncate dark:text-white">{acc.name || (acc.accountType === 'tgdrive' ? 'TG Drive' : acc.email)}</p>
                      {acc.id === userSettings?.backupAccId && <Cloud size={10} className="text-blue-500 shrink-0" title="Backup Drive" />}
                    </div>
                    <p className="text-[10px] opacity-60 truncate dark:text-white">{acc.accountType === 'tgdrive' ? acc.email : acc.email}</p>
                  </div>
                  {acc.error && <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse shrink-0" />}
                </button>
              ))}
              <button onClick={() => setLinkProviderModal(true)} className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-blue-600 dark:text-blue-400 font-bold hover:bg-blue-100/50 dark:hover:bg-slate-800 transition-colors border border-dashed border-blue-200 dark:border-blue-800">
                <Plus size={18} className="dark:text-white" />
                <span className="text-sm dark:text-white">Link Account</span>
              </button>
            </div>
          </div>

          <div>
            <h3 className="px-3 text-[10px] font-black uppercase text-slate-400 tracking-widest mb-3">General</h3>
            <button onClick={() => setIsSettingsOpen(true)} className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-colors duration-150 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900/50 ${isSettingsOpen ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400' : ''}`}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-900"><Settings size={16} /></div>
              <span className="text-sm font-bold">Settings</span>
            </button>
            {isAdmin && (
              <button onClick={() => setIsAdminPanelOpen(true)} className={`w-full mt-1 flex items-center gap-3 px-3 py-3 rounded-xl transition-colors duration-150 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900/50 ${isAdminPanelOpen ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400' : ''}`}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-900"><MoreVertical size={16} className="rotate-90" /></div>
                <span className="text-sm font-bold">Admin Panel</span>
              </button>
            )}
          </div>
        </div>

        {/* Storage bar */}
        <div className="px-6 mb-6">
          {accounts.filter(a => a.id === selectedAccountId).slice(0, 1).map(acc => (
            <div key={acc.id} className="space-y-2">
              <div className="flex justify-between items-end">
                {acc.accountType === 'tgdrive'
                  ? <p className="text-[10px] font-black text-slate-400 uppercase tracking-tight">{acc.usage} used • {acc.fileCount} files</p>
                  : <p className="text-[10px] font-black text-slate-400 uppercase tracking-tight">{acc.usage} of {acc.total}</p>
                }
                {acc.accountType !== 'tgdrive' && <p className="text-[10px] font-black text-blue-600 dark:text-blue-400">{acc.percentage}%</p>}
              </div>
              {acc.accountType !== 'tgdrive' && (
                <div className="h-1 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                  <motion.div initial={{ width: 0 }} animate={{ width: `${acc.percentage}%` }} className={`h-full rounded-full ${acc.percentage > 90 ? 'bg-red-500' : acc.percentage > 70 ? 'bg-amber-500' : 'bg-blue-600'}`} />
                </div>
              )}
              {acc.accountType === 'tgdrive' && (
                <div className="h-1 bg-sky-100 dark:bg-sky-900/30 rounded-full overflow-hidden">
                  <div className="h-full w-full bg-gradient-to-r from-sky-400 to-blue-500 rounded-full" />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* User row */}
        <div className="p-4 border-t border-slate-100 dark:border-slate-900">
          <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center text-blue-700 dark:text-blue-400 font-black uppercase">{username ? username[0] : 'U'}</div>
            <div className="flex-1 overflow-hidden pointer-events-none">
              <p className="text-xs font-bold text-slate-900 dark:text-white truncate">{username ? `@${username}` : 'Loading...'}</p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wide font-black">{isAdmin ? 'Administrator' : 'Cloudyte Pro Member'}</p>
            </div>
            <button onClick={() => setIsDarkMode(!isDarkMode)} className="text-slate-400 hover:text-blue-500 transition-colors" title="Toggle Theme">{isDarkMode ? <Sun size={16} /> : <Moon size={16} />}</button>
            <LogOut size={16} className="text-slate-400 hover:text-red-500 cursor-pointer transition-colors" title="Log Out" onClick={async () => {
              try { await fetch('/api/logout', { method: 'POST', headers: getAuthHeaders() }); } catch { /* ignore */ }
              localStorage.removeItem('cloudyte_token'); localStorage.removeItem('cloudyte_username'); window.location.reload();
            }} />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main 
        className={`flex-1 flex flex-col min-w-0 bg-white dark:bg-slate-950 transition-all duration-200 relative ${isSidebarOpen ? 'lg:blur-none blur-[2px] pointer-events-none lg:pointer-events-auto' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-blue-500/10 backdrop-blur-sm border-4 border-dashed border-blue-500 flex flex-col items-center justify-center pointer-events-none">
            <div className="bg-white dark:bg-slate-800 p-8 rounded-full shadow-2xl animate-bounce">
              <Folder size={64} className="text-blue-500" />
            </div>
            <p className="mt-8 text-3xl font-black text-blue-600 dark:text-blue-400 drop-shadow-md">Drop files here to upload</p>
          </div>
        )}
        {/* Header */}
        <header className="h-20 bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-slate-900 px-8 flex items-center justify-between sticky top-0 z-40">
          <div className="flex items-center gap-6 flex-1">
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-slate-50 dark:hover:bg-slate-900/50 rounded-lg text-slate-500">{isSidebarOpen ? <X size={20} /> : <Menu size={20} />}</button>
            <div className="max-w-xl w-full relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder={isTgDrive ? 'Search TG Drive files...' : 'Search files, folders...'} className="w-full bg-slate-100 dark:bg-slate-900 border-none rounded-2xl py-3 pl-12 pr-4 text-sm focus:ring-2 focus:ring-blue-500 transition-all font-medium dark:text-white" />
            </div>
          </div>
          <div className="flex items-center gap-4">
            {/* TG Drive badge */}
            {isTgDrive && (
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 rounded-xl text-[11px] font-black uppercase tracking-widest">
                <TelegramIcon size={14} />
                <span>TG Drive</span>
              </div>
            )}
            <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200 transition-all">{isDarkMode ? <Sun size={18} /> : <Moon size={18} />}</button>
            <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-xl">
              <button onClick={() => setViewMode('list')} className={`p-2 rounded-lg transition-colors ${viewMode === 'list' ? 'bg-white dark:bg-slate-800 shadow-sm text-blue-600 dark:text-white' : 'text-slate-500'}`}><ListIcon size={18} /></button>
              <button onClick={() => setViewMode('grid')} className={`p-2 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-white dark:bg-slate-800 shadow-sm text-blue-600 dark:text-white' : 'text-slate-500'}`}><LayoutGrid size={18} /></button>
            </div>
          </div>
        </header>

        {/* Browser */}
        <div className="flex-1 overflow-y-auto p-8 relative scrollbar-thin">
          {loading && accounts.length === 0 ? (
            <div className="max-w-6xl mx-auto space-y-8">
              <div className="h-10 w-48 bg-slate-100 dark:bg-slate-900 rounded-xl animate-pulse" />
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
                {[...Array(12)].map((_, i) => (
                  <div key={i} className="h-40 bg-slate-50 dark:bg-slate-900/50 rounded-2xl animate-pulse border border-slate-100 dark:border-slate-800" />
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-6xl mx-auto space-y-8">
              {/* Breadcrumbs & Actions */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
                {path.map((item, idx) => (
                  <React.Fragment key={idx}>
                    <button onClick={() => navigateUp(idx)} className={`text-sm font-bold whitespace-nowrap transition-colors ${idx === path.length - 1 ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 hover:text-slate-600 dark:text-white dark:hover:text-blue-400'}`}>{item.name}</button>
                    {idx < path.length - 1 && <ChevronRight size={14} className="text-slate-300 dark:text-slate-600 shrink-0" />}
                  </React.Fragment>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <button onClick={handleCreateFolder} className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-50 transition-all active:scale-95" title="New Folder"><Folder size={18} /></button>
                <button onClick={() => selectedAccountId && fetchFiles(selectedAccountId, currentFolderId, searchQuery)} className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-50 transition-all active:scale-95"><RefreshCw size={18} /></button>
                <label className={`font-bold px-6 py-2.5 rounded-xl hover:opacity-90 transition-all shadow-lg flex items-center gap-2 active:scale-95 cursor-pointer text-white ${isTgDrive ? 'bg-sky-500 shadow-sky-900/10' : 'bg-blue-600 shadow-blue-900/10'}`}>
                  <Plus size={18} /><span>Upload</span>
                  <input type="file" className="hidden" onChange={handleUpload} multiple />
                </label>
              </div>
            </div>

            {/* File list */}
            <div className="space-y-4 relative">
              {loading && files.length > 0 && (
                <div className="absolute -top-4 inset-x-0 h-1 bg-blue-100 dark:bg-blue-900/20 rounded-full overflow-hidden z-20">
                  <motion.div initial={{ width: '0%', x: '-100%' }} animate={{ width: '100%', x: '100%' }} transition={{ repeat: Infinity, duration: 1.2, ease: 'easeInOut' }} className="h-full bg-blue-600 rounded-full" />
                </div>
              )}

              {loading && files.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-32 text-slate-400 gap-4">
                  <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} className="text-blue-600 dark:text-blue-400"><RefreshCw size={48} /></motion.div>
                  <p className="text-sm font-bold tracking-tight">Loading files...</p>
                </div>
              ) : files.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-32 text-slate-400 gap-6">
                  <div className="w-24 h-24 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center opacity-50">
                    {isTgDrive ? <TelegramIcon size={48} /> : <Folder size={48} />}
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-slate-900 dark:text-white">No files here</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{isTgDrive ? 'Upload files to this TG Drive channel.' : 'This folder is empty. Upload something to get started.'}</p>
                  </div>
                  <label className="text-blue-600 dark:text-blue-400 font-bold border-2 border-blue-100 dark:border-blue-900/30 px-6 py-2 rounded-xl hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors cursor-pointer">
                    Upload Files <input type="file" className="hidden" onChange={handleUpload} multiple />
                  </label>
                </div>
              ) : viewMode === 'list' ? (
                <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-x-auto">
                  <table className="w-full text-left min-w-[600px]">
                    <thead className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800">
                      <tr>
                        <th className="px-6 py-5 w-1">
                          <input type="checkbox" className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 bg-white dark:bg-slate-800 dark:border-slate-600 cursor-pointer"
                            checked={files.length > 0 && selectedFileIds.size === files.length}
                            onChange={(e) => {
                              if (e.target.checked) setSelectedFileIds(new Set(files.map(f => f.id)));
                              else setSelectedFileIds(new Set());
                            }}
                          />
                        </th>
                        <th className="px-6 py-5 text-[11px] font-black uppercase text-slate-400 tracking-widest">Name</th>
                        <th className="px-6 py-5 text-[11px] font-black uppercase text-slate-400 tracking-widest hidden md:table-cell">Created</th>
                        <th className="px-6 py-5 text-[11px] font-black uppercase text-slate-400 tracking-widest hidden lg:table-cell">Modified</th>
                        <th className="px-6 py-5 text-[11px] font-black uppercase text-slate-400 tracking-widest text-right">Size</th>
                        <th className="px-6 py-5 text-right w-1" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {files.map(file => (
                        <tr key={file.id} className={`group hover:bg-slate-100/50 dark:hover:bg-slate-800/30 transition-all cursor-pointer ${selectedFile?.id === file.id ? 'bg-blue-50/50 dark:bg-blue-900/20' : ''}`}
                          onClick={(e) => handleSingleClick(file, e)}
                          onDoubleClick={(e) => handleDoubleClick(file, e)}>
                          <td className="px-6 py-5 w-1" onClick={e => e.stopPropagation()}>
                            <input type="checkbox" className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 bg-white dark:bg-slate-800 dark:border-slate-600 cursor-pointer"
                              checked={selectedFileIds.has(file.id)}
                              onChange={(e) => toggleSelection(e as any, file.id)}
                            />
                          </td>
                          <td className="px-6 py-5">
                            <div className="flex items-center gap-4">
                              <FileIcon file={file} type={file.type} isTg={file.isTgDrive} accountId={selectedAccountId} showThumbnails={userSettings?.showThumbnails !== false} />
                              <span className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate max-w-[150px] sm:max-w-xs md:max-w-md group-hover:text-blue-600 transition-colors uppercase tracking-tight">{file.name}</span>
                            </div>
                          </td>
                          <td className="px-6 py-5 text-xs font-bold text-slate-400 hidden md:table-cell">{file.createdAt}</td>
                          <td className="px-6 py-5 text-xs font-bold text-slate-400 hidden lg:table-cell">{file.modified}</td>
                          <td className="px-6 py-5 text-right whitespace-nowrap"><span className="text-[10px] font-bold font-mono text-slate-500 bg-slate-100 dark:bg-slate-950 px-2 py-1 rounded-lg uppercase">{file.size}</span></td>
                          <td className="px-6 py-4 text-right w-40 whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                              <div className="hidden lg:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all translate-x-2 group-hover:translate-x-0">
                                {file.type !== 'folder' && <button onClick={() => setPreviewFile(file)} className="p-2 hover:bg-white dark:hover:bg-slate-800 shadow-sm rounded-xl text-slate-400 hover:text-blue-600 transition-all border border-transparent hover:border-slate-200" title="Preview"><Eye size={16} /></button>}
                                {file.type !== 'folder' && <button onClick={() => handleShare(file.id)} className="p-2 hover:bg-white dark:hover:bg-slate-800 shadow-sm rounded-xl text-slate-400 hover:text-blue-600 transition-all border border-transparent hover:border-slate-200" title="Share"><Share2 size={16} /></button>}
                                {file.type !== 'folder' && <button onClick={() => handleDownload(file.id)} className="p-2 hover:bg-white dark:hover:bg-slate-800 shadow-sm rounded-xl text-slate-400 hover:text-blue-600 transition-all border border-transparent hover:border-slate-200" title="Download"><Download size={16} /></button>}
                                <button onClick={() => handleRename(file.id, file.name)} className="p-2 hover:bg-white dark:hover:bg-slate-800 shadow-sm rounded-xl text-slate-400 hover:text-blue-600 transition-all border border-transparent hover:border-slate-200" title="Rename"><Edit3 size={16} /></button>
                                <button onClick={() => handleDeleteFile(file.id)} className="p-2 hover:bg-white dark:hover:bg-slate-800 shadow-sm rounded-xl text-slate-400 hover:text-red-500 transition-all border border-transparent hover:border-slate-200" title="Delete"><Trash2 size={16} /></button>
                              </div>
                              <button onClick={e => { e.stopPropagation(); const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); setContextMenu({ file, x: rect.left - 180, y: rect.bottom }); }} className="lg:hidden p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-slate-400"><MoreVertical size={18} /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                  {files.map(file => (
                    <div key={file.id} 
                      onClick={(e) => handleSingleClick(file, e)}
                      onDoubleClick={(e) => handleDoubleClick(file, e)}
                      className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 flex flex-col items-center gap-4 group hover:shadow-xl hover:shadow-blue-500/5 hover:-translate-y-1 transition-all cursor-pointer relative ${selectedFile?.id === file.id || selectedFileIds.has(file.id) ? 'ring-2 ring-blue-500' : ''}`}>
                      
                      <div className={`absolute top-3 left-3 transition-opacity z-10 ${selectedFileIds.has(file.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} onClick={e => e.stopPropagation()}>
                        <input type="checkbox" className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 bg-white dark:bg-slate-800 dark:border-slate-600 cursor-pointer shadow-sm"
                          checked={selectedFileIds.has(file.id)}
                          onChange={(e) => toggleSelection(e as any, file.id)}
                        />
                      </div>
                      
                      <FileIcon file={file} type={file.type} size="lg" isTg={file.isTgDrive} accountId={selectedAccountId} showThumbnails={userSettings?.showThumbnails !== false} />
                      <div className="text-center w-full">
                        <p className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate group-hover:text-blue-600 transition-colors">{file.name}</p>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">{file.size}</p>
                      </div>
                      <div className="absolute top-2 right-2 flex flex-col gap-1" onClick={e => e.stopPropagation()}>
                        <div className="hidden lg:flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-all">
                          {file.type !== 'folder' && <button onClick={() => setPreviewFile(file)} className="p-1.5 bg-white dark:bg-slate-900 shadow-md rounded-lg text-slate-400 hover:text-blue-600" title="Preview"><Eye size={14} /></button>}
                          <button onClick={() => handleRename(file.id, file.name)} className="p-1.5 bg-white dark:bg-slate-900 shadow-md rounded-lg text-slate-400 hover:text-blue-600" title="Rename"><Edit3 size={14} /></button>
                          {file.type !== 'folder' && <button onClick={() => handleDownload(file.id)} className="p-1.5 bg-white dark:bg-slate-900 shadow-md rounded-lg text-slate-400 hover:text-blue-600" title="Download"><Download size={14} /></button>}
                          {file.type !== 'folder' && <button onClick={() => handleShare(file.id)} className="p-1.5 bg-white dark:bg-slate-900 shadow-md rounded-lg text-slate-400 hover:text-blue-600" title="Share"><Share2 size={14} /></button>}
                          <button onClick={() => handleDeleteFile(file.id)} className="p-1.5 bg-white dark:bg-slate-900 shadow-md rounded-lg text-slate-400 hover:text-red-500" title="Delete"><Trash2 size={14} /></button>
                        </div>
                        <button onClick={e => { e.stopPropagation(); const rect = (e.target as HTMLElement).getBoundingClientRect(); setContextMenu({ file, x: rect.left, y: rect.bottom }); }} className="lg:hidden p-2 bg-white/50 dark:bg-slate-900/50 shadow-sm rounded-lg text-slate-500 hover:bg-white backdrop-blur-sm"><MoreVertical size={16} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        
        {/* Floating Action Bar */}
        <AnimatePresence>
          {selectedFileIds.size > 0 && (() => {
            const selectedFilesList = files.filter(f => selectedFileIds.has(f.id));
            const isSingleFile = selectedFilesList.length === 1 && selectedFilesList[0].type !== 'folder';
            const isSingleZip = isSingleFile && selectedFilesList[0].name.toLowerCase().endsWith('.zip');
            
            return (
              <motion.div initial={{ y: 100, opacity: 0, x: '-50%' }} animate={{ y: 0, opacity: 1, x: '-50%' }} exit={{ y: 100, opacity: 0, x: '-50%' }} transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="fixed bottom-4 sm:bottom-8 left-1/2 bg-slate-900 dark:bg-slate-800 text-white px-4 sm:px-6 py-3 sm:py-4 rounded-2xl shadow-2xl flex items-center gap-4 sm:gap-6 z-50 border border-slate-800 dark:border-slate-700 w-[95vw] sm:w-auto max-w-2xl overflow-x-auto no-scrollbar">
                <div className="flex items-center gap-3 pr-4 sm:pr-6 border-r border-slate-700 dark:border-slate-600 shrink-0">
                  <div className="w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-black shadow-inner shadow-blue-900/50">{selectedFileIds.size}</div>
                  <span className="text-sm font-bold uppercase tracking-widest text-slate-300 hidden sm:inline-block">Selected</span>
                </div>
                <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                  {!isSingleZip && (
                    <button onClick={() => handleBulkZipToCloud()} className="p-2 hover:bg-slate-800 dark:hover:bg-slate-700 rounded-xl text-slate-400 hover:text-white transition-all border border-transparent hover:border-slate-700 shrink-0" title="Make Zip"><FileArchive size={18} /></button>
                  )}
                  
                  {isSingleZip ? (
                    <button onClick={() => handleUnzip(selectedFilesList[0])} className="p-2 hover:bg-slate-800 dark:hover:bg-slate-700 rounded-xl text-slate-400 hover:text-white transition-all border border-transparent hover:border-slate-700 shrink-0" title="Unzip"><FileArchive size={18} /></button>
                  ) : (
                    <button onClick={!isSingleFile ? handleBulkZip : () => handleDownload(selectedFilesList[0].id)} className="p-2 hover:bg-slate-800 dark:hover:bg-slate-700 rounded-xl text-slate-400 hover:text-white transition-all border border-transparent hover:border-slate-700 shrink-0" title={!isSingleFile ? "Download as Zip" : "Download"}>
                      {!isSingleFile ? <Archive size={18} /> : <Download size={18} />}
                    </button>
                  )}
                  
                  <button onClick={() => handleOpenMoveModal('move')} className="p-2 hover:bg-slate-800 dark:hover:bg-slate-700 rounded-xl text-slate-400 hover:text-white transition-all border border-transparent hover:border-slate-700 shrink-0" title="Move"><Folder size={18} /></button>
                  <button onClick={() => handleOpenMoveModal('copy')} className="p-2 hover:bg-slate-800 dark:hover:bg-slate-700 rounded-xl text-slate-400 hover:text-white transition-all border border-transparent hover:border-slate-700 shrink-0" title="Copy"><Copy size={18} /></button>
                  <button onClick={handleBulkDelete} className="p-2 hover:bg-slate-800 dark:hover:bg-slate-700 rounded-xl text-slate-400 hover:text-red-400 transition-all border border-transparent hover:border-slate-700 shrink-0" title="Delete"><Trash2 size={18} /></button>
                  <div className="w-px h-6 bg-slate-700 dark:bg-slate-600 mx-1 sm:mx-2 shrink-0" />
                  <button onClick={() => setSelectedFileIds(new Set())} className="p-2 hover:bg-slate-800 dark:hover:bg-slate-700 rounded-xl text-slate-400 hover:text-white transition-all border border-transparent hover:border-slate-700 shrink-0" title="Clear Selection"><X size={18} /></button>
                </div>
              </motion.div>
            );
          })()}
        </AnimatePresence>
      </div>

        {/* File Details Panel */}
        <AnimatePresence>
          {selectedFile && (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelectedFile(null)} className="fixed inset-0 bg-black/20 dark:bg-black/50 z-50 lg:bg-transparent" />
              <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 400 }} className="fixed top-0 right-0 h-full w-full max-w-sm bg-white dark:bg-slate-800 shadow-2xl z-[60] border-l border-slate-200 dark:border-slate-700 flex flex-col">
                <div className="p-6 flex items-center justify-between border-b border-slate-100 dark:border-slate-700">
                  <h3 className="font-black text-slate-900 dark:text-white uppercase tracking-widest text-xs">File Details</h3>
                  <button onClick={() => setSelectedFile(null)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg text-slate-400"><X size={18} /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-8 space-y-8">
                  <div className="flex flex-col items-center text-center space-y-4">
                    <FileIcon file={selectedFile} type={selectedFile.type} size="lg" isTg={selectedFile.isTgDrive} accountId={selectedAccountId} showThumbnails={userSettings?.showThumbnails !== false} />
                    <div className="space-y-1">
                      <h4 className="font-bold text-slate-900 dark:text-white break-all pr-4">{selectedFile.name}</h4>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{selectedFile.size}</p>
                      {selectedFile.isTgDrive && <p className="text-[10px] font-black text-sky-500 uppercase tracking-widest flex items-center justify-center gap-1"><TelegramIcon size={10} /> Telegram Storage</p>}
                    </div>
                  </div>
                  <div className="space-y-6">
                    <DetailRow label="Type" value={selectedFile.type.toUpperCase()} />
                    <DetailRow label="Created" value={selectedFile.createdAt || '-'} />
                    <DetailRow label="Modified" value={selectedFile.modified} />
                    {selectedFile.folder !== undefined && <DetailRow label="Folder" value={selectedFile.folder || 'Root'} />}
                  </div>
                  <div className="pt-8 grid grid-cols-2 gap-4">
                    {selectedFile.type !== 'folder' && (
                      <button onClick={() => handleDownload(selectedFile.id)} className="flex flex-col items-center gap-2 p-4 bg-slate-50 dark:bg-slate-900 rounded-2xl hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-600 dark:text-slate-400 hover:text-blue-600 transition-all border border-slate-100 dark:border-slate-800">
                        <Download size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Download</span>
                      </button>
                    )}
                    <button onClick={() => handleRename(selectedFile.id, selectedFile.name)} className="flex flex-col items-center gap-2 p-4 bg-slate-50 dark:bg-slate-900 rounded-2xl hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-600 dark:text-slate-400 hover:text-blue-600 transition-all border border-slate-100 dark:border-slate-800">
                      <Edit3 size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Rename</span>
                    </button>
                    {selectedFile.type !== 'folder' && (
                      <button onClick={() => handleShare(selectedFile.id)} className="flex flex-col items-center gap-2 p-4 bg-slate-50 dark:bg-slate-900 rounded-2xl hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-600 dark:text-slate-400 hover:text-blue-600 transition-all border border-slate-100 dark:border-slate-800">
                        <Share2 size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Share</span>
                      </button>
                    )}
                    {['image', 'video', 'audio', 'pdf'].includes(selectedFile.type) && (
                      <button onClick={() => openPreview(selectedFile)} className="flex flex-col items-center gap-2 p-4 bg-slate-50 dark:bg-slate-900 rounded-2xl hover:bg-purple-50 dark:hover:bg-purple-900/20 text-slate-600 dark:text-slate-400 hover:text-purple-600 transition-all border border-slate-100 dark:border-slate-800">
                        <Eye size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Preview</span>
                      </button>
                    )}
                    {selectedFile.name.toLowerCase().endsWith('.zip') && (
                      <button onClick={() => handleUnzip(selectedFile)} className="flex flex-col items-center gap-2 p-4 bg-slate-50 dark:bg-slate-900 rounded-2xl hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-600 dark:text-slate-400 hover:text-blue-600 transition-all border border-slate-100 dark:border-slate-800">
                        <FileArchive size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Unzip</span>
                      </button>
                    )}
                    <button onClick={() => handleDeleteFile(selectedFile.id)} className="flex flex-col items-center gap-2 p-4 bg-slate-50 dark:bg-slate-900 rounded-2xl hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-600 dark:text-slate-400 hover:text-red-500 transition-all border border-slate-100 dark:border-slate-800">
                      <Trash2 size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Delete</span>
                    </button>
                  </div>
                  {/* Open in Google Drive / OneDrive link */}
                  {selectedFile.webViewLink && !selectedFile.isTgDrive && (
                    <div className="pt-2">
                      <a href={selectedFile.webViewLink} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 w-full py-4 bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 font-bold rounded-2xl hover:bg-blue-100 transition-all">
                        <ExternalLink size={18} /><span>Open in {selectedAccount?.accountType === 'onedrive' ? 'OneDrive' : 'Google Drive'}</span>
                      </a>
                    </div>
                  )}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Upload Progress */}
        <AnimatePresence>
          {uploadProgress && (
            <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[110] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl shadow-2xl flex items-center gap-4 min-w-[320px]">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isTgDrive ? 'bg-sky-50 dark:bg-sky-900/40 text-sky-500' : 'bg-blue-50 dark:bg-blue-900/40 text-blue-600'}`}>
                {isTgDrive ? <TelegramIcon size={20} /> : <Cloud size={20} className="animate-bounce" />}
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest">
                  <span className="text-slate-400 truncate max-w-[150px]">{uploadProgress.name}</span>
                  <span className="text-blue-600 dark:text-blue-400">{uploadProgress.percent}%</span>
                </div>
                <div className="h-2 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                  <div className={`h-full transition-all duration-300 ${isTgDrive ? 'bg-sky-500' : 'bg-blue-600'}`} style={{ width: `${uploadProgress.percent}%` }} />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Settings Modal */}
        <AnimatePresence>
          {isSettingsOpen && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsSettingsOpen(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
              <motion.div initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 10 }} transition={{ duration: 0.15 }} className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] shadow-2xl relative w-full max-w-lg space-y-8 border border-slate-200 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <div><h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">Settings</h2><p className="text-sm text-slate-500">Manage your sync and account preferences</p></div>
                  <button onClick={() => setIsSettingsOpen(false)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full text-slate-400"><X size={20} /></button>
                </div>
                <div className="space-y-6 max-h-[60vh] overflow-y-auto pr-2 no-scrollbar">
                  {!userProfile ? (
                    <div className="flex flex-col items-center justify-center p-12 space-y-4">
                      <RefreshCw size={24} className="animate-spin text-blue-500" />
                      <p className="text-xs font-bold text-slate-400">Loading profile...</p>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-4">
                        <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-[0.2em]">Identity & Access</h3>
                    <div className="p-5 bg-slate-50 dark:bg-slate-800/50 rounded-2xl space-y-4">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-indigo-600 rounded-xl flex items-center justify-center text-white font-black text-xl shadow-lg shadow-indigo-500/20">
                          {userProfile?.username?.[0]?.toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-black text-slate-900 dark:text-white">@{userProfile?.username}</p>
                          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Cloudyte ID</p>
                        </div>
                      </div>
                      
                      <div className="pt-4 border-t border-slate-100 dark:border-slate-700/50 space-y-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Linked Telegram accounts</p>
                        <div className="flex flex-wrap gap-2">
                          {userProfile?.tgIds?.length > 0 ? (
                            userProfile.tgIds.map((tid: string) => (
                              <span key={tid} className="px-3 py-1 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 text-[10px] font-black rounded-lg border border-indigo-100 dark:border-indigo-800">
                                ID: {tid}
                              </span>
                            ))
                          ) : (
                            <p className="text-[10px] text-slate-400 font-medium italic">No Telegram accounts linked</p>
                          )}
                        </div>
                        <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-xl border border-blue-100 dark:border-blue-800/40">
                          <p className="text-[10px] text-blue-600 dark:text-blue-400 font-bold">To link/unlink Telegram, use the bot's /login and /logout commands.</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4 mt-8">
                    <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-[0.2em]">Appearance & Behavior</h3>
                    <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/40 rounded-xl flex items-center justify-center text-purple-600"><Eye size={20} /></div>
                        <div><p className="text-sm font-bold dark:text-white">Image Thumbnails</p><p className="text-[10px] text-slate-500">Show inline previews for image files</p></div>
                      </div>
                      <button onClick={() => updateUserSettings({ showThumbnails: !(userSettings?.showThumbnails ?? true) })} className={`w-12 h-6 rounded-full transition-all relative ${(userSettings?.showThumbnails ?? true) ? 'bg-purple-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
                        <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${(userSettings?.showThumbnails ?? true) ? 'left-7' : 'left-1'}`} />
                      </button>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-[0.2em]">Sync & Automation</h3>
                    <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/40 rounded-xl flex items-center justify-center text-blue-600"><RefreshCw size={20} /></div>
                        <div><p className="text-sm font-bold dark:text-white">Auto-Mirror (Backup)</p><p className="text-[10px] text-slate-500">Mirror bot uploads to backup drive</p></div>
                      </div>
                      <button onClick={() => updateUserSettings({ backupEnabled: !userSettings?.backupEnabled })} className={`w-12 h-6 rounded-full transition-all relative ${userSettings?.backupEnabled ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
                        <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${userSettings?.backupEnabled ? 'left-7' : 'left-1'}`} />
                      </button>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold dark:text-slate-400 px-1">Backup Account</label>
                      <select value={userSettings?.backupAccId || ''} onChange={e => updateUserSettings({ backupAccId: e.target.value })} className="w-full bg-slate-100 dark:bg-slate-800 p-4 rounded-2xl text-sm font-bold dark:text-white outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="">Select Backup Account</option>
                        {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.accountType === 'tgdrive' ? `📡 TG Drive (${acc.channelId})` : acc.email}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-[0.2em]">Connected Accounts</h3>
                    <div className="space-y-3">
                      {accounts.map(acc => (
                        <div key={acc.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl group">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${acc.accountType === 'tgdrive' ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-500' : 'bg-slate-100 dark:bg-slate-900 text-slate-400'}`}>
                              {acc.accountType === 'tgdrive' ? <TelegramIcon size={18} /> : <HardDrive size={18} />}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-bold truncate dark:text-white">{acc.name || (acc.accountType === 'tgdrive' ? 'TG Drive' : 'Account')}</p>
                              <p className="text-[10px] text-slate-500 truncate">{acc.email}</p>
                            </div>
                          </div>
                          <button onClick={() => handleUnlink(acc.id)} className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all opacity-0 group-hover:opacity-100"><Trash2 size={16} /></button>
                        </div>
                      ))}
                      <button onClick={() => { setIsSettingsOpen(false); setLinkProviderModal(true); }} className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl text-sm font-bold text-slate-400 hover:text-blue-500 hover:border-blue-500 transition-all">
                        <Plus size={16} /><span>Link Another Account</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div initial={{ y: 50, opacity: 0, x: '-50%' }} animate={{ y: 0, opacity: 1, x: '-50%' }} exit={{ y: 50, opacity: 0, x: '-50%' }} className={`fixed bottom-10 left-1/2 z-[200] px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 backdrop-blur-md ${toast.type === 'success' ? 'bg-blue-600/90 text-white' : 'bg-red-600/90 text-white'}`}>
              {toast.type === 'success' ? <Check size={18} /> : <X size={18} />}
              <span className="font-bold text-sm tracking-tight">{toast.message}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Link Provider Modal */}
        <AnimatePresence>
          {linkProviderModal && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setLinkProviderModal(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
              <motion.div initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 10 }} transition={{ duration: 0.15 }} className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl relative w-full max-w-sm space-y-6 border border-slate-200 dark:border-slate-700">
                <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">Add Account</h2>
                <p className="text-slate-500 dark:text-slate-300 text-sm font-medium">Choose a service to connect</p>
                <div className="grid gap-3">
                  <button onClick={() => handleConnect('google')} className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-slate-50 dark:border-slate-700/50 hover:border-blue-500 bg-slate-50 dark:bg-slate-900/50 hover:bg-white transition-all text-left">
                    <div className="w-12 h-12 rounded-xl bg-white dark:bg-slate-800 flex items-center justify-center shadow-sm text-blue-600"><Cloud size={24} /></div>
                    <div><div className="font-black text-slate-900 dark:text-white">Google Drive</div><div className="text-[10px] uppercase tracking-wider font-black text-slate-400">Personal & Suite</div></div>
                  </button>
                  <button onClick={() => handleConnect('onedrive')} className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-slate-50 dark:border-slate-700/50 hover:border-blue-500 bg-slate-50 dark:bg-slate-900/50 hover:bg-white transition-all text-left">
                    <div className="w-12 h-12 rounded-xl bg-white dark:bg-slate-800 flex items-center justify-center shadow-sm text-blue-500"><LayoutGrid size={24} /></div>
                    <div><div className="font-black text-slate-900 dark:text-white">Microsoft OneDrive</div><div className="text-[10px] uppercase tracking-wider font-black text-slate-400">Outlook & Azure</div></div>
                  </button>
                  <button onClick={() => { setLinkProviderModal(false); setTgDriveModal(true); setTgRegisterError(''); setTgChannelInput(''); }} className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-slate-50 dark:border-slate-700/50 hover:border-sky-500 bg-slate-50 dark:bg-slate-900/50 hover:bg-white transition-all text-left">
                    <div className="w-12 h-12 rounded-xl bg-white dark:bg-slate-800 flex items-center justify-center shadow-sm text-sky-500"><TelegramIcon size={24} /></div>
                    <div><div className="font-black text-slate-900 dark:text-white">Telegram Channel</div><div className="text-[10px] uppercase tracking-wider font-black text-slate-400">Unlimited TG Storage</div></div>
                  </button>
                </div>
                <button onClick={() => setLinkProviderModal(false)} className="w-full py-4 text-sm font-black text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">Cancel</button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* TG Drive Register Modal */}
        <AnimatePresence>
          {tgDriveModal && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setTgDriveModal(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
              <motion.div initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 10 }} transition={{ duration: 0.15 }} className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl relative w-full max-w-sm space-y-6 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 bg-sky-50 dark:bg-sky-900/40 rounded-2xl flex items-center justify-center text-sky-500"><TelegramIcon size={28} /></div>
                  <div>
                    <h2 className="text-xl font-black text-slate-900 dark:text-white">Register TG Drive</h2>
                    <p className="text-sm text-slate-500">Connect a Telegram channel as storage</p>
                  </div>
                </div>
                <div className="bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800 rounded-2xl p-4 text-sm text-sky-700 dark:text-sky-300 font-medium space-y-1">
                  <p className="font-black text-sky-800 dark:text-sky-200">⚠️ Before registering:</p>
                  <p>1. Create a Telegram channel</p>
                  <p>2. Add your bot as an <strong>Administrator</strong></p>
                  <p>3. Copy the channel ID (e.g. <code className="bg-sky-100 dark:bg-sky-900 px-1 rounded">-1001234567890</code>)</p>
                </div>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase text-slate-400 px-1 tracking-widest">Drive Name</label>
                    <input
                      autoFocus
                      value={tgDriveNameInput}
                      onChange={e => setTgDriveNameInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRegisterTgDrive(); }}
                      placeholder="e.g. My Storage, Videos Channel"
                      className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-900/50 border-2 border-transparent focus:border-sky-500 rounded-2xl outline-none transition-all font-bold text-slate-700 dark:text-white shadow-inner"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase text-slate-400 px-1 tracking-widest">Channel ID or Username</label>
                    <input
                      value={tgChannelInput}
                      onChange={e => setTgChannelInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRegisterTgDrive(); }}
                      placeholder="-1001234567890 or @mychannel"
                      className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-900/50 border-2 border-transparent focus:border-sky-500 rounded-2xl outline-none transition-all font-bold text-slate-700 dark:text-white shadow-inner"
                    />
                  </div>
                </div>
                {tgRegisterError && <motion.p initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="text-red-500 text-xs font-bold px-2">{tgRegisterError}</motion.p>}
                <div className="flex gap-3">
                  <button onClick={() => { setTgDriveModal(false); setTgChannelInput(''); setTgDriveNameInput(''); setTgRegisterError(''); }} className="flex-1 py-4 text-slate-500 font-bold hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-2xl transition-all">Cancel</button>
                  <button onClick={handleRegisterTgDrive} disabled={tgRegisterLoading || !tgChannelInput.trim()} className="flex-1 bg-sky-500 text-white font-bold py-4 rounded-2xl hover:bg-sky-600 shadow-xl shadow-sky-500/20 transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                    {tgRegisterLoading ? <><RefreshCw size={18} className="animate-spin" /><span>Connecting...</span></> : <><Send size={18} /><span>Connect</span></>}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Prompt Modal */}
        <PromptModal
          isOpen={promptModal?.isOpen || false}
          title={promptModal?.title || ''}
          value={promptValue}
          onChange={setPromptValue}
          onConfirm={() => promptModal?.onConfirm(promptValue)}
          onCancel={promptModal?.onCancel || (() => {})}
        />

        {/* Confirm Modal */}
        <ConfirmModal
          isOpen={confirmModal?.isOpen || false}
          title={confirmModal?.title || ''}
          message={confirmModal?.message || ''}
          onConfirm={confirmModal?.onConfirm || (() => {})}
          onCancel={confirmModal?.onCancel || (() => {})}
        />

        {/* Context Menu */}
        <AnimatePresence>
          {contextMenu && (() => {
            const menuWidth = 200;
            const menuHeight = contextMenu.file.type === 'folder' ? 220 : 380;
            let top = contextMenu.y + 4;
            let left = contextMenu.x;
            
            if (left + menuWidth > window.innerWidth) left = window.innerWidth - menuWidth - 8;
            if (top + menuHeight > window.innerHeight) top = Math.max(8, contextMenu.y - menuHeight - 4);
            
            const isZip = contextMenu.file.name.toLowerCase().endsWith('.zip');
            
            return (
              <>
                <div className="fixed inset-0 z-[90]" onClick={() => setContextMenu(null)} />
                <motion.div initial={{ opacity: 0, scale: 0.95, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: -4 }} style={{ top, left }} className="fixed z-[100] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-y-auto max-h-[80vh] w-48 no-scrollbar">
                  <div className="p-3 border-b border-slate-100 dark:border-slate-700"><p className="text-xs font-black text-slate-500 dark:text-slate-400 truncate">{contextMenu.file.name}</p></div>
                  <div className="p-2 space-y-0.5">
                    {contextMenu.file.type !== 'folder' && <button onClick={() => { setPreviewFile(contextMenu.file); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-600 transition-all"><Eye size={16} /> Preview</button>}
                    {contextMenu.file.type !== 'folder' && <button onClick={() => { setSelectedFile(contextMenu.file); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"><Info size={16} /> Details</button>}
                    <button onClick={() => { handleRename(contextMenu.file.id, contextMenu.file.name); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"><Edit3 size={16} /> Rename</button>
                    {contextMenu.file.type !== 'folder' && <button onClick={() => { handleDownload(contextMenu.file.id); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"><Download size={16} /> Download</button>}
                    {contextMenu.file.type !== 'folder' && <button onClick={() => { handleShare(contextMenu.file.id); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"><Share2 size={16} /> Share</button>}
                    <button onClick={() => { setSelectedFileIds(new Set([contextMenu.file.id])); setContextMenu(null); handleOpenMoveModal('move'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"><Folder size={16} /> Move</button>
                    <button onClick={() => { setSelectedFileIds(new Set([contextMenu.file.id])); setContextMenu(null); handleOpenMoveModal('copy'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"><Copy size={16} /> Copy</button>
                    
                    {isZip ? (
                      <button onClick={() => { handleUnzip(contextMenu.file); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"><FileArchive size={16} /> Unzip</button>
                    ) : (
                      <>
                        <button onClick={() => { setContextMenu(null); handleBulkZipToCloud(new Set([contextMenu.file.id])); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"><FileArchive size={16} /> Make Zip</button>
                        {contextMenu.file.type === 'folder' && (
                          <button onClick={() => { setContextMenu(null); handleBulkZip(new Set([contextMenu.file.id])); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"><Archive size={16} /> Download as Zip</button>
                        )}
                      </>
                    )}

                    <button onClick={() => { handleDeleteFile(contextMenu.file.id); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"><Trash2 size={16} /> Delete</button>
                  </div>
                </motion.div>
              </>
            );
          })()}
        </AnimatePresence>

        {/* Preview Modal */}
        <AnimatePresence>
          {previewFile && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setPreviewFile(null)} className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
              <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className="relative z-10 bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <FileIcon file={previewFile} type={previewFile.type} isTg={previewFile.isTgDrive} accountId={selectedAccountId} />
                    <div className="overflow-hidden">
                      <p className="font-black text-slate-900 dark:text-white text-sm truncate">{previewFile.name}</p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{previewFile.size}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {['image', 'video', 'audio'].includes(previewFile.type) && <button onClick={() => openFullScreenGallery(previewFile)} className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition-all" title="Full Screen Gallery"><Maximize size={18} /></button>}
                    {previewFile.type !== 'folder' && <button onClick={() => handleDownload(previewFile.id)} className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition-all" title="Download"><Download size={18} /></button>}
                    {previewFile.type !== 'folder' && <button onClick={() => handleShare(previewFile.id)} className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition-all" title="Share"><Share2 size={18} /></button>}
                    <button onClick={() => setPreviewFile(null)} className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-white transition-all"><X size={18} /></button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950 min-h-[300px]">
                  {previewFile.type === 'image' ? (
                    <img src={previewFile.url || `/api/download/${selectedAccountId}/${previewFile.id}?preview=1`} alt={previewFile.name} className="max-w-full max-h-[60vh] rounded-xl shadow-lg object-contain cursor-pointer transition-transform hover:scale-[1.02]" onClick={() => openFullScreenGallery(previewFile)} />
                  ) : previewFile.type === 'video' ? (
                    <div className="relative group cursor-pointer max-w-full max-h-[60vh]">
                      <video controls autoPlay className="max-w-full max-h-[60vh] rounded-xl shadow-lg" src={previewFile.url || `/api/download/${selectedAccountId}/${previewFile.id}?preview=1`} />
                    </div>
                  ) : previewFile.type === 'audio' ? (
                    <audio controls autoPlay className="w-full max-w-md" src={previewFile.url || `/api/download/${selectedAccountId}/${previewFile.id}?preview=1`} />
                  ) : previewFile.type === 'pdf' && (previewFile.url || (previewFile.webViewLink && !previewFile.isTgDrive)) ? (
                    <iframe src={previewFile.url || previewFile.webViewLink} className="w-full h-[60vh] rounded-xl border border-slate-200 dark:border-slate-700" title={previewFile.name} />
                  ) : (
                    <div className="text-center space-y-6">
                      <div className="w-20 h-20 mx-auto"><FileIcon file={previewFile} type={previewFile.type} size="lg" isTg={previewFile.isTgDrive} accountId={selectedAccountId} /></div>
                      <div className="space-y-2">
                        <p className="font-bold text-slate-700 dark:text-slate-300">Preview not available in browser</p>
                        <p className="text-sm text-slate-400">Download the file to view it.</p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-3 justify-center">
                        {previewFile.webViewLink && !previewFile.isTgDrive && (
                          <a href={previewFile.webViewLink} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 px-6 py-3 bg-blue-50 dark:bg-blue-900/40 text-blue-600 font-bold rounded-2xl hover:bg-blue-100 transition-all">
                            <ExternalLink size={16} /> Open in Drive
                          </a>
                        )}
                        <button onClick={() => handleDownload(previewFile.id)} className="flex items-center justify-center gap-2 px-6 py-3 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold rounded-2xl hover:bg-slate-200 transition-all">
                          <Download size={16} /> Download
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Move/Copy Modal */}
        <AnimatePresence>
          {isMoveModalOpen && (
            <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsMoveModalOpen(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
              <motion.div initial={{ scale: 0.95, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 20 }} className="relative z-10 bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl w-full max-w-lg overflow-hidden border border-slate-200 dark:border-slate-800 flex flex-col h-[70vh]">
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
                  <h3 className="font-black text-slate-900 dark:text-white text-lg capitalize">{modalAction} {selectedFileIds.size} file(s)</h3>
                  <button onClick={() => setIsMoveModalOpen(false)} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-white transition-all"><X size={18} /></button>
                </div>
                
                <div className="flex px-6 border-b border-slate-100 dark:border-slate-800 shrink-0">
                  <button onClick={() => { setMoveModalTab('current'); if(selectedAccountId) navigateMoveAccount(selectedAccountId); }} className={`py-3 px-4 font-bold text-sm border-b-2 transition-all ${moveModalTab === 'current' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>Current location</button>
                  <button onClick={() => setMoveModalTab('all')} className={`py-3 px-4 font-bold text-sm border-b-2 transition-all ${moveModalTab === 'all' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>All locations</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 bg-slate-50 dark:bg-slate-950/50">
                  {moveLoading ? (
                    <div className="flex items-center justify-center h-full"><RefreshCw className="animate-spin text-slate-400" size={24} /></div>
                  ) : moveModalTab === 'all' ? (
                    <div className="space-y-2">
                      {accounts.map(acc => (
                        <div key={acc.id} onClick={() => navigateMoveAccount(acc.id)} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white dark:hover:bg-slate-800 cursor-pointer border border-transparent hover:border-slate-200 dark:hover:border-slate-700 transition-all">
                          <div className="w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 flex items-center justify-center shrink-0">
                            {acc.accountType === 'google' ? <HardDrive size={18} /> : acc.accountType === 'onedrive' ? <Cloud size={18} /> : <Share2 size={18} />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-slate-700 dark:text-slate-300 truncate">{acc.accountType === 'tgdrive' ? `TG Drive: ${acc.channelId}` : acc.email}</p>
                            <p className="text-xs text-slate-400 font-medium uppercase tracking-widest">{acc.accountType}</p>
                          </div>
                          <ChevronRight size={18} className="text-slate-400" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {moveTargetFolderId !== 'root' && (
                        <div onClick={() => navigateMoveFolder('root')} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white dark:hover:bg-slate-800 cursor-pointer border border-transparent hover:border-slate-200 dark:hover:border-slate-700 transition-all text-slate-600 dark:text-slate-400 font-bold">
                          <ArrowLeft size={18} /> Back to Root
                        </div>
                      )}
                      {moveFoldersList.length === 0 ? (
                        <div className="text-center p-8 text-slate-500 font-medium">No folders here.</div>
                      ) : (
                        moveFoldersList.map(f => (
                          <div key={f.id} onClick={() => navigateMoveFolder(f.id)} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white dark:hover:bg-slate-800 cursor-pointer border border-transparent hover:border-slate-200 dark:hover:border-slate-700 transition-all">
                            <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-900/20 text-amber-500 flex items-center justify-center shrink-0">
                              <Folder size={18} fill="currentColor" />
                            </div>
                            <p className="font-bold text-slate-700 dark:text-slate-300 truncate flex-1">{f.name}</p>
                            <ChevronRight size={18} className="text-slate-400" />
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <div className="px-6 py-4 bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 shrink-0 flex items-center justify-between">
                  <button onClick={() => setIsMoveModalOpen(false)} className="px-5 py-2.5 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">Cancel</button>
                  <button onClick={handleMoveConfirm} disabled={moveLoading || (moveModalTab === 'all' && moveTargetAccountId === selectedAccountId)} className="px-6 py-2.5 rounded-xl font-bold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-900/20 capitalize">
                    {modalAction} Here
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Full Screen Gallery Modal */}
        <AnimatePresence>
          {fullScreenGalleryFile && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[200] flex items-center justify-center bg-black/95 backdrop-blur-xl" onClick={() => setFullScreenGalleryFile(null)} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
              
              <div className="absolute top-4 right-4 z-50">
                <button onClick={(e) => { e.stopPropagation(); setFullScreenGalleryFile(null); }} className="p-3 bg-white/10 hover:bg-white/20 text-white rounded-full backdrop-blur-md transition-all">
                  <X size={24} />
                </button>
              </div>

              <div className="absolute top-4 left-4 z-50 text-white/50 text-sm font-bold tracking-widest uppercase bg-black/40 px-4 py-2 rounded-xl backdrop-blur-md">
                {currentGalleryIndex + 1} / {mediaFiles.length}
              </div>

              {hasPrevMedia && (
                <button onClick={(e) => navigateGallery('prev', e)} className="absolute left-4 z-50 p-4 bg-white/5 hover:bg-white/10 text-white rounded-full backdrop-blur-md transition-all hidden sm:block">
                  <ChevronLeft size={32} />
                </button>
              )}

              <div className="relative w-full h-full flex flex-col items-center justify-center" onClick={e => e.stopPropagation()}>
                {fullScreenGalleryFile.type === 'image' && (
                  <img src={getMediaUrl(fullScreenGalleryFile)} className="w-full h-full object-contain pointer-events-none" alt={fullScreenGalleryFile.name} />
                )}
                {fullScreenGalleryFile.type === 'video' && (
                  <video src={getMediaUrl(fullScreenGalleryFile)} controls autoPlay className="w-full h-full" />
                )}
                {fullScreenGalleryFile.type === 'audio' && (
                  <audio src={getMediaUrl(fullScreenGalleryFile)} controls autoPlay className="w-full max-w-xl shadow-2xl" />
                )}
              </div>

              {hasNextMedia && (
                <button onClick={(e) => navigateGallery('next', e)} className="absolute right-4 z-50 p-4 bg-white/5 hover:bg-white/10 text-white rounded-full backdrop-blur-md transition-all hidden sm:block">
                  <ChevronRight size={32} />
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Admin Panel Modal */}
        <AnimatePresence>
          {isAdminPanelOpen && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 lg:p-12 overflow-hidden">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsAdminPanelOpen(false)} className="absolute inset-0 bg-slate-950/80 backdrop-blur-xl" />
              <motion.div initial={{ scale: 0.95, opacity: 0, y: 30 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 30 }} className="relative z-10 bg-white dark:bg-slate-900 rounded-[3rem] shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden border border-slate-200 dark:border-slate-800">
                <div className="px-10 py-8 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-blue-600 rounded-2xl shadow-xl shadow-blue-500/20 flex items-center justify-center text-white"><Settings size={24} /></div>
                    <div>
                      <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">Admin Control Center</h2>
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Global Platform Management</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => {
                      setIsAdminPanelOpen(false);
                      setSelectedAdminUserId(null);
                      setSelectedAdminUserDetails(null);
                    }} 
                    className="p-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-all active:scale-95"
                  >
                    <X size={24} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-10 no-scrollbar space-y-12">
                  {/* Stats Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {[
                      { label: 'Total Users', value: adminStats?.totalUsers || '0', sub: 'Active accounts', color: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' },
                      { label: 'Linked Accounts', value: adminStats?.totalAccounts || '0', sub: 'Cloud endpoints', color: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600' },
                      { label: 'Managed Files', value: adminStats?.totalFiles || '0', sub: 'Synched resources', color: 'bg-amber-50 dark:bg-amber-900/20 text-amber-600' },
                    ].map((stat, i) => (
                      <div key={i} className="p-8 bg-slate-50 dark:bg-slate-800/50 rounded-[2.5rem] border border-slate-100 dark:border-slate-700/50">
                        <p className="text-xs font-black uppercase text-slate-400 tracking-widest mb-1">{stat.label}</p>
                        <p className="text-4xl font-black text-slate-900 dark:text-white mb-2">{stat.value}</p>
                        <p className="text-xs font-bold text-slate-500">{stat.sub}</p>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
                    {/* Access Controls */}
                    <div className="space-y-6">
                      <h3 className="text-lg font-black text-slate-900 dark:text-white pb-4 border-b border-slate-100 dark:border-slate-800 tracking-tight">Access Permissions</h3>
                      <div className="space-y-4">
                        {[
                          { key: 'registrationEnabled', label: 'Global Registration', sub: 'Allow new user signups anywhere' },
                          { key: 'webRegistrationEnabled', label: 'Web Registration', sub: 'Allow signups via browser' },
                          { key: 'botRegistrationEnabled', label: 'Bot Registration', sub: 'Allow signups via Telegram bot' },
                        ].map((reg) => (
                          <div key={reg.key} className="flex items-center justify-between p-6 bg-slate-50 dark:bg-slate-800/40 rounded-3xl group hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-all border border-transparent hover:border-slate-200 dark:hover:border-slate-700">
                            <div>
                              <p className="font-bold text-slate-900 dark:text-white">{reg.label}</p>
                              <p className="text-xs text-slate-500 font-medium">{reg.sub}</p>
                            </div>
                            <button 
                              onClick={() => toggleRegSetting(reg.key, !adminRegSettings?.[reg.key])}
                              className={`w-14 h-8 rounded-full relative transition-all duration-300 outline-none ${adminRegSettings?.[reg.key] ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'}`}
                            >
                              <div className={`absolute top-1 w-6 h-6 rounded-full bg-white transition-all shadow-md ${adminRegSettings?.[reg.key] ? 'right-1' : 'left-1'}`} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* User Management Section */}
                    <div className="space-y-6">
                      <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                        <h3 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">
                          {selectedAdminUserId ? 'User Dossier' : 'Active Users'}
                        </h3>
                        {selectedAdminUserId && (
                          <button 
                            onClick={() => { setSelectedAdminUserId(null); setSelectedAdminUserDetails(null); }}
                            className="text-xs font-black uppercase text-blue-600 dark:text-blue-400 flex items-center gap-1 hover:underline"
                          >
                            <ArrowLeft size={12} /> Back to list
                          </button>
                        )}
                      </div>

                      <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 no-scrollbar">
                        {selectedAdminUserId ? (
                          loadingUserDetails ? (
                            <div className="flex flex-col items-center justify-center p-12 space-y-4">
                              <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
                              <p className="text-sm font-bold text-slate-400">Retrieving encrypted data...</p>
                            </div>
                          ) : selectedAdminUserDetails && (
                            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
                              <div className="flex items-center gap-6 p-8 bg-slate-50 dark:bg-slate-800/60 rounded-[2.5rem] border border-slate-100 dark:border-slate-700">
                                <div className="w-20 h-20 rounded-[1.5rem] bg-blue-600 flex items-center justify-center text-white text-3xl font-black">
                                  {selectedAdminUserDetails.user.username[0].toUpperCase()}
                                </div>
                                <div className="flex-1">
                                  <h4 className="text-2xl font-black text-slate-900 dark:text-white">@{selectedAdminUserDetails.user.username}</h4>
                                  <p className="text-sm font-bold text-slate-500">Member since {new Date(selectedAdminUserDetails.user.createdAt).toLocaleDateString()}</p>
                                  <div className="flex gap-2 mt-3">
                                    <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${selectedAdminUserDetails.user.isActive ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                                      {selectedAdminUserDetails.user.isActive ? 'ACTIVE' : 'DISABLED'}
                                    </span>
                                    {selectedAdminUserDetails.user.isAdmin && (
                                      <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-600 text-[10px] font-black uppercase">SYSTEM ADMIN</span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-4">
                                <div className="p-6 bg-slate-50 dark:bg-slate-800/40 rounded-3xl">
                                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Linked Devices</p>
                                  <p className="text-xl font-black text-slate-900 dark:text-white">{selectedAdminUserDetails.user.tgIds?.length || 0}</p>
                                  <p className="text-[10px] text-slate-500 font-bold">Telegram Accounts</p>
                                </div>
                                <div className="p-6 bg-slate-50 dark:bg-slate-800/40 rounded-3xl">
                                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Stored Assets</p>
                                  <p className="text-xl font-black text-slate-900 dark:text-white">{selectedAdminUserDetails.stats.fileCount}</p>
                                  <p className="text-[10px] text-slate-500 font-bold">Files across drives</p>
                                </div>
                              </div>

                              <div className="space-y-4">
                                <h5 className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Linked Cloud Drives</h5>
                                <div className="space-y-2">
                                  {selectedAdminUserDetails.accounts.map((acc: any) => (
                                    <div key={acc._id} className="p-4 bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 flex items-center justify-between">
                                      <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-lg bg-slate-50 dark:bg-slate-900 flex items-center justify-center text-slate-400">
                                          {acc.accountType === 'google' ? <HardDrive size={14} /> : acc.accountType === 'onedrive' ? <Cloud size={14} /> : <Share2 size={14} />}
                                        </div>
                                        <div>
                                          <p className="text-xs font-bold text-slate-900 dark:text-white">{acc.email || acc.channelId}</p>
                                          <p className="text-[10px] text-slate-400 font-bold uppercase">{acc.accountType} {acc.isDefault && '• DEFAULT'}</p>
                                        </div>
                                      </div>
                                      <p className="text-[10px] font-bold text-slate-400">Linked {new Date(acc.linkedAt).toLocaleDateString()}</p>
                                    </div>
                                  ))}
                                  {selectedAdminUserDetails.accounts.length === 0 && (
                                    <div className="p-8 text-center bg-slate-50 dark:bg-slate-800/20 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800">
                                      <p className="text-xs font-bold text-slate-400 italic">No drives connected yet</p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          )
                        ) : (
                          usersList.map((u: any) => (
                            <div 
                              key={u.id} 
                              onClick={() => fetchUserDetails(u.id)}
                              className="p-5 bg-white dark:bg-slate-800 rounded-2xl flex items-center gap-4 hover:shadow-lg transition-all border border-slate-100 dark:border-slate-700 shadow-sm cursor-pointer group"
                            >
                              <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black uppercase transition-transform group-hover:scale-110 ${u.isActive ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'}`}>
                                {u.username?.[0] || '?'}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold text-slate-900 dark:text-white truncate">@{u.username}</p>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{u.accountCount} Drives • {u.isActive ? 'Active' : 'Disabled'}</p>
                              </div>
                              <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                                {!u.isAdmin && (
                                  <>
                                    <button onClick={() => handleToggleUser(u.id, u.isActive)} className={`p-2 rounded-lg transition-all ${u.isActive ? 'text-amber-500 hover:bg-amber-50' : 'text-emerald-500 hover:bg-emerald-50'}`} title={u.isActive ? 'Disable' : 'Enable'}>
                                      <LogOut size={16} />
                                    </button>
                                    <button onClick={() => handleDeleteUser(u.id)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-all" title="Delete Permanent">
                                      <Trash2 size={16} />
                                    </button>
                                  </>
                                )}
                                {u.isAdmin && (
                                  <div className="px-2 py-1 bg-blue-50 dark:bg-blue-900/20 text-blue-600 text-[8px] font-black uppercase rounded-lg border border-blue-100 dark:border-blue-800">Admin</div>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

