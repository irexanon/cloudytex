import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Plus, Search, Trash2, RotateCcw, Edit3, Download, Folder, FolderPlus, File as FileIconLucide, ChevronRight, ChevronLeft, ChevronDown, 
  LogOut, Cloud, HardDrive, X, RefreshCw, Check, CheckCircle2, LayoutGrid, 
  List as ListIcon, Info, Moon, Sun, Eye, Settings, MoreVertical, 
  Share2, Video, Send, ArrowLeft, ArrowUp, ArrowDown, ExternalLink, Archive, FileArchive, Maximize, Copy, Activity,
  Upload, ArrowLeftRight, Shield, SlidersHorizontal, AlertTriangle, UploadCloud, FolderOpen, Pause, Play, ChevronUp
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

import ConfirmModal from "./components/modals/ConfirmModal";
import PromptModal from "./components/modals/PromptModal";
import ShareModal from "./components/modals/ShareModal";
import SecuritySettingsTabs from "./components/modals/SecuritySettingsTabs";
import JobsDrawer from "./components/modals/JobsDrawer";
import AdminObservabilityPanel from "./components/modals/AdminObservabilityPanel";
import DetailRow from "./components/DetailRow";
import FileIcon, { renderFileTypeGlyph } from "./components/FileIcon";
import TelegramIcon from "./components/Icons/TelegramIcon";
import {
  parseAppLocation,
  buildAppUrl,
  type AppPage,
  type AppRouteState,
  type BreadcrumbItem,
  type OverlayModal,
} from "./router";

export default function App() {
  const initialRouteRef = useRef<AppRouteState>(parseAppLocation());
  const initialRoute = initialRouteRef.current;
  const initialHistoryPath = Array.isArray((window.history.state as any)?.path)
    ? ((window.history.state as any).path as BreadcrumbItem[])
    : null;

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
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(initialRoute.accountId);
  const [files, setFiles]                 = useState<any[]>([]);
  const [selectedFile, setSelectedFile]   = useState<any | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(initialRoute.folderId);
  const [isTrashView, setIsTrashView]     = useState<boolean>(initialRoute.trash);
  const [path, setPath]                   = useState<BreadcrumbItem[]>(() => {
    if (initialHistoryPath && initialHistoryPath.length > 0) return initialHistoryPath;
    if (initialRoute.folderId) {
      return [{ id: null, name: 'My Drive' }, { id: initialRoute.folderId, name: 'Folder' }];
    }
    return [{ id: null, name: 'My Drive' }];
  });
  const [searchQuery, setSearchQuery]     = useState(initialRoute.search);
  const [debouncedSearch, setDebouncedSearch] = useState(initialRoute.search);
  const [viewMode, setViewMode]           = useState<'list' | 'grid'>('list');
  const [isDrivesExpanded, setIsDrivesExpanded] = useState(false);
  const [sortOrder, setSortOrder]         = useState<'asc' | 'desc'>('asc');
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [runningJobsCount, setRunningJobsCount] = useState(0);
  const [runningJobsPct, setRunningJobsPct] = useState(0);
  const [userSettings, setUserSettings]   = useState<any>(null);
  const [linkProviderModal, setLinkProviderModal] = useState(initialRoute.modal === 'link-account');
  const [tgDriveModal, setTgDriveModal]   = useState(initialRoute.modal === 'tg-drive');
  const [tgChannelInput, setTgChannelInput] = useState('');
  const [tgDriveNameInput, setTgDriveNameInput] = useState('');
  const [tgRegisterLoading, setTgRegisterLoading] = useState(false);
  const [tgRegisterError, setTgRegisterError] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(initialRoute.page === 'settings');
  const [uploadProgress, setUploadProgress] = useState<{
    name: string;
    percent: number;
    status?: 'preparing' | 'uploading' | 'paused' | 'completing' | 'completed' | 'failed' | 'cancelled';
    sessionId?: string | null;
  } | null>(null);
  const [uploadQueue, setUploadQueue] = useState<Array<{
    id: string;
    file: File;
    name: string;
    size: number;
    percent: number;
    status: 'queued' | 'preparing' | 'uploading' | 'paused' | 'completing' | 'completed' | 'failed' | 'cancelled';
    error?: string;
    sessionId?: string | null;
  }>>([]);
  const [isUploadQueueMinimized, setIsUploadQueueMinimized] = useState(false);
  const [uploadMenuAnchor, setUploadMenuAnchor] = useState<'rail' | 'mobile' | null>(null);
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);
  const folderUploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadControlRef = useRef<{
    paused: boolean;
    cancelled: boolean;
    activeSessionId: string | null;
    activeXhr: XMLHttpRequest | null;
    resumeResolver: (() => void) | null;
  }>({ paused: false, cancelled: false, activeSessionId: null, activeXhr: null, resumeResolver: null });
  const [promptModal, setPromptModal]     = useState<{ isOpen: boolean; title: string; defaultValue: string; onConfirm: (val: string) => void; onCancel: () => void } | null>(null);
  const [confirmModal, setConfirmModal]   = useState<{ isOpen: boolean; title: string; message: string; onConfirm: () => void; onCancel: () => void } | null>(null);
  const [promptValue, setPromptValue]     = useState('');
  const [contextMenu, setContextMenu]     = useState<{ file: any; x: number; y: number } | null>(null);
  const [previewFile, setPreviewFile]     = useState<any | null>(null);
  const [fullScreenGalleryFile, setFullScreenGalleryFile] = useState<any | null>(null);
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(initialRoute.modal === 'move' || initialRoute.modal === 'copy');
  const [modalAction, setModalAction] = useState<'move' | 'copy'>(initialRoute.modal === 'copy' ? 'copy' : 'move');
  const [moveTargetAccountId, setMoveTargetAccountId] = useState<string | null>(null);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string>('root');
  const [moveFoldersList, setMoveFoldersList] = useState<any[]>([]);
  const [movePath, setMovePath] = useState<{ id: string; name: string }[]>([{ id: 'root', name: 'Root' }]);
  const [moveInlineFolderMode, setMoveInlineFolderMode] = useState(false);
  const [moveInlineFolderName, setMoveInlineFolderName] = useState('');
  const [moveCreatingFolder, setMoveCreatingFolder] = useState(false);
  const [moveLoading, setMoveLoading] = useState(false);
  const [openAccountMenuId, setOpenAccountMenuId] = useState<string | null>(null);
  const [searchFilterType, setSearchFilterType] = useState<'all' | 'folder' | 'pdf' | 'image' | 'video' | 'doc'>('all');
  const [showSearchFilters, setShowSearchFilters] = useState(false);
  const [welcomeProvider, setWelcomeProvider] = useState<'google' | 'onedrive' | 'tgdrive'>('google');
  const [toast, setToast]                 = useState<{ message: string; type: 'success' | 'error'; actionLabel?: string; onAction?: () => void } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isLoggingIn, setIsLoggingIn]     = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(initialRoute.authMode === 'register');
  const [regSettings, setRegSettings]     = useState<any>(null);
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(initialRoute.page === 'admin');
  const [adminStats, setAdminStats]       = useState<any>(null);
  const [adminRegSettings, setAdminRegSettings] = useState<any>(null);
  const [usersList, setUsersList]         = useState<any[]>([]);
  const [selectedAdminUserId, setSelectedAdminUserId] = useState<string | null>(initialRoute.adminUserId);
  const [selectedAdminUserDetails, setSelectedAdminUserDetails] = useState<any>(null);
  const [loadingUserDetails, setLoadingUserDetails] = useState(false);

  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [shareTargetFile, setShareTargetFile] = useState<any | null>(null);
  const [settingsTab, setSettingsTab] = useState<'general' | 'sessions' | 'tokens' | 'shares'>(initialRoute.settingsTab);
  const [isJobsDrawerOpen, setIsJobsDrawerOpen] = useState(initialRoute.page === 'jobs');
  const [adminTab, setAdminTab] = useState<'overview' | 'metrics' | 'audit'>(initialRoute.adminTab);

  const pathRef = useRef<BreadcrumbItem[]>(path);
  pathRef.current = path;
  const pendingUrlOverlayRef = useRef<{
    preview?: string | null;
    gallery?: string | null;
    share?: string | null;
    info?: string | null;
  }>({
    preview: initialRoute.previewFileId,
    gallery: initialRoute.galleryFileId,
    share: initialRoute.shareFileId,
    info: initialRoute.infoFileId,
  });

  const buildCurrentRouteState = useCallback((overrides: Partial<AppRouteState> = {}): AppRouteState => {
    const inferredPage: AppPage =
      overrides.page ??
      (isAdminPanelOpen ? 'admin' : isSettingsOpen ? 'settings' : isJobsDrawerOpen ? 'jobs' : 'drive');
    const inferredModal: OverlayModal =
      overrides.modal !== undefined
        ? overrides.modal
        : linkProviderModal
        ? 'link-account'
        : tgDriveModal
        ? 'tg-drive'
        : isMoveModalOpen
        ? modalAction
        : null;
    return {
      authMode: null,
      page: inferredPage,
      accountId: selectedAccountId,
      folderId: currentFolderId,
      trash: isTrashView,
      settingsTab,
      adminTab,
      adminUserId: selectedAdminUserId,
      search: debouncedSearch,
      previewFileId: previewFile?.id || null,
      galleryFileId: fullScreenGalleryFile?.id || null,
      shareFileId: shareTargetFile?.id || null,
      infoFileId: selectedFile?.id || null,
      modal: inferredModal,
      ...overrides,
    };
  }, [
    isAdminPanelOpen,
    isSettingsOpen,
    isJobsDrawerOpen,
    linkProviderModal,
    tgDriveModal,
    isMoveModalOpen,
    modalAction,
    selectedAccountId,
    currentFolderId,
    isTrashView,
    settingsTab,
    adminTab,
    selectedAdminUserId,
    debouncedSearch,
    previewFile?.id,
    fullScreenGalleryFile?.id,
    shareTargetFile?.id,
    selectedFile?.id,
  ]);

  const syncUrl = useCallback(
    (
      overrides: Partial<AppRouteState> = {},
      mode: 'push' | 'replace' = 'push',
      breadcrumbPath?: BreadcrumbItem[]
    ) => {
      const nextState = buildCurrentRouteState(overrides);
      const nextUrl = buildAppUrl(nextState);
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      const historyPayload = { path: breadcrumbPath ?? pathRef.current };
      if (nextUrl === currentUrl && mode === 'push') {
        window.history.replaceState(historyPayload, '', nextUrl);
        return;
      }
      if (mode === 'replace') {
        window.history.replaceState(historyPayload, '', nextUrl);
      } else {
        window.history.pushState(historyPayload, '', nextUrl);
      }
    },
    [buildCurrentRouteState]
  );

  const openFileInspector = useCallback(
    (file: any | null) => {
      setSelectedFile(file);
      syncUrl({ infoFileId: file?.id || null }, file ? 'push' : 'push');
    },
    [syncUrl]
  );

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
      else openFileInspector(file);
      return;
    }
    if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    clickTimeoutRef.current = setTimeout(() => {
      openFileInspector(file);
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

  const showToast = useCallback((
    message: string,
    type: 'success' | 'error' = 'success',
    action?: { label: string; onClick: () => void }
  ) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type, actionLabel: action?.label, onAction: action?.onClick });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, action ? 4800 : 3200);
  }, []);

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
      const list = Array.isArray(data) ? data : [];
      setAccounts(list);
      if (list.length > 0) {
        const matched = selectedAccountId ? list.find((a: any) => a.id === selectedAccountId) : null;
        const targetAcc = matched || list.find((a: any) => a.isDefault) || list[0];
        if (!selectedAccountId || !matched) {
          setSelectedAccountId(targetAcc.id);
          const rootLabel = targetAcc.accountType === 'tgdrive' ? '📡 TG Drive' : 'My Drive';
          const initialPath: BreadcrumbItem[] = [{ id: null, name: rootLabel }];
          setPath(initialPath);
          const parsed = parseAppLocation();
          if (parsed.page === 'drive' && (!parsed.accountId || !matched)) {
            syncUrl({ page: 'drive', accountId: targetAcc.id, folderId: null, trash: false }, 'replace', initialPath);
          } else {
            syncUrl({ accountId: targetAcc.id }, 'replace');
          }
        } else {
          const rootLabel = targetAcc.accountType === 'tgdrive' ? '📡 TG Drive' : 'My Drive';
          setPath((prev) =>
            prev.length > 0 && prev[0].id === null && prev[0].name !== rootLabel
              ? [{ id: null, name: rootLabel }, ...prev.slice(1)]
              : prev
          );
        }
      }
    } catch { /* ignore */ } finally { setLoading(false); clearTimeout(tId); }
  }, [getAuthHeaders, selectedAccountId, isAuthenticated, syncUrl]);

  const fetchFiles = useCallback(async (accId: string, foldId: string | null, search?: string, trashMode = isTrashView) => {
    try {
      setLoading(true);
      if (trashMode) {
        const res = await fetch(`/api/trash?accountId=${encodeURIComponent(accId)}`, { headers: getAuthHeaders() });
        if (res.status === 401) { setIsAuthenticated(false); setAuthToken(null); localStorage.removeItem('cloudyte_token'); return; }
        const data = await res.json();
        const list = Array.isArray(data) ? data : [];
        const q = (search || '').trim().toLowerCase();
        setFiles(q ? list.filter((f: any) => String(f.name || '').toLowerCase().includes(q)) : list);
        return;
      }
      const params = new URLSearchParams();
      params.append('accountId', accId);
      if (foldId) params.append('folderId', foldId);
      if (search) params.append('search', search);
      const res = await fetch(`/api/files?${params.toString()}`, { headers: getAuthHeaders() });
      if (res.status === 401) { setIsAuthenticated(false); setAuthToken(null); localStorage.removeItem('cloudyte_token'); return; }
      const data = await res.json();
      setFiles(Array.isArray(data) ? data : []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [getAuthHeaders, isTrashView]);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      if (isAuthenticated && !isInitializing) {
        const cur = parseAppLocation();
        if ((cur.search || '') !== searchQuery.trim()) {
          syncUrl({ search: searchQuery.trim() }, 'replace');
        }
      }
    }, 400);
    return () => clearTimeout(t);
  }, [searchQuery, isAuthenticated, isInitializing, syncUrl]);
  useEffect(() => { if (selectedAccountId) fetchFiles(selectedAccountId, currentFolderId, debouncedSearch, isTrashView); }, [selectedAccountId, currentFolderId, debouncedSearch, isTrashView, fetchFiles]);

  // Keep /login and /register URLs in sync when unauthenticated
  useEffect(() => {
    if (isInitializing || isAuthenticated) return;
    const expected = isRegisterMode ? '/register' : '/login';
    if (window.location.pathname !== expected) {
      window.history.replaceState(null, '', expected);
    }
  }, [isAuthenticated, isInitializing, isRegisterMode]);

  // ── Account selection: reset path & folder ────────────────────────────────
  const selectAccount = (id: string, openTrash = false) => {
    const acc = accounts.find(a => a.id === id);
    const nextPath: BreadcrumbItem[] = [{ id: null, name: acc?.accountType === 'tgdrive' ? `📡 TG Drive` : 'My Drive' }];
    setSelectedAccountId(id);
    setIsTrashView(openTrash);
    setCurrentFolderId(null);
    setPath(nextPath);
    setSearchQuery('');
    setDebouncedSearch('');
    setSelectedFile(null);
    setSelectedFileIds(new Set());
    setIsSettingsOpen(false);
    setIsJobsDrawerOpen(false);
    setIsAdminPanelOpen(false);
    syncUrl(
      {
        page: 'drive',
        accountId: id,
        folderId: null,
        trash: openTrash,
        search: '',
        previewFileId: null,
        galleryFileId: null,
        shareFileId: null,
        infoFileId: null,
        modal: null,
      },
      'push',
      nextPath
    );
  };

  const toggleTrashView = (nextState?: boolean) => {
    const onAnotherPage = isSettingsOpen || isJobsDrawerOpen || isAdminPanelOpen;
    const target = typeof nextState === 'boolean' ? nextState : (onAnotherPage ? true : !isTrashView);
    setIsSettingsOpen(false);
    setIsJobsDrawerOpen(false);
    setIsAdminPanelOpen(false);
    setIsTrashView(target);
    setSelectedFile(null);
    setSelectedFileIds(new Set());
    syncUrl({
      page: 'drive',
      trash: target,
      folderId: target ? null : currentFolderId,
      infoFileId: null,
      previewFileId: null,
      galleryFileId: null,
      shareFileId: null,
    });
  };

  // ── Connect Google / OneDrive ─────────────────────────────────────────────
  const handleConnect = async (type: 'google' | 'onedrive') => {
    setLinkProviderModal(false);
    syncUrl({ modal: null });
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
      syncUrl({ modal: null });
      setTgChannelInput('');
      setTgDriveNameInput('');
      showToast(`✅ TG Drive "${data.name}" registered!`);
      fetchAccounts();
    } catch (err: any) { setTgRegisterError(err.message); }
    finally { setTgRegisterLoading(false); }
  };

  const handleUnlink = async (accountOrId: any) => {
    const accObj = typeof accountOrId === 'string'
      ? accounts.find(a => a.id === accountOrId)
      : accountOrId;
    const accountId = typeof accountOrId === 'string' ? accountOrId : accountOrId?.id;
    if (!accountId) return;
    const driveLabel = accObj?.name || accObj?.email || (accObj?.accountType === 'tgdrive' ? 'TG Drive' : 'this account');
    const providerLabel = accObj?.accountType === 'onedrive' ? 'Microsoft OneDrive' : accObj?.accountType === 'tgdrive' ? 'Telegram' : 'Google Drive';
    setConfirmModal({
      isOpen: true,
      title: `Disconnect ${driveLabel}?`,
      message: `This removes ${driveLabel} from Cloudyte. Your files stay safe inside ${providerLabel}, and any active transfers using this drive will be cancelled.`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await fetch(`/api/accounts/${accountId}`, { method: 'DELETE', headers: getAuthHeaders() });
          const newAccounts = accounts.filter(a => a.id !== accountId);
          setAccounts(newAccounts);
          if (selectedAccountId === accountId) {
            const nextDefault = newAccounts.find(a => a.isDefault) || newAccounts[0] || null;
            setSelectedAccountId(nextDefault?.id || null);
          }
          showToast(`${driveLabel} disconnected`);
        } catch { showToast('Failed to disconnect account', 'error'); }
      },
      onCancel: () => setConfirmModal(null),
    });
  };

  const handleSetDefaultAccount = async (accountId: string) => {
    const targetAcc = accounts.find(a => a.id === accountId);
    try {
      const res = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefaultAccId: accountId }),
      });
      if (!res.ok) throw new Error('Failed to set default drive');
      setAccounts(prev => prev.map(a => ({ ...a, isDefault: a.id === accountId })));
      showToast(`${targetAcc?.name || targetAcc?.email || 'Drive'} set as default`);
    } catch (err: any) {
      showToast(err.message || 'Could not update default drive', 'error');
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (isTrashView) {
      return handlePermanentDeleteFile(fileId);
    }
    setConfirmModal({
      isOpen: true, title: 'Move to Trash', message: 'Move this file to the drive trash?',
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await fetch(`/api/files/${fileId}?accountId=${selectedAccountId}`, { method: 'DELETE', headers: getAuthHeaders() });
          if (!res.ok) throw new Error('Delete failed');
          setFiles(files.filter(f => f.id !== fileId));
          if (selectedFile?.id === fileId) setSelectedFile(null);
          showToast('Moved to Trash');
        } catch { showToast('Delete failed', 'error'); }
      },
      onCancel: () => setConfirmModal(null),
    });
  };

  const handleRestoreFile = async (fileId: string) => {
    if (!selectedAccountId) return;
    try {
      const res = await fetch('/api/trash/restore', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId, fileId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Restore failed');
      setFiles(prev => prev.filter(f => f.id !== fileId));
      if (selectedFile?.id === fileId) setSelectedFile(null);
      setSelectedFileIds(prev => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
      showToast('File restored to drive');
    } catch (err: any) {
      showToast(err.message || 'Restore failed', 'error');
    }
  };

  const handlePermanentDeleteFile = async (fileId: string) => {
    if (!selectedAccountId) return;
    setConfirmModal({
      isOpen: true,
      title: 'Delete Forever',
      message: 'Permanently delete this file from Trash? This action cannot be undone.',
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await fetch(`/api/trash/${encodeURIComponent(fileId)}?accountId=${encodeURIComponent(selectedAccountId)}`, {
            method: 'DELETE',
            headers: getAuthHeaders(),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Permanent delete failed');
          setFiles(prev => prev.filter(f => f.id !== fileId));
          if (selectedFile?.id === fileId) setSelectedFile(null);
          setSelectedFileIds(prev => {
            const next = new Set(prev);
            next.delete(fileId);
            return next;
          });
          showToast('Permanently deleted');
        } catch (err: any) {
          showToast(err.message || 'Permanent delete failed', 'error');
        }
      },
      onCancel: () => setConfirmModal(null),
    });
  };

  const handleEmptyTrash = async () => {
    if (!selectedAccountId) return;
    setConfirmModal({
      isOpen: true,
      title: 'Empty Drive Trash',
      message: 'Permanently delete all items in this drive’s Trash? This cannot be undone.',
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          setLoading(true);
          const res = await fetch(`/api/trash?accountId=${encodeURIComponent(selectedAccountId)}`, {
            method: 'DELETE',
            headers: getAuthHeaders(),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Failed to empty trash');
          setFiles([]);
          setSelectedFile(null);
          setSelectedFileIds(new Set());
          showToast(`Emptied Trash (${data.deletedCount ?? 0} item(s) removed)`);
        } catch (err: any) {
          showToast(err.message || 'Failed to empty trash', 'error');
        } finally {
          setLoading(false);
        }
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

  const requestDownloadTicketUrl = useCallback(async (
    accId: string,
    fileId: string,
    opts: { singleUse?: boolean; ttlSeconds?: number; preview?: boolean } = {}
  ): Promise<string> => {
    try {
      const res = await fetch('/api/download-tickets', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: accId,
          fileId,
          singleUse: opts.singleUse ?? true,
          ttlSeconds: opts.ttlSeconds ?? 300,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.downloadUrl) {
          return opts.preview ? `${data.downloadUrl}?preview=1` : data.downloadUrl;
        }
      }
    } catch { /* fallback below */ }
    const token = localStorage.getItem('cloudyte_token') || '';
    const suffix = opts.preview ? `?preview=1&token=${encodeURIComponent(token)}` : `?token=${encodeURIComponent(token)}`;
    return `/api/download/${encodeURIComponent(accId)}/${encodeURIComponent(fileId)}${suffix}`;
  }, [getAuthHeaders]);

  // ── Download: uses short-lived single-use download ticket (no token in URL) ─
  const handleDownload = async (fileId: string) => {
    if (!selectedAccountId) return;
    try {
      const url = await requestDownloadTicketUrl(selectedAccountId, fileId, { singleUse: true, ttlSeconds: 300 });
      window.open(url, '_blank');
    } catch (err: any) { showToast('Download failed: ' + err.message, 'error'); }
  };

  // ── Share: opens ShareModal with Expiry, MaxDownloads, and optional PIN ─────
  const handleShare = (fileOrId: any) => {
    const fileObj = typeof fileOrId === 'string'
      ? (files.find(f => f.id === fileOrId) || { id: fileOrId, name: 'Selected File', size: '' })
      : fileOrId;
    setShareTargetFile(fileObj);
    syncUrl({ shareFileId: fileObj?.id || null });
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

  const formatUploadBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const pauseCurrentUpload = async () => {
    const ctrl = uploadControlRef.current;
    ctrl.paused = true;
    if (ctrl.activeXhr) {
      try { ctrl.activeXhr.abort(); } catch { /* ignore */ }
    }
    if (ctrl.activeSessionId) {
      try {
        await fetch(`/api/upload-sessions/${ctrl.activeSessionId}/pause`, {
          method: 'POST',
          headers: getAuthHeaders(),
        });
      } catch { /* ignore */ }
    }
    setUploadProgress((prev) => prev ? { ...prev, status: 'paused' } : null);
    setUploadQueue((prev) =>
      prev.map((q) => (q.status === 'uploading' || q.status === 'preparing' ? { ...q, status: 'paused' } : q))
    );
  };

  const resumeCurrentUpload = async () => {
    const ctrl = uploadControlRef.current;
    if (ctrl.activeSessionId) {
      try {
        await fetch(`/api/upload-sessions/${ctrl.activeSessionId}/resume`, {
          method: 'POST',
          headers: getAuthHeaders(),
        });
      } catch { /* ignore */ }
    }
    ctrl.paused = false;
    setUploadProgress((prev) => prev ? { ...prev, status: 'uploading' } : null);
    setUploadQueue((prev) =>
      prev.map((q) => (q.status === 'paused' ? { ...q, status: 'uploading' } : q))
    );
    if (ctrl.resumeResolver) {
      const resolve = ctrl.resumeResolver;
      ctrl.resumeResolver = null;
      resolve();
    }
  };

  const cancelCurrentUpload = async () => {
    const ctrl = uploadControlRef.current;
    ctrl.cancelled = true;
    ctrl.paused = false;
    if (ctrl.activeXhr) {
      try { ctrl.activeXhr.abort(); } catch { /* ignore */ }
    }
    if (ctrl.resumeResolver) {
      const resolve = ctrl.resumeResolver;
      ctrl.resumeResolver = null;
      resolve();
    }
    if (ctrl.activeSessionId) {
      try {
        await fetch(`/api/upload-sessions/${ctrl.activeSessionId}`, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        });
      } catch { /* ignore */ }
    }
    setUploadProgress((prev) => prev ? { ...prev, status: 'cancelled' } : null);
    setUploadQueue((prev) =>
      prev.map((q) => (q.status === 'queued' || q.status === 'preparing' || q.status === 'uploading' || q.status === 'paused' ? { ...q, status: 'cancelled' } : q))
    );
  };

  const computeBrowserSha256Hex = async (file: File): Promise<string | undefined> => {
    if (file.size > 64 * 1024 * 1024 || !window.crypto?.subtle) return undefined;
    try {
      const buffer = await file.arrayBuffer();
      const digest = await window.crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return undefined;
    }
  };

  const uploadFiles = async (filesToUpload: FileList | File[] | null) => {
    if (!filesToUpload || filesToUpload.length === 0 || !selectedAccountId) return;
    const rawFiles = Array.from(filesToUpload);
    const queueItems = rawFiles.map((file, idx) => ({
      id: `uq_${Date.now()}_${idx}_${file.name}`,
      file,
      name: file.name,
      size: file.size,
      percent: 0,
      status: 'queued' as const,
      sessionId: null as string | null,
    }));
    setUploadQueue(queueItems);
    setIsUploadQueueMinimized(false);

    const updateQueueItem = (
      itemId: string,
      patch: Partial<{
        percent: number;
        status: 'queued' | 'preparing' | 'uploading' | 'paused' | 'completing' | 'completed' | 'failed' | 'cancelled';
        error?: string;
        sessionId?: string | null;
      }>
    ) => {
      setUploadQueue((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
    };

    let successCount = 0;
    let failedCount = 0;
    const ctrl = uploadControlRef.current;
    ctrl.paused = false;
    ctrl.cancelled = false;
    ctrl.activeSessionId = null;
    ctrl.activeXhr = null;
    ctrl.resumeResolver = null;

    const waitWhilePaused = async () => {
      while (ctrl.paused && !ctrl.cancelled) {
        await new Promise<void>((resolve) => {
          ctrl.resumeResolver = resolve;
        });
      }
      if (ctrl.cancelled) {
        const err: any = new Error('Upload cancelled');
        err.cancelled = true;
        throw err;
      }
    };

    try {
      for (let i = 0; i < queueItems.length; i++) {
        if (ctrl.cancelled) break;
        const qItem = queueItems[i];
        const file = qItem.file;
        const idempotencyKey = `upl_${selectedAccountId}_${currentFolderId || 'root'}_${file.name}_${file.size}_${file.lastModified || 0}`;
        const storageKey = `cloudyte_upload_session_${idempotencyKey}`;
        setUploadProgress({ name: file.name, percent: 0, status: 'preparing', sessionId: null });
        updateQueueItem(qItem.id, { status: 'preparing', percent: 0, error: undefined });

        try {
          const checksum = await computeBrowserSha256Hex(file);
          await waitWhilePaused();

          // Create or recover resumable upload session
          const initSession = async (): Promise<any> => {
            const cachedSessionId = localStorage.getItem(storageKey);
            if (cachedSessionId) {
              const checkRes = await fetch(`/api/upload-sessions/${cachedSessionId}`, { headers: getAuthHeaders() });
              if (checkRes.ok) {
                const existing = await checkRes.json();
                if (existing && (existing.status === 'active' || existing.status === 'paused' || existing.status === 'completed')) {
                  if (existing.status === 'paused') {
                    await fetch(`/api/upload-sessions/${cachedSessionId}/resume`, { method: 'POST', headers: getAuthHeaders() });
                    existing.status = 'active';
                  }
                  return existing;
                }
              }
              localStorage.removeItem(storageKey);
            }
            const createRes = await fetch(`/api/upload-sessions/${selectedAccountId}`, {
              method: 'POST',
              headers: {
                ...getAuthHeaders(),
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey,
              },
              body: JSON.stringify({
                fileName: file.name,
                mimeType: file.type || 'application/octet-stream',
                totalBytes: file.size,
                chunkSize: 2 * 1024 * 1024,
                folderId: currentFolderId || 'root',
                ...(checksum ? { checksum } : {}),
                idempotencyKey,
              }),
            });
            if (!createRes.ok) {
              const errBody = await createRes.json().catch(() => ({}));
              throw new Error(errBody.error || `Failed to initialize upload for ${file.name}`);
            }
            const created = await createRes.json();
            if (created?.sessionId) localStorage.setItem(storageKey, created.sessionId);
            return created;
          };

          let session = await initSession();
          ctrl.activeSessionId = session.sessionId;
          const chunkSize = Number(session.chunkSize) || 2 * 1024 * 1024;
          let offset = Number(session.receivedBytes) || 0;

          if (session.status !== 'completed') {
            const initPct = file.size > 0 ? Math.round((offset / file.size) * 100) : 0;
            setUploadProgress({
              name: file.name,
              percent: initPct,
              status: 'uploading',
              sessionId: session.sessionId,
            });
            updateQueueItem(qItem.id, { status: 'uploading', percent: initPct, sessionId: session.sessionId });

            while (offset < file.size) {
              await waitWhilePaused();
              const end = Math.min(offset + chunkSize, file.size);
              const blob = file.slice(offset, end);
              let chunkSha256: string | undefined;
              if (window.crypto?.subtle) {
                try {
                  const chunkBuf = await blob.arrayBuffer();
                  const chunkDigest = await window.crypto.subtle.digest('SHA-256', chunkBuf);
                  chunkSha256 = Array.from(new Uint8Array(chunkDigest)).map((b) => b.toString(16).padStart(2, '0')).join('');
                } catch { /* ignore */ }
              }

              const maxAttempts = 4;
              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                await waitWhilePaused();
                try {
                  const chunkResult: any = await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    ctrl.activeXhr = xhr;
                    xhr.upload.addEventListener('progress', (ev) => {
                      if (ev.lengthComputable && !ctrl.paused) {
                        const loadedTotal = Math.min(file.size, offset + ev.loaded);
                        const pct = file.size > 0 ? Math.round((loadedTotal / file.size) * 100) : 100;
                        setUploadProgress({
                          name: file.name,
                          percent: pct,
                          status: 'uploading',
                          sessionId: session.sessionId,
                        });
                        updateQueueItem(qItem.id, { status: 'uploading', percent: pct });
                      }
                    });
                    xhr.addEventListener('load', () => {
                      ctrl.activeXhr = null;
                      let parsed: any = {};
                      try { parsed = JSON.parse(xhr.responseText || '{}'); } catch { /* ignore */ }
                      if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(parsed);
                      } else {
                        const err: any = new Error(parsed.error || `Chunk upload failed (${xhr.status})`);
                        err.status = xhr.status;
                        err.code = parsed.code;
                        err.retryable = parsed.retryable ?? (xhr.status === 429 || xhr.status >= 500);
                        err.receivedBytes = parsed.receivedBytes;
                        reject(err);
                      }
                    });
                    xhr.addEventListener('error', () => {
                      ctrl.activeXhr = null;
                      const err: any = new Error(`Network error while uploading ${file.name}`);
                      err.retryable = true;
                      reject(err);
                    });
                    xhr.addEventListener('abort', () => {
                      ctrl.activeXhr = null;
                      const err: any = new Error('Upload paused or aborted');
                      err.aborted = true;
                      reject(err);
                    });
                    xhr.open('PUT', `/api/upload-sessions/${session.sessionId}/chunks`);
                    const h = getAuthHeaders();
                    if (h['Authorization']) xhr.setRequestHeader('Authorization', h['Authorization']);
                    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                    xhr.setRequestHeader('X-Chunk-Offset', String(offset));
                    if (chunkSha256) xhr.setRequestHeader('X-Chunk-Sha256', chunkSha256);
                    xhr.send(blob);
                  });

                  offset = typeof chunkResult?.receivedBytes === 'number' ? chunkResult.receivedBytes : end;
                  break;
                } catch (err: any) {
                  if (err?.aborted) {
                    await waitWhilePaused();
                    attempt--;
                    continue;
                  }
                  if (err?.status === 410 || err?.code === 'UPLOAD_SESSION_EXPIRED') {
                    localStorage.removeItem(storageKey);
                    session = await initSession();
                    ctrl.activeSessionId = session.sessionId;
                    offset = Number(session.receivedBytes) || 0;
                    break;
                  }
                  if (err?.status === 409 && typeof err?.receivedBytes === 'number') {
                    offset = err.receivedBytes;
                    break;
                  }
                  if (!err?.retryable || attempt >= maxAttempts) throw err;
                  await new Promise((r) => setTimeout(r, 500 * (2 ** (attempt - 1))));
                }
              }
            }

            await waitWhilePaused();
            setUploadProgress({ name: file.name, percent: 100, status: 'completing', sessionId: session.sessionId });
            updateQueueItem(qItem.id, { status: 'completing', percent: 100 });

            for (let attempt = 1; attempt <= 3; attempt++) {
              const completeRes = await fetch(`/api/upload-sessions/${session.sessionId}/complete`, {
                method: 'POST',
                headers: {
                  ...getAuthHeaders(),
                  'Content-Type': 'application/json',
                  'Idempotency-Key': `${idempotencyKey}_complete`,
                },
              });
              if (completeRes.ok) break;
              const errBody = await completeRes.json().catch(() => ({}));
              if (completeRes.status !== 429 && completeRes.status < 500 || attempt === 3) {
                throw new Error(errBody.error || `Failed to finalize upload for ${file.name}`);
              }
              await new Promise((r) => setTimeout(r, 750 * (2 ** (attempt - 1))));
            }
          }

          localStorage.removeItem(storageKey);
          setUploadProgress({ name: file.name, percent: 100, status: 'completed', sessionId: session.sessionId });
          updateQueueItem(qItem.id, { status: 'completed', percent: 100, error: undefined });
          successCount++;
        } catch (uploadErr: any) {
          if (uploadErr?.cancelled || ctrl.cancelled) {
            localStorage.removeItem(storageKey);
            updateQueueItem(qItem.id, { status: 'cancelled' });
            showToast(`Upload cancelled for ${file.name}`, 'error');
            break;
          }
          failedCount++;
          const msg = uploadErr?.message || `Failed to upload ${file.name}`;
          setUploadProgress({ name: file.name, percent: 0, status: 'failed', sessionId: ctrl.activeSessionId });
          updateQueueItem(qItem.id, { status: 'failed', error: msg });
          showToast(msg, 'error');
        }
      }
      fetchFiles(selectedAccountId, currentFolderId);
      if (successCount > 0 && failedCount === 0) {
        const destName = path[path.length - 1]?.id ? path[path.length - 1].name : (selectedAccount?.name || 'Drive');
        showToast(`Uploaded ${successCount} file(s) to ${destName}`);
      }
      if (failedCount === 0 && !ctrl.cancelled) {
        setTimeout(() => {
          setUploadQueue((prev) => (prev.some((q) => q.status === 'failed' || q.status === 'uploading' || q.status === 'paused' || q.status === 'queued') ? prev : []));
        }, 2800);
      }
    } catch (err: any) {
      showToast(err.message || 'Upload process failed', 'error');
    } finally {
      ctrl.activeSessionId = null;
      ctrl.activeXhr = null;
      setUploadProgress(null);
    }
  };

  const retryFailedUploads = () => {
    const failedFiles = uploadQueue.filter((q) => q.status === 'failed').map((q) => q.file);
    if (failedFiles.length > 0) uploadFiles(failedFiles);
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
    if (isTrashView) {
      setConfirmModal({
        isOpen: true,
        title: 'Delete Forever',
        message: `Permanently delete ${selectedFileIds.size} item(s) from Trash? This cannot be undone.`,
        onConfirm: async () => {
          setConfirmModal(null);
          let successCount = 0;
          for (const id of selectedFileIds) {
            try {
              const res = await fetch(`/api/trash/${encodeURIComponent(id)}?accountId=${encodeURIComponent(selectedAccountId || '')}`, {
                method: 'DELETE',
                headers: getAuthHeaders(),
              });
              if (res.ok) successCount++;
            } catch { /* ignore */ }
          }
          setFiles(files.filter(f => !selectedFileIds.has(f.id)));
          if (selectedFile && selectedFileIds.has(selectedFile.id)) setSelectedFile(null);
          setSelectedFileIds(new Set());
          showToast(`${successCount} item(s) permanently deleted`);
        },
        onCancel: () => setConfirmModal(null),
      });
      return;
    }
    setConfirmModal({
      isOpen: true,
      title: 'Move Selected to Trash',
      message: `Move ${selectedFileIds.size} file(s) to this drive's Trash?`,
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
        showToast(`${successCount} file(s) moved to Trash`);
      },
      onCancel: () => setConfirmModal(null),
    });
  };

  const handleBulkRestore = async () => {
    if (selectedFileIds.size === 0 || !selectedAccountId) return;
    let successCount = 0;
    for (const id of selectedFileIds) {
      try {
        const res = await fetch('/api/trash/restore', {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: selectedAccountId, fileId: id }),
        });
        if (res.ok) successCount++;
      } catch { /* ignore */ }
    }
    setFiles(files.filter(f => !selectedFileIds.has(f.id)));
    if (selectedFile && selectedFileIds.has(selectedFile.id)) setSelectedFile(null);
    setSelectedFileIds(new Set());
    showToast(`${successCount} file(s) restored`);
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
    const startAcc = accounts.find(a => a.id === selectedAccountId) || accounts[0];
    const startAccId = startAcc?.id || selectedAccountId;
    const rootName = startAcc?.name || (startAcc?.accountType === 'tgdrive' ? 'TG Drive' : startAcc?.email || 'Drive');
    setMoveTargetAccountId(startAccId || null);
    setMoveTargetFolderId('root');
    setMovePath([{ id: 'root', name: rootName }]);
    setMoveInlineFolderMode(false);
    setMoveInlineFolderName('');
    if (startAccId) fetchMoveFolders(startAccId, 'root');
    setIsMoveModalOpen(true);
    syncUrl({ modal: action });
  };

  const navigateMoveFolder = (folderOrId: any, folderName?: string) => {
    const rawId = typeof folderOrId === 'string' ? folderOrId : folderOrId?.id;
    const cleanId = rawId?.startsWith('folder:') ? rawId.replace('folder:', '') : (rawId || 'root');
    const name = typeof folderOrId === 'object' && folderOrId?.name ? folderOrId.name : (folderName || 'Folder');

    if (cleanId === 'root') {
      setMoveTargetFolderId('root');
      setMovePath(prev => prev.length > 0 ? [prev[0]] : [{ id: 'root', name: 'Drive' }]);
      if (moveTargetAccountId) fetchMoveFolders(moveTargetAccountId, 'root');
      return;
    }

    setMoveTargetFolderId(cleanId);
    setMovePath(prev => {
      const existingIdx = prev.findIndex(p => p.id === cleanId);
      if (existingIdx >= 0) return prev.slice(0, existingIdx + 1);
      return [...prev, { id: cleanId, name }];
    });
    if (moveTargetAccountId) fetchMoveFolders(moveTargetAccountId, cleanId);
  };

  const navigateMoveAccount = (accountId: string) => {
    const acc = accounts.find(a => a.id === accountId);
    const rootName = acc?.name || (acc?.accountType === 'tgdrive' ? 'TG Drive' : acc?.email || 'Drive');
    setMoveTargetAccountId(accountId);
    setMoveTargetFolderId('root');
    setMovePath([{ id: 'root', name: rootName }]);
    setMoveInlineFolderMode(false);
    setMoveInlineFolderName('');
    fetchMoveFolders(accountId, 'root');
  };

  const handleCreateMoveFolderInline = async () => {
    const trimmed = moveInlineFolderName.trim();
    if (!trimmed || !moveTargetAccountId || moveCreatingFolder) return;
    setMoveCreatingFolder(true);
    try {
      const res = await fetch(`/api/folders?accountId=${encodeURIComponent(moveTargetAccountId)}`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          parentId: moveTargetFolderId === 'root' ? null : moveTargetFolderId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to create folder');
      setMoveInlineFolderMode(false);
      setMoveInlineFolderName('');
      await fetchMoveFolders(moveTargetAccountId, moveTargetFolderId);
      showToast(`Created folder "${trimmed}"`);
    } catch (err: any) {
      showToast(err.message || 'Could not create folder', 'error');
    } finally {
      setMoveCreatingFolder(false);
    }
  };

  const handleMoveConfirm = async (asBatchBackup = false) => {
    if (selectedFileIds.size === 0 || !moveTargetAccountId) return;
    const isCrossAccount = moveTargetAccountId !== selectedAccountId;
    const destAccountId = moveTargetAccountId;
    const destFolderId = moveTargetFolderId;
    const destBreadcrumb = movePath.map(p => p.name).join(' › ');
    setIsMoveModalOpen(false);
    syncUrl({ modal: null }, 'replace');

    if (asBatchBackup && selectedAccountId) {
      try {
        const res = await fetch('/api/backups/batch', {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceAccountId: selectedAccountId,
            targetAccountId: destAccountId,
            targetFolderId: destFolderId,
            fileIds: Array.from(selectedFileIds),
            conflictStrategy: 'rename',
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Batch backup failed');
        }
        showToast(
          `Backup to ${destBreadcrumb} queued`,
          'success',
          {
            label: 'Transfers',
            onClick: () => {
              setIsSettingsOpen(false);
              setIsAdminPanelOpen(false);
              setIsJobsDrawerOpen(true);
              syncUrl({ page: 'jobs' });
            },
          }
        );
        setSelectedFileIds(new Set());
        setIsSettingsOpen(false);
        setIsAdminPanelOpen(false);
        setIsJobsDrawerOpen(true);
        syncUrl({ page: 'jobs', modal: null });
      } catch (err: any) {
        showToast(err.message || 'Batch backup failed', 'error');
      }
      return;
    }

    showToast(isCrossAccount ? `Queuing transfer to ${destBreadcrumb}...` : `${modalAction === 'move' ? 'Moving' : 'Copying'} to ${destBreadcrumb}...`);
    let successCount = 0;
    let queuedCount = 0;

    for (const fileId of selectedFileIds) {
      try {
        const url = isCrossAccount ? `/api/files/${modalAction}?async=true` : `/api/files/${modalAction}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceAccountId: selectedAccountId,
            fileId,
            targetAccountId: destAccountId,
            targetFolderId: destFolderId,
          }),
        });
        if (res.status === 202) {
          queuedCount++;
        } else if (res.ok) {
          successCount++;
        }
      } catch { /* ignore */ }
    }

    if (queuedCount > 0) {
      showToast(
        `Queued ${queuedCount} transfer(s) to ${destBreadcrumb}`,
        'success',
        {
          label: 'Transfers',
          onClick: () => {
            setIsSettingsOpen(false);
            setIsAdminPanelOpen(false);
            setIsJobsDrawerOpen(true);
            syncUrl({ page: 'jobs' });
          },
        }
      );
      setSelectedFileIds(new Set());
      setIsSettingsOpen(false);
      setIsAdminPanelOpen(false);
      setIsJobsDrawerOpen(true);
      syncUrl({ page: 'jobs', modal: null });
    } else if (successCount > 0) {
      const targetAcc = accounts.find(a => a.id === destAccountId);
      showToast(
        `${modalAction === 'move' ? 'Moved' : 'Copied'} ${successCount} item(s) to ${destBreadcrumb}`,
        'success',
        {
          label: 'View',
          onClick: () => {
            if (targetAcc) {
              setSelectedAccountId(destAccountId);
              setIsTrashView(false);
              const targetRootName = targetAcc.accountType === 'tgdrive' ? '📡 TG Drive' : 'My Drive';
              const rebuiltPath: BreadcrumbItem[] = [
                { id: null, name: targetRootName },
                ...movePath.slice(1).map(p => ({ id: p.id, name: p.name })),
              ];
              setPath(rebuiltPath);
              setCurrentFolderId(destFolderId === 'root' ? null : destFolderId);
              syncUrl(
                { page: 'drive', accountId: destAccountId, folderId: destFolderId === 'root' ? null : destFolderId, trash: false },
                'push',
                rebuiltPath
              );
            }
          },
        }
      );
      fetchFiles(selectedAccountId!, currentFolderId, debouncedSearch);
      setSelectedFileIds(new Set());
    } else {
      showToast(`${modalAction === 'move' ? 'Move' : 'Copy'} failed`, 'error');
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
        if (!file || file.type === 'folder' || !selectedAccountId) continue;

        const ticketUrl = await requestDownloadTicketUrl(selectedAccountId, id, { singleUse: true, ttlSeconds: 300 });
        const blobRes = await fetch(ticketUrl);
        if (!blobRes.ok) throw new Error(`Failed to download ${file.name}`);
        const blob = await blobRes.blob();
        zip.file(file.name, blob);
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

  const openPreview = useCallback(async (file: any, opts: { syncHistory?: boolean } = {}) => {
    if (!selectedAccountId) return;
    const url = await requestDownloadTicketUrl(selectedAccountId, file.id, {
      singleUse: false,
      ttlSeconds: 600,
      preview: true,
    });
    setPreviewFile({ ...file, url });
    if (opts.syncHistory !== false) {
      syncUrl({ previewFileId: file.id, galleryFileId: null });
    }
  }, [selectedAccountId, requestDownloadTicketUrl, syncUrl]);

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

  const openFullScreenGallery = useCallback(async (file: any, opts: { syncHistory?: boolean } = {}) => {
    setPreviewFile(null); // Close the smaller modal
    if (!file.url && selectedAccountId) {
      const url = await requestDownloadTicketUrl(selectedAccountId, file.id, { singleUse: false, ttlSeconds: 600, preview: true });
      setFullScreenGalleryFile({ ...file, url });
    } else {
      setFullScreenGalleryFile(file);
    }
    if (opts.syncHistory !== false) {
      syncUrl({ galleryFileId: file.id, previewFileId: null });
    }
  }, [selectedAccountId, requestDownloadTicketUrl, syncUrl]);

  const getMediaUrl = useCallback((file: any) => {
    if (!file) return '';
    if (file.url) return file.url;
    return '';
  }, []);

  const mediaFiles = files.filter(f => ['image', 'video', 'audio'].includes(f.type));
  const currentGalleryIndex = fullScreenGalleryFile ? mediaFiles.findIndex(f => f.id === fullScreenGalleryFile.id) : -1;
  const hasNextMedia = currentGalleryIndex >= 0 && currentGalleryIndex < mediaFiles.length - 1;
  const hasPrevMedia = currentGalleryIndex > 0;

  const navigateGallery = useCallback(async (direction: 'next' | 'prev', e?: React.MouseEvent) => {
    e?.stopPropagation();
    let target: any = null;
    if (direction === 'next' && currentGalleryIndex >= 0 && currentGalleryIndex < mediaFiles.length - 1) target = mediaFiles[currentGalleryIndex + 1];
    if (direction === 'prev' && currentGalleryIndex > 0) target = mediaFiles[currentGalleryIndex - 1];
    if (!target) return;
    if (!target.url && selectedAccountId) {
      const url = await requestDownloadTicketUrl(selectedAccountId, target.id, { singleUse: false, ttlSeconds: 600, preview: true });
      setFullScreenGalleryFile({ ...target, url });
    } else {
      setFullScreenGalleryFile(target);
    }
    syncUrl({ galleryFileId: target.id, previewFileId: null }, 'replace');
  }, [currentGalleryIndex, mediaFiles, selectedAccountId, requestDownloadTicketUrl, syncUrl]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!fullScreenGalleryFile) return;
      if (e.key === 'ArrowRight') navigateGallery('next');
      if (e.key === 'ArrowLeft') navigateGallery('prev');
      if (e.key === 'Escape') {
        setFullScreenGalleryFile(null);
        syncUrl({ galleryFileId: null });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fullScreenGalleryFile, navigateGallery, syncUrl]);

  const handleBulkZip = async (specificIds?: Set<string>) => {
    const idsToProcess = specificIds || selectedFileIds;
    if (idsToProcess.size === 0) return;
    showToast('Preparing ZIP archive... this may take a while.', 'success');
    try {
      const zip = new JSZip();
      for (const id of idsToProcess) {
        const file = files.find(f => f.id === id);
        if (!file || file.type === 'folder' || !selectedAccountId) continue;

        const ticketUrl = await requestDownloadTicketUrl(selectedAccountId, id, { singleUse: true, ttlSeconds: 300 });
        const blobRes = await fetch(ticketUrl);
        if (!blobRes.ok) throw new Error(`Failed to download ${file.name}`);
        const blob = await blobRes.blob();
        zip.file(file.name, blob);
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
    if (!selectedAccountId) return;
    showToast('Downloading ZIP for extraction...');
    try {
      const ticketUrl = await requestDownloadTicketUrl(selectedAccountId, file.id, { singleUse: true, ttlSeconds: 300 });
      const blobRes = await fetch(ticketUrl);
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
    if (isTrashView) return;
    // TG Drive folders use path strings prefixed with "folder:"
    const folderId = folder.id.startsWith('folder:') ? folder.id.replace('folder:', '') : folder.id;
    const nextPath = [...path, { id: folderId, name: folder.name }];
    setCurrentFolderId(folderId);
    setPath(nextPath);
    setSearchQuery('');
    setDebouncedSearch('');
    setSelectedFile(null);
    setSelectedFileIds(new Set());
    syncUrl(
      {
        page: 'drive',
        folderId,
        trash: false,
        search: '',
        infoFileId: null,
        previewFileId: null,
        galleryFileId: null,
        shareFileId: null,
      },
      'push',
      nextPath
    );
  };

  const navigateUp = (index: number) => {
    setIsTrashView(false);
    const newPath = path.slice(0, index + 1);
    const nextFolderId = newPath[newPath.length - 1].id;
    setPath(newPath);
    setCurrentFolderId(nextFolderId);
    setSearchQuery('');
    setDebouncedSearch('');
    setSelectedFile(null);
    setSelectedFileIds(new Set());
    syncUrl(
      {
        page: 'drive',
        folderId: nextFolderId,
        trash: false,
        search: '',
        infoFileId: null,
        previewFileId: null,
        galleryFileId: null,
        shareFileId: null,
      },
      'push',
      newPath
    );
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

  const fetchUserDetails = useCallback(async (uId: string, pushHistory = true) => {
    setSelectedAdminUserId(uId);
    if (pushHistory) {
      syncUrl({ page: 'admin', adminTab: 'overview', adminUserId: uId });
    }
    setLoadingUserDetails(true);
    try {
      const res = await fetch(`/api/admin/users/${uId}`, { headers: getAuthHeaders() });
      if (res.ok) setSelectedAdminUserDetails(await res.json());
    } catch { showToast('Failed to load user details', 'error'); }
    finally { setLoadingUserDetails(false); }
  }, [getAuthHeaders, syncUrl]);

  // Resolve URL-specified file overlays (?preview=, ?gallery=, ?share=, ?info=) once files load
  useEffect(() => {
    if (!isAuthenticated || files.length === 0) return;
    const pending = pendingUrlOverlayRef.current;
    if (pending.preview) {
      const match = files.find((f) => f.id === pending.preview);
      if (match) {
        pending.preview = null;
        openPreview(match, { syncHistory: false });
      }
    }
    if (pending.gallery) {
      const match = files.find((f) => f.id === pending.gallery);
      if (match) {
        pending.gallery = null;
        openFullScreenGallery(match, { syncHistory: false });
      }
    }
    if (pending.share) {
      const match = files.find((f) => f.id === pending.share);
      if (match) {
        pending.share = null;
        setShareTargetFile(match);
      }
    }
    if (pending.info) {
      const match = files.find((f) => f.id === pending.info);
      if (match) {
        pending.info = null;
        setSelectedFile(match);
      }
    }
  }, [files, isAuthenticated, openPreview, openFullScreenGallery]);

  // Load deep-linked Admin User Dossier on reload or popstate
  useEffect(() => {
    if (isAuthenticated && isAdminPanelOpen && selectedAdminUserId && !selectedAdminUserDetails && !loadingUserDetails) {
      fetchUserDetails(selectedAdminUserId, false);
    }
  }, [isAuthenticated, isAdminPanelOpen, selectedAdminUserId, selectedAdminUserDetails, loadingUserDetails, fetchUserDetails]);

  // Synchronize browser Back/Forward (popstate) with all pages, drives, folders, tabs, and overlays
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const route = parseAppLocation();
      if (!isAuthenticated) {
        setIsRegisterMode(route.authMode === 'register');
        setLoginError(null);
        return;
      }

      if (route.accountId && route.accountId !== selectedAccountId) {
        setSelectedAccountId(route.accountId);
      }
      setIsTrashView(route.trash);
      setCurrentFolderId(route.folderId);

      const statePath = (event.state as any)?.path;
      if (Array.isArray(statePath) && statePath.length > 0) {
        setPath(statePath);
      } else {
        const acc = accounts.find((a) => a.id === (route.accountId || selectedAccountId));
        const rootName = acc?.accountType === 'tgdrive' ? '📡 TG Drive' : 'My Drive';
        setPath(
          route.folderId
            ? [{ id: null, name: rootName }, { id: route.folderId, name: 'Folder' }]
            : [{ id: null, name: rootName }]
        );
      }

      setSearchQuery(route.search);
      setDebouncedSearch(route.search);
      setContextMenu(null);

      setIsSettingsOpen(route.page === 'settings');
      setSettingsTab(route.settingsTab);
      setIsJobsDrawerOpen(route.page === 'jobs');
      setIsAdminPanelOpen(route.page === 'admin');
      setAdminTab(route.adminTab);
      if (route.adminUserId !== selectedAdminUserId) {
        setSelectedAdminUserId(route.adminUserId);
        setSelectedAdminUserDetails(null);
      }

      setLinkProviderModal(route.modal === 'link-account');
      setTgDriveModal(route.modal === 'tg-drive');
      setIsMoveModalOpen(route.modal === 'move' || route.modal === 'copy');
      if (route.modal === 'move' || route.modal === 'copy') {
        setModalAction(route.modal);
      }

      if (!route.previewFileId) {
        setPreviewFile(null);
        pendingUrlOverlayRef.current.preview = null;
      } else {
        const f = files.find((item) => item.id === route.previewFileId);
        if (f) openPreview(f, { syncHistory: false });
        else pendingUrlOverlayRef.current.preview = route.previewFileId;
      }

      if (!route.galleryFileId) {
        setFullScreenGalleryFile(null);
        pendingUrlOverlayRef.current.gallery = null;
      } else {
        const f = files.find((item) => item.id === route.galleryFileId);
        if (f) openFullScreenGallery(f, { syncHistory: false });
        else pendingUrlOverlayRef.current.gallery = route.galleryFileId;
      }

      if (!route.shareFileId) {
        setShareTargetFile(null);
        pendingUrlOverlayRef.current.share = null;
      } else {
        const f = files.find((item) => item.id === route.shareFileId);
        if (f) setShareTargetFile(f);
        else pendingUrlOverlayRef.current.share = route.shareFileId;
      }

      if (!route.infoFileId) {
        setSelectedFile(null);
        pendingUrlOverlayRef.current.info = null;
      } else {
        const f = files.find((item) => item.id === route.infoFileId);
        if (f) setSelectedFile(f);
        else pendingUrlOverlayRef.current.info = route.infoFileId;
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isAuthenticated, accounts, files, selectedAccountId, selectedAdminUserId, openPreview, openFullScreenGallery]);

  // Lightweight running-jobs polling for header status pill
  useEffect(() => {
    if (!isAuthenticated) {
      setRunningJobsCount(0);
      setRunningJobsPct(0);
      return;
    }
    let cancelled = false;
    const pollActiveJobs = async () => {
      try {
        const res = await fetch('/api/jobs', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const list = await res.json();
        if (cancelled || !Array.isArray(list)) return;
        const active = list.filter((j: any) => j.status === 'running' || j.status === 'queued');
        setRunningJobsCount(active.length);
        if (active.length > 0) {
          const avgPct = Math.round(
            active.reduce((sum: number, j: any) => sum + Number(j.progressPct ?? j.progress ?? 0), 0) / active.length
          );
          setRunningJobsPct(avgPct);
        } else {
          setRunningJobsPct(0);
        }
      } catch {
        /* ignore */
      }
    };
    pollActiveJobs();
    const timer = setInterval(pollActiveJobs, 12000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isAuthenticated, getAuthHeaders]);

  // ── Derived: selected account type & sorted/filtered files ──────────────
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const isTgDrive = selectedAccount?.accountType === 'tgdrive';
  const userInitials = (username || 'U').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'U';

  const displayedFiles = React.useMemo(() => {
    const filtered = files.filter((file) => {
      if (searchFilterType === 'all') return true;
      if (searchFilterType === 'folder') return file.type === 'folder';
      if (searchFilterType === 'image') return file.type === 'image';
      if (searchFilterType === 'video') return file.type === 'video';
      const lowerName = String(file.name || '').toLowerCase();
      if (searchFilterType === 'pdf') return lowerName.endsWith('.pdf') || file.mimeType === 'application/pdf';
      if (searchFilterType === 'doc') {
        return (
          file.type === 'doc' ||
          file.type === 'document' ||
          /\.(docx?|txt|md|rtf|odt|xlsx?|csv|pptx?)$/i.test(lowerName)
        );
      }
      return true;
    });
    const list = [...filtered];
    list.sort((a, b) => {
      const aDir = a.type === 'folder' ? 0 : 1;
      const bDir = b.type === 'folder' ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      const cmp = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
      return sortOrder === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [files, sortOrder, searchFilterType]);

  const renderProviderBadge = (accountType: string, size: 'sm' | 'md' = 'md') => {
    const dims = size === 'sm' ? 'w-6 h-6 text-[11px]' : 'w-10 h-10 text-[15px]';
    if (accountType === 'tgdrive') {
      return (
        <span className={`${dims} rounded-[50%_20%_50%_20%] bg-[var(--tb)] text-[var(--tt)] flex items-center justify-center font-extrabold shrink-0`}>
          <TelegramIcon size={size === 'sm' ? 13 : 18} />
        </span>
      );
    }
    if (accountType === 'onedrive') {
      return (
        <span className={`${dims} rounded-[36%] bg-[var(--ob)] text-[var(--ot)] flex items-center justify-center font-extrabold shrink-0`}>
          O
        </span>
      );
    }
    return (
      <span className={`${dims} rounded-full bg-[var(--gb)] text-[var(--gt)] flex items-center justify-center font-extrabold shrink-0`}>
        G
      </span>
    );
  };

  // ── Loading Screen ─────────────────────────────────────────────────────────
  if (isInitializing || (isAuthenticated && !userProfile)) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--tx)] flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-[#2563EB] text-white flex items-center justify-center animate-pulse shadow-lg shadow-blue-600/30">
          <Cloud size={26} />
        </div>
        <p className="text-[var(--sub)] font-semibold text-sm">Initializing Cloudyte...</p>
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
        <div className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl max-w-md w-full border border-slate-100 dark:border-slate-700">
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
                onClick={() => {
                  setIsRegisterMode(false);
                  setLoginError(null);
                  window.history.pushState(null, '', '/login');
                }}
                className="text-xs font-bold text-blue-500 hover:underline"
              >
                Already have an account? Login
              </button>
            ) : (
              <>
                {canRegisterOnWeb ? (
                  <button 
                    onClick={() => {
                      setIsRegisterMode(true);
                      setLoginError(null);
                      window.history.pushState(null, '', '/register');
                    }}
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
        </div>
      </div>
    );
  }

  const activeNavTab: 'files' | 'transfers' | 'drives' | 'trash' | 'settings' | 'admin' =
    isAdminPanelOpen
      ? 'admin'
      : isSettingsOpen
      ? 'settings'
      : isJobsDrawerOpen
      ? 'transfers'
      : isDrivesExpanded
      ? 'drives'
      : isTrashView
      ? 'trash'
      : 'files';

  const gridFolders = displayedFiles.filter(f => f.type === 'folder');
  const gridFiles = displayedFiles.filter(f => f.type !== 'folder');

  const getRowRadiusClass = (idx: number, total: number) => {
    if (total <= 1) return 'rounded-[20px]';
    if (idx === 0) return 'rounded-t-[20px] rounded-b-[4px]';
    if (idx === total - 1) return 'rounded-t-[4px] rounded-b-[20px]';
    return 'rounded-[4px]';
  };

  const renderDrivesPanelContent = (isMobileDrawer = false) => (
    <div className="flex flex-col h-full min-w-0">
      <div className="px-3 pt-4 pb-2.5 flex items-center justify-between gap-1.5 border-b border-[var(--bd)] shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <h2 className="text-[13px] font-extrabold tracking-tight text-[var(--tx)] truncate">Drives</h2>
          <span className="text-[10.5px] font-bold text-[var(--sub)] tabular-nums">({accounts.length})</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              setLinkProviderModal(true);
              syncUrl({ modal: 'link-account' });
            }}
            className="h-6.5 px-2 rounded-lg bg-[var(--pi)] text-[var(--pit)] text-[10.5px] font-bold flex items-center gap-1 hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
            title="Link Account"
          >
            <Plus size={12} />
            <span>Link</span>
          </button>
          <button
            type="button"
            onClick={() => setIsDrivesExpanded(false)}
            className="w-6.5 h-6.5 rounded-lg flex items-center justify-center text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)] transition-colors"
            title="Collapse Drives Panel"
            aria-label="Collapse Drives Panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 no-scrollbar">
        {accounts.length === 0 ? (
          <div className="p-4 rounded-[18px] bg-[var(--sf)] border border-[var(--bd)] text-center space-y-2.5 mt-1">
            <p className="text-xs font-bold text-[var(--tx)]">No drives linked</p>
            <p className="text-[11px] text-[var(--sub)]">Connect Google Drive, OneDrive, or Telegram.</p>
            <button
              type="button"
              onClick={() => {
                setLinkProviderModal(true);
                syncUrl({ modal: 'link-account' });
              }}
              className="w-full h-8 rounded-xl bg-[#2563EB] text-white text-xs font-bold hover:opacity-90 transition-opacity"
            >
              Link Account
            </button>
          </div>
        ) : (
          accounts.map((acc, idx) => {
            const isSelected = selectedAccountId === acc.id;
            const pct = Math.min(100, Math.max(0, Number(acc.percentage || 0)));
            const effectivePct = acc.accountType === 'tgdrive' ? 100 : pct;
            const displayName = acc.name || (acc.accountType === 'tgdrive' ? 'TG Drive' : acc.email);
            const showEmailSub = Boolean(acc.name && acc.email && acc.name !== acc.email);

            const strokeColor =
              acc.accountType === 'tgdrive'
                ? '#0EA5E9'
                : pct > 90
                ? '#F43F5E'
                : pct > 70
                ? '#F59E0B'
                : '#3B82F6';

            const clipId = `drive-wave-${String(acc.id || idx).replace(/[^a-zA-Z0-9_-]/g, '')}-${idx}`;
            const waveWidth = 180;
            const activeEnd = effectivePct <= 0 ? 0 : Math.min(waveWidth - 2, Math.max(8, (effectivePct / 100) * (waveWidth - 4) + 2));
            const trackStart = effectivePct <= 0 ? 2 : Math.min(waveWidth - 4, activeEnd + 5);

            return (
              <div
                key={acc.id}
                onClick={() => {
                  selectAccount(acc.id, false);
                  if (isMobileDrawer) setIsDrivesExpanded(false);
                }}
                title={acc.email || displayName}
                className={`group rounded-[14px] px-2.5 py-2 border cursor-pointer transition-colors duration-150 ${
                  isSelected
                    ? 'bg-[var(--sel)] border-[#2563EB]'
                    : 'bg-[var(--sf)] border-[var(--bd)] hover:border-[var(--sub)]/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  {renderProviderBadge(acc.accountType, 'sm')}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 leading-tight">
                      <span className="text-[12px] font-bold text-[var(--tx)] truncate leading-tight">
                        {displayName}
                      </span>
                      {acc.isDefault && (
                        <span className="text-[8.5px] font-extrabold uppercase tracking-wider bg-[var(--pi)] text-[var(--pit)] rounded px-1 py-[1px] leading-tight shrink-0">
                          Default
                        </span>
                      )}
                      {acc.id === userSettings?.backupAccId && (
                        <span className="text-[8.5px] font-extrabold uppercase tracking-wider bg-[#2563EB] text-white rounded px-1 py-[1px] leading-tight shrink-0">
                          Backup
                        </span>
                      )}
                      {acc.error && (
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" title={acc.error} />
                      )}
                    </div>
                    {showEmailSub && (
                      <p className="text-[9.5px] font-medium text-[var(--sub)] truncate leading-none mt-0.5">
                        {acc.email}
                      </p>
                    )}
                  </div>
                </div>

                {/* Material 3 Expressive Wavy Storage Line */}
                <div className="mt-1.5 space-y-0.5">
                  <svg
                    viewBox="0 0 180 8"
                    className="w-full h-[7px] block overflow-visible"
                    aria-hidden="true"
                  >
                    <defs>
                      <clipPath id={clipId}>
                        <rect x="0" y="0" width={activeEnd} height="8" />
                      </clipPath>
                    </defs>

                    {trackStart < 176 && (
                      <line
                        x1={trackStart}
                        y1="4"
                        x2="176"
                        y2="4"
                        stroke="var(--tr)"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                      />
                    )}

                    {effectivePct > 0 && (
                      <path
                        d="M2 4 Q5 1.3 8 4 T14 4 T20 4 T26 4 T32 4 T38 4 T44 4 T50 4 T56 4 T62 4 T68 4 T74 4 T80 4 T86 4 T92 4 T98 4 T104 4 T110 4 T116 4 T122 4 T128 4 T134 4 T140 4 T146 4 T152 4 T158 4 T164 4 T170 4 T176 4"
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        clipPath={`url(#${clipId})`}
                      />
                    )}

                    {effectivePct < 98 && (
                      <circle cx="177.5" cy="4" r="1.4" fill={strokeColor} opacity="0.7" />
                    )}
                  </svg>

                  <div className="flex items-center justify-between text-[9.5px] leading-tight font-medium text-[var(--sub)] tabular-nums">
                    <span className="truncate">
                      {acc.accountType === 'tgdrive'
                        ? `${acc.usage} · ${acc.fileCount} files`
                        : `${acc.usage} of ${acc.total}`}
                    </span>
                    {acc.accountType !== 'tgdrive' && (
                      <span className="font-mono font-semibold text-[var(--tx)]">{pct}%</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {isMobileDrawer && (
          <div className="pt-2 mt-2 border-t border-[var(--bd)]">
            <button
              type="button"
              onClick={() => {
                setIsDrivesExpanded(false);
                setIsJobsDrawerOpen(false);
                setIsAdminPanelOpen(false);
                setSettingsTab('general');
                setIsSettingsOpen(true);
                syncUrl({ page: 'settings', settingsTab: 'general' });
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--sf)] transition-colors"
            >
              <Settings size={16} className="text-[var(--sub)]" />
              <span>Settings</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className={`flex h-screen transition-colors duration-200 bg-[var(--bg)] text-[var(--tx)] font-sans overflow-hidden relative ${isDarkMode ? 'dark' : ''}`}>
      {/* Mobile Drives Drawer Backdrop & Panel */}
      <AnimatePresence>
        {isDrivesExpanded && (
          <div className="md:hidden fixed inset-0 z-[70] flex">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDrivesExpanded(false)}
              className="absolute inset-0 bg-slate-950/60 backdrop-blur-[2px]"
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 320 }}
              className="relative z-10 w-[76vw] max-w-[260px] h-full bg-[var(--rail)] border-r border-[var(--bd)] shadow-2xl"
            >
              {renderDrivesPanelContent(true)}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Desktop / Tablet Navigation Rail + Extendable Drives Sidebar */}
      <aside
        className={`hidden md:flex shrink-0 bg-[var(--rail)] border-r border-[var(--bd)] transition-[width] duration-200 ease-out overflow-hidden z-40 ${
          isDrivesExpanded ? 'w-[272px]' : 'w-24'
        }`}
      >
        {/* Navigation Rail (96px default, compact 60px when Drives panel is expanded) */}
        <nav
          className={`shrink-0 py-5 flex flex-col items-center h-full select-none transition-[width,gap] duration-200 ease-out ${
            isDrivesExpanded ? 'w-[60px] gap-2' : 'w-24 gap-2.5'
          }`}
        >
          <div
            onClick={() => {
              setIsSettingsOpen(false);
              setIsJobsDrawerOpen(false);
              setIsAdminPanelOpen(false);
              if (isTrashView) toggleTrashView(false);
              else syncUrl({ page: 'drive' });
            }}
            title="Cloudyte"
            className="flex flex-col items-center gap-1.5 cursor-pointer"
          >
            <span
              className={`rounded-2xl bg-[#2563EB] text-white flex items-center justify-center shadow-lg shadow-blue-600/25 transition-all duration-200 ${
                isDrivesExpanded ? 'w-10 h-10 rounded-[14px]' : 'w-12 h-12'
              }`}
            >
              <Cloud size={isDrivesExpanded ? 20 : 24} fill="currentColor" />
            </span>
            {!isDrivesExpanded && (
              <span className="text-[11px] font-black tracking-tight text-[var(--tx)]">Cloudyte</span>
            )}
          </div>

          {/* Shared Hidden File & Folder Upload Inputs */}
          <input ref={fileUploadInputRef} type="file" className="hidden" onChange={handleUpload} multiple disabled={isTrashView} />
          <input
            ref={folderUploadInputRef}
            type="file"
            className="hidden"
            onChange={handleUpload}
            multiple
            {...({ webkitdirectory: '', directory: '' } as any)}
            disabled={isTrashView}
          />

          <div className={`relative transition-all duration-200 ${isDrivesExpanded ? 'mt-1 mb-2' : 'mt-2 mb-3'}`}>
            <button
              type="button"
              disabled={isTrashView || accounts.length === 0}
              onClick={() => setUploadMenuAnchor(prev => (prev === 'rail' ? null : 'rail'))}
              title={isTrashView ? 'Switch out of Trash to upload' : 'Upload or create folder'}
              className={`bg-[var(--pi)] text-[var(--pit)] flex items-center justify-center hover:opacity-90 active:scale-95 transition-all duration-200 shrink-0 ${
                isDrivesExpanded ? 'w-10 h-10 rounded-[13px]' : 'w-14 h-14 rounded-2xl'
              } ${
                isTrashView || accounts.length === 0 ? 'opacity-40 pointer-events-none' : ''
              }`}
            >
              <Upload size={isDrivesExpanded ? 18 : 22} />
            </button>

            {uploadMenuAnchor === 'rail' && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUploadMenuAnchor(null)} />
                <div
                  className={`fixed top-[92px] w-64 rounded-[22px] bg-[var(--sf)] border border-[var(--bd)] shadow-2xl z-50 p-2 space-y-1 ${
                    isDrivesExpanded ? 'left-[68px]' : 'left-[104px]'
                  }`}
                >
                  <div className="px-3 py-2 border-b border-[var(--bd)]">
                    <p className="text-[10px] font-black uppercase tracking-wider text-[var(--sub)]">Upload to</p>
                    <p className="text-xs font-extrabold text-[var(--tx)] truncate mt-0.5">
                      {(selectedAccount?.name || (isTgDrive ? 'TG Drive' : selectedAccount?.email || 'Drive'))}
                      {path.length > 1 ? ` › ${path.slice(1).map(p => p.name).join(' › ')}` : ' › Files'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setUploadMenuAnchor(null);
                      fileUploadInputRef.current?.click();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                  >
                    <UploadCloud size={16} className="text-[#2563EB]" />
                    <span>Upload files</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setUploadMenuAnchor(null);
                      folderUploadInputRef.current?.click();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                  >
                    <FolderOpen size={16} className="text-[#F59E0B]" />
                    <span>Upload folder</span>
                  </button>
                  <div className="my-1 border-t border-[var(--bd)]" />
                  <button
                    type="button"
                    onClick={() => {
                      setUploadMenuAnchor(null);
                      handleCreateFolder();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                  >
                    <FolderPlus size={16} className="text-[var(--sub)]" />
                    <span>New folder</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Primary Rail Items */}
          <button
            type="button"
            title="Files"
            onClick={() => {
              setIsSettingsOpen(false);
              setIsJobsDrawerOpen(false);
              setIsAdminPanelOpen(false);
              if (isTrashView) toggleTrashView(false);
              else syncUrl({ page: 'drive' });
            }}
            className={`flex flex-col items-center gap-0.5 transition-all duration-200 ${
              isDrivesExpanded ? 'w-12 text-[9.5px]' : 'w-20 text-xs gap-1'
            } ${
              activeNavTab === 'files' ? 'text-[var(--tx)] font-extrabold' : 'text-[var(--sub)] font-semibold hover:text-[var(--tx)]'
            }`}
          >
            <span
              className={`rounded-2xl flex items-center justify-center transition-all duration-200 ${
                isDrivesExpanded ? 'w-10 h-7 rounded-xl' : 'w-14 h-8'
              } ${activeNavTab === 'files' ? 'bg-[var(--pi)] text-[var(--pit)]' : ''}`}
            >
              <Folder size={isDrivesExpanded ? 17 : 20} fill={activeNavTab === 'files' ? 'currentColor' : 'none'} />
            </span>
            <span>Files</span>
          </button>

          <button
            type="button"
            title="Trash"
            onClick={() => {
              toggleTrashView();
            }}
            className={`flex flex-col items-center gap-0.5 transition-all duration-200 ${
              isDrivesExpanded ? 'w-12 text-[9.5px]' : 'w-20 text-xs gap-1'
            } ${
              activeNavTab === 'trash' ? 'text-[var(--tx)] font-extrabold' : 'text-[var(--sub)] font-semibold hover:text-[var(--tx)]'
            }`}
          >
            <span
              className={`rounded-2xl flex items-center justify-center transition-all duration-200 ${
                isDrivesExpanded ? 'w-10 h-7 rounded-xl' : 'w-14 h-8'
              } ${activeNavTab === 'trash' ? 'bg-[var(--pi)] text-[var(--pit)]' : ''}`}
            >
              <Trash2 size={isDrivesExpanded ? 17 : 20} />
            </span>
            <span>Trash</span>
          </button>

          <button
            type="button"
            title="Transfers"
            onClick={() => {
              setIsSettingsOpen(false);
              setIsAdminPanelOpen(false);
              setIsJobsDrawerOpen(true);
              syncUrl({ page: 'jobs' });
            }}
            className={`flex flex-col items-center gap-0.5 transition-all duration-200 relative ${
              isDrivesExpanded ? 'w-12 text-[9.5px]' : 'w-20 text-xs gap-1'
            } ${
              activeNavTab === 'transfers' ? 'text-[var(--tx)] font-extrabold' : 'text-[var(--sub)] font-semibold hover:text-[var(--tx)]'
            }`}
          >
            <span
              className={`rounded-2xl flex items-center justify-center transition-all duration-200 ${
                isDrivesExpanded ? 'w-10 h-7 rounded-xl' : 'w-14 h-8'
              } ${activeNavTab === 'transfers' ? 'bg-[var(--pi)] text-[var(--pit)]' : ''}`}
            >
              <ArrowLeftRight size={isDrivesExpanded ? 17 : 20} />
            </span>
            <span>Transfers</span>
          </button>

          <button
            type="button"
            title="Drives"
            onClick={() => setIsDrivesExpanded(prev => !prev)}
            aria-expanded={isDrivesExpanded}
            className={`flex flex-col items-center gap-0.5 transition-all duration-200 ${
              isDrivesExpanded ? 'w-12 text-[9.5px]' : 'w-20 text-xs gap-1'
            } ${
              activeNavTab === 'drives' ? 'text-[var(--tx)] font-extrabold' : 'text-[var(--sub)] font-semibold hover:text-[var(--tx)]'
            }`}
          >
            <span
              className={`rounded-2xl flex items-center justify-center transition-all duration-200 ${
                isDrivesExpanded ? 'w-10 h-7 rounded-xl' : 'w-14 h-8'
              } ${activeNavTab === 'drives' ? 'bg-[var(--pi)] text-[var(--pit)]' : ''}`}
            >
              <Cloud size={isDrivesExpanded ? 17 : 20} fill={activeNavTab === 'drives' ? 'currentColor' : 'none'} />
            </span>
            <span>Drives</span>
          </button>

          {/* Bottom Rail Items */}
          <div className="mt-auto flex flex-col items-center gap-2.5 w-full">
            <button
              type="button"
              title="Settings"
              onClick={() => {
                setIsJobsDrawerOpen(false);
                setIsAdminPanelOpen(false);
                setSettingsTab('general');
                setIsSettingsOpen(true);
                syncUrl({ page: 'settings', settingsTab: 'general' });
              }}
              className={`flex flex-col items-center gap-0.5 transition-all duration-200 ${
                isDrivesExpanded ? 'w-12 text-[9.5px]' : 'w-20 text-xs gap-1'
              } ${
                activeNavTab === 'settings' || activeNavTab === 'admin'
                  ? 'text-[var(--tx)] font-extrabold'
                  : 'text-[var(--sub)] font-semibold hover:text-[var(--tx)]'
              }`}
            >
              <span
                className={`rounded-2xl flex items-center justify-center transition-all duration-200 ${
                  isDrivesExpanded ? 'w-10 h-7 rounded-xl' : 'w-14 h-8'
                } ${
                  activeNavTab === 'settings' || activeNavTab === 'admin' ? 'bg-[var(--pi)] text-[var(--pit)]' : ''
                }`}
              >
                <Settings size={isDrivesExpanded ? 17 : 20} />
              </span>
              <span>Settings</span>
            </button>
          </div>
        </nav>

        {/* Extended Width Panel: Connected Drives */}
        {isDrivesExpanded && (
          <div className="w-[212px] shrink-0 border-l border-[var(--bd)] bg-[var(--rail)] h-full">
            {renderDrivesPanelContent(false)}
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main
        className="flex-1 flex flex-col min-w-0 bg-[var(--bg)] transition-colors duration-200 relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragging && !isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen && (
          <div className="absolute inset-0 z-50 bg-blue-500/10 backdrop-blur-sm border-4 border-dashed border-blue-500 flex flex-col items-center justify-center pointer-events-none">
            <div className="bg-[var(--sf)] p-8 rounded-full shadow-2xl animate-bounce">
              <Folder size={64} className="text-[#2563EB]" />
            </div>
            <p className="mt-8 text-3xl font-black text-[#2563EB] dark:text-[#60A5FA] drop-shadow-md">Drop files here to upload</p>
          </div>
        )}

        {/* Top Header */}
        <header className="h-16 md:h-[88px] px-4 md:px-8 flex items-center gap-3 sticky top-0 z-40 bg-[var(--bg)] shrink-0">
          {/* Mobile Drive Switcher Pill (or Back to Drive on sub-pages) */}
          {!isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen ? (
            <button
              type="button"
              onClick={() => setIsDrivesExpanded(true)}
              className="md:hidden h-10 pl-1.5 pr-3 rounded-[20px] bg-[var(--sf)] border border-[var(--bd)] flex items-center gap-2 text-sm font-bold text-[var(--tx)] max-w-[200px] shrink-0"
            >
              {renderProviderBadge(selectedAccount?.accountType || 'google', 'sm')}
              <span className="truncate">
                {selectedAccount?.name || (isTgDrive ? 'TG Drive' : selectedAccount?.email || 'Select Drive')}
              </span>
              <ChevronDown size={16} className="text-[var(--sub)] shrink-0" />
            </button>
          ) : (
            <div className="md:hidden flex items-center gap-2">
              <span className="w-8 h-8 rounded-xl bg-[#2563EB] text-white flex items-center justify-center">
                <Cloud size={16} fill="currentColor" />
              </span>
              <span className="text-sm font-extrabold text-[var(--tx)]">
                {isAdminPanelOpen ? 'Admin' : isSettingsOpen ? 'Settings' : 'Transfers'}
              </span>
            </div>
          )}

          {/* Desktop Search Pill (hidden on dedicated sub-pages) */}
          {!isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen && (
            <label className="hidden md:flex flex-1 max-w-[560px] h-14 rounded-[28px] bg-[var(--sf)] border border-[var(--bd)] items-center pl-5 pr-2.5 gap-3 text-[var(--sub)] focus-within:border-[#2563EB] transition-colors">
              <Search size={20} className="shrink-0" />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isTgDrive ? 'Search TG Drive files...' : 'Search in this drive'}
                className="border-0 outline-0 flex-1 min-w-0 text-[15px] font-medium bg-transparent text-[var(--tx)] placeholder:text-[var(--sub)]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="p-1.5 rounded-full hover:bg-[var(--bg)] text-[var(--sub)] hover:text-[var(--tx)]"
                  aria-label="Clear search"
                >
                  <X size={16} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowSearchFilters(prev => !prev)}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors shrink-0 ${
                  showSearchFilters || searchFilterType !== 'all'
                    ? 'bg-[var(--pi)] text-[var(--pit)]'
                    : 'text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)]'
                }`}
                title="Filter by file type"
                aria-label="Toggle type filters"
                aria-pressed={showSearchFilters}
              >
                <SlidersHorizontal size={17} />
              </button>
            </label>
          )}

          <div className="ml-auto flex items-center gap-2.5 md:gap-3 shrink-0">
            {/* Live Wavy Progress Pill (shown only during active upload or running transfers) */}
            {(uploadProgress || runningJobsCount > 0) && (
              <button
                type="button"
                onClick={() => {
                  setIsSettingsOpen(false);
                  setIsAdminPanelOpen(false);
                  setIsJobsDrawerOpen(true);
                  syncUrl({ page: 'jobs' });
                }}
                className="hidden sm:flex items-center gap-2.5 h-10 px-4 rounded-[20px] border border-[var(--bd)] bg-[var(--sf)] text-[13px] font-semibold text-[var(--tx)] hover:border-[#2563EB]/60 transition-colors tabular-nums whitespace-nowrap shrink-0"
                title="View active transfers and uploads"
              >
                <svg width="48" height="12" viewBox="0 0 48 12" aria-hidden="true">
                  <path d="M2 6Q6 1 10 6T18 6T26 6T30 6" fill="none" stroke="#3B82F6" strokeWidth="3" strokeLinecap="round" />
                  <path d="M36 6H46" stroke="#64748B" strokeOpacity=".5" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <span>
                  {uploadProgress
                    ? `Uploading · ${uploadProgress.percent}%`
                    : `${runningJobsCount} active ${runningJobsCount === 1 ? 'transfer' : 'transfers'} · ${runningJobsPct}%`}
                </span>
              </button>
            )}

            {/* Mobile Search Toggle */}
            {!isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen && (
              <button
                type="button"
                onClick={() => setMobileSearchOpen(prev => !prev)}
                className="md:hidden w-9 h-9 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] flex items-center justify-center"
                aria-label="Toggle search"
              >
                {mobileSearchOpen ? <X size={18} /> : <Search size={18} />}
              </button>
            )}

            {/* Theme Toggle Circle */}
            <button
              type="button"
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="w-9 h-9 md:w-10 md:h-10 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)] flex items-center justify-center transition-colors shrink-0"
              title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            {/* Avatar Circle & Account Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsProfileMenuOpen(prev => !prev)}
                className="w-9 h-9 md:w-10 md:h-10 rounded-full bg-[#2563EB] text-white text-[13px] md:text-sm font-extrabold flex items-center justify-center shadow-sm hover:opacity-90 transition-opacity shrink-0"
                title={username ? `@${username}` : 'Account'}
              >
                {userInitials}
              </button>

              {isProfileMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsProfileMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-60 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-2xl z-50 p-2 space-y-1">
                    <div className="px-3 py-2.5 border-b border-[var(--bd)]">
                      <p className="text-sm font-extrabold text-[var(--tx)] truncate">
                        {username ? `@${username}` : 'Account'}
                      </p>
                      <p className="text-[11px] font-semibold text-[var(--sub)] uppercase tracking-wider mt-0.5">
                        {isAdmin ? 'Administrator' : 'Cloudyte Member'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setIsProfileMenuOpen(false);
                        setIsJobsDrawerOpen(false);
                        setIsAdminPanelOpen(false);
                        setSettingsTab('general');
                        setIsSettingsOpen(true);
                        syncUrl({ page: 'settings', settingsTab: 'general' });
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-semibold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                    >
                      <Settings size={16} className="text-[var(--sub)]" />
                      <span>Settings</span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        setIsProfileMenuOpen(false);
                        try { await fetch('/api/logout', { method: 'POST', headers: getAuthHeaders() }); } catch { /* ignore */ }
                        localStorage.removeItem('cloudyte_token');
                        localStorage.removeItem('cloudyte_username');
                        window.history.replaceState(null, '', '/login');
                        window.location.reload();
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-semibold text-rose-500 hover:bg-rose-500/10 transition-colors"
                    >
                      <LogOut size={16} />
                      <span>Log Out</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Mobile Inline Search Bar */}
        {mobileSearchOpen && !isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen && (
          <div className="md:hidden px-4 pb-3 shrink-0">
            <label className="w-full h-11 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] flex items-center pl-3.5 pr-1.5 gap-2 text-[var(--sub)] focus-within:border-[#2563EB]">
              <Search size={16} />
              <input
                autoFocus
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isTgDrive ? 'Search TG Drive files...' : 'Search in this drive'}
                className="border-0 outline-0 flex-1 min-w-0 text-sm font-medium bg-transparent text-[var(--tx)]"
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')} className="p-1 text-[var(--sub)]">
                  <X size={15} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowSearchFilters(prev => !prev)}
                className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors shrink-0 ${
                  showSearchFilters || searchFilterType !== 'all'
                    ? 'bg-[var(--pi)] text-[var(--pit)]'
                    : 'text-[var(--sub)] hover:text-[var(--tx)]'
                }`}
                aria-label="Toggle type filters"
              >
                <SlidersHorizontal size={15} />
              </button>
            </label>
          </div>
        )}

        {/* Dedicated Page / Browser Container */}
        <div className="flex-1 overflow-y-auto px-4 md:px-8 pb-32 md:pb-16 relative scrollbar-thin">
          {isAdminPanelOpen ? (
            <div className="max-w-6xl mx-auto space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setIsAdminPanelOpen(false);
                      setSelectedAdminUserId(null);
                      setSelectedAdminUserDetails(null);
                      setSettingsTab('general');
                      setIsSettingsOpen(true);
                      syncUrl({ page: 'settings', settingsTab: 'general', adminUserId: null });
                    }}
                    className="w-10 h-10 rounded-[20px] bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)] flex items-center justify-center transition-colors shrink-0"
                    title="Back to Settings"
                    aria-label="Back to Settings"
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <div className="w-11 h-11 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/20 shrink-0">
                    <Shield size={20} />
                  </div>
                  <div>
                    <h1 className="text-xl sm:text-2xl font-black text-[var(--tx)] tracking-tight">Admin Control Center</h1>
                    <p className="text-xs font-bold text-[var(--sub)] uppercase tracking-widest">Global Platform Management</p>
                  </div>
                </div>

                <div className="flex items-center gap-1 p-1 bg-[var(--sf)] border border-[var(--bd)] rounded-2xl overflow-x-auto no-scrollbar">
                  {[
                    { id: 'overview', label: 'Overview & Users' },
                    { id: 'metrics', label: 'System Metrics' },
                    { id: 'audit', label: 'Audit Logs' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => {
                        const nextTab = tab.id as any;
                        setAdminTab(nextTab);
                        setSelectedAdminUserId(null);
                        setSelectedAdminUserDetails(null);
                        syncUrl({ page: 'admin', adminTab: nextTab, adminUserId: null });
                      }}
                      className={`px-4 py-2 text-xs font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0 ${
                        adminTab === tab.id
                          ? 'bg-[var(--pi)] text-[var(--pit)]'
                          : 'text-[var(--sub)] hover:text-[var(--tx)]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {adminTab !== 'overview' ? (
                <AdminObservabilityPanel mode={adminTab} getAuthHeaders={getAuthHeaders} />
              ) : (
                <div className="space-y-8">
                  {/* Stats Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
                    {[
                      { label: 'Total Users', value: adminStats?.totalUsers || '0', sub: 'Active accounts' },
                      { label: 'Linked Accounts', value: adminStats?.totalAccounts || '0', sub: 'Cloud endpoints' },
                      { label: 'Managed Files', value: adminStats?.totalFiles || '0', sub: 'Synched resources' },
                    ].map((stat, i) => (
                      <div key={i} className="p-6 sm:p-8 bg-[var(--sf)] rounded-[24px] border border-[var(--bd)]">
                        <p className="text-xs font-black uppercase text-[var(--sub)] tracking-widest mb-1">{stat.label}</p>
                        <p className="text-3xl sm:text-4xl font-black text-[var(--tx)] mb-2 tabular-nums">{stat.value}</p>
                        <p className="text-xs font-bold text-[var(--sub)]">{stat.sub}</p>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* Access Controls */}
                    <div className="space-y-4">
                      <h2 className="text-base font-black text-[var(--tx)] pb-3 border-b border-[var(--bd)] tracking-tight">Access Permissions</h2>
                      <div className="space-y-3">
                        {[
                          { key: 'registrationEnabled', label: 'Global Registration', sub: 'Allow new user signups anywhere' },
                          { key: 'webRegistrationEnabled', label: 'Web Registration', sub: 'Allow signups via browser' },
                          { key: 'botRegistrationEnabled', label: 'Bot Registration', sub: 'Allow signups via Telegram bot' },
                        ].map((reg) => (
                          <div key={reg.key} className="flex items-center justify-between p-5 bg-[var(--sf)] rounded-[22px] border border-[var(--bd)]">
                            <div>
                              <p className="font-bold text-[var(--tx)]">{reg.label}</p>
                              <p className="text-xs text-[var(--sub)] font-medium mt-0.5">{reg.sub}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => toggleRegSetting(reg.key, !adminRegSettings?.[reg.key])}
                              className={`w-14 h-8 rounded-full relative transition-all duration-300 outline-none shrink-0 ${adminRegSettings?.[reg.key] ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'}`}
                            >
                              <div className={`absolute top-1 w-6 h-6 rounded-full bg-white transition-all shadow-md ${adminRegSettings?.[reg.key] ? 'right-1' : 'left-1'}`} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* User Management Section */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between pb-3 border-b border-[var(--bd)]">
                        <h2 className="text-base font-black text-[var(--tx)] tracking-tight">
                          {selectedAdminUserId ? 'User Dossier' : 'Active Users'}
                        </h2>
                        {selectedAdminUserId && (
                          <button
                            type="button"
                            onClick={() => { setSelectedAdminUserId(null); setSelectedAdminUserDetails(null); syncUrl({ page: 'admin', adminTab: 'overview', adminUserId: null }); }}
                            className="text-xs font-black uppercase text-blue-600 dark:text-blue-400 flex items-center gap-1 hover:underline"
                          >
                            <ArrowLeft size={12} /> Back to list
                          </button>
                        )}
                      </div>

                      <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1 no-scrollbar">
                        {selectedAdminUserId ? (
                          loadingUserDetails ? (
                            <div className="flex flex-col items-center justify-center p-12 space-y-4 bg-[var(--sf)] rounded-[24px] border border-[var(--bd)]">
                              <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
                              <p className="text-sm font-bold text-[var(--sub)]">Retrieving user data...</p>
                            </div>
                          ) : selectedAdminUserDetails && (
                            <div className="space-y-6">
                              <div className="flex items-center gap-5 p-6 bg-[var(--sf)] rounded-[24px] border border-[var(--bd)]">
                                <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center text-white text-2xl font-black shrink-0">
                                  {selectedAdminUserDetails.user.username[0].toUpperCase()}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <h3 className="text-xl font-black text-[var(--tx)] truncate">@{selectedAdminUserDetails.user.username}</h3>
                                  <p className="text-xs font-semibold text-[var(--sub)]">Member since {new Date(selectedAdminUserDetails.user.createdAt).toLocaleDateString()}</p>
                                  <div className="flex flex-wrap gap-2 mt-2.5">
                                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase ${selectedAdminUserDetails.user.isActive ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>
                                      {selectedAdminUserDetails.user.isActive ? 'ACTIVE' : 'DISABLED'}
                                    </span>
                                    {selectedAdminUserDetails.user.isAdmin && (
                                      <span className="px-2.5 py-0.5 rounded-full bg-blue-500/15 text-blue-500 text-[10px] font-black uppercase">SYSTEM ADMIN</span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-4">
                                <div className="p-5 bg-[var(--sf)] rounded-[22px] border border-[var(--bd)]">
                                  <p className="text-[10px] font-black text-[var(--sub)] uppercase tracking-widest mb-1">Linked Devices</p>
                                  <p className="text-xl font-black text-[var(--tx)]">{selectedAdminUserDetails.user.tgIds?.length || 0}</p>
                                  <p className="text-[10px] text-[var(--sub)] font-bold">Telegram Accounts</p>
                                </div>
                                <div className="p-5 bg-[var(--sf)] rounded-[22px] border border-[var(--bd)]">
                                  <p className="text-[10px] font-black text-[var(--sub)] uppercase tracking-widest mb-1">Stored Assets</p>
                                  <p className="text-xl font-black text-[var(--tx)]">{selectedAdminUserDetails.stats.fileCount}</p>
                                  <p className="text-[10px] text-[var(--sub)] font-bold">Files across drives</p>
                                </div>
                              </div>

                              <div className="space-y-3">
                                <h4 className="text-xs font-black text-[var(--sub)] uppercase tracking-widest ml-1">Linked Cloud Drives</h4>
                                <div className="space-y-2">
                                  {selectedAdminUserDetails.accounts.map((acc: any) => (
                                    <div key={acc._id} className="p-4 bg-[var(--sf)] rounded-2xl border border-[var(--bd)] flex items-center justify-between">
                                      <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-lg bg-[var(--bg)] flex items-center justify-center text-[var(--sub)]">
                                          {acc.accountType === 'google' ? <HardDrive size={14} /> : acc.accountType === 'onedrive' ? <Cloud size={14} /> : <Share2 size={14} />}
                                        </div>
                                        <div>
                                          <p className="text-xs font-bold text-[var(--tx)]">{acc.email || acc.channelId}</p>
                                          <p className="text-[10px] text-[var(--sub)] font-bold uppercase">{acc.accountType} {acc.isDefault && '• DEFAULT'}</p>
                                        </div>
                                      </div>
                                      <p className="text-[10px] font-bold text-[var(--sub)]">Linked {new Date(acc.linkedAt).toLocaleDateString()}</p>
                                    </div>
                                  ))}
                                  {selectedAdminUserDetails.accounts.length === 0 && (
                                    <div className="p-6 text-center bg-[var(--sf)] rounded-2xl border border-dashed border-[var(--bd)]">
                                      <p className="text-xs font-bold text-[var(--sub)] italic">No drives connected yet</p>
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
                              className="p-4 bg-[var(--sf)] rounded-[20px] flex items-center gap-4 hover:border-[#2563EB]/50 transition-all border border-[var(--bd)] cursor-pointer group"
                            >
                              <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black uppercase transition-transform group-hover:scale-105 ${u.isActive ? 'bg-blue-500/15 text-blue-500' : 'bg-[var(--bg)] text-[var(--sub)]'}`}>
                                {u.username?.[0] || '?'}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold text-[var(--tx)] truncate">@{u.username}</p>
                                <p className="text-[10px] text-[var(--sub)] font-bold uppercase tracking-widest">{u.accountCount} Drives • {u.isActive ? 'Active' : 'Disabled'}</p>
                              </div>
                              <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                                {!u.isAdmin && (
                                  <>
                                    <button type="button" onClick={() => handleToggleUser(u.id, u.isActive)} className={`p-2 rounded-lg transition-all ${u.isActive ? 'text-amber-500 hover:bg-amber-500/10' : 'text-emerald-500 hover:bg-emerald-500/10'}`} title={u.isActive ? 'Disable' : 'Enable'}>
                                      <LogOut size={16} />
                                    </button>
                                    <button type="button" onClick={() => handleDeleteUser(u.id)} className="p-2 text-rose-500 hover:bg-rose-500/10 rounded-lg transition-all" title="Delete Permanent">
                                      <Trash2 size={16} />
                                    </button>
                                  </>
                                )}
                                {u.isAdmin && (
                                  <div className="px-2.5 py-1 bg-blue-500/15 text-blue-500 text-[9px] font-black uppercase rounded-lg">Admin</div>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : isSettingsOpen ? (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => { setIsSettingsOpen(false); syncUrl({ page: 'drive' }); }}
                    className="w-10 h-10 rounded-[20px] bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)] flex items-center justify-center transition-colors shrink-0"
                    title="Back to Drive"
                    aria-label="Back to Drive"
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <div className="w-11 h-11 rounded-2xl bg-[var(--pi)] text-[var(--pit)] flex items-center justify-center shrink-0">
                    <Settings size={20} />
                  </div>
                  <div>
                    <h1 className="text-xl sm:text-2xl font-black text-[var(--tx)] tracking-tight">Settings</h1>
                    <p className="text-xs sm:text-sm text-[var(--sub)] font-medium">Manage preferences, active sessions, access tokens, and shared links</p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 p-1 bg-[var(--sf)] border border-[var(--bd)] rounded-2xl overflow-x-auto no-scrollbar w-fit max-w-full">
                {[
                  { id: 'general', label: 'General' },
                  { id: 'sessions', label: 'Active Sessions' },
                  { id: 'tokens', label: 'Access Tokens' },
                  { id: 'shares', label: 'Shared Links' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      const nextTab = tab.id as any;
                      setSettingsTab(nextTab);
                      syncUrl({ page: 'settings', settingsTab: nextTab });
                    }}
                    className={`px-4 py-2 text-xs font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0 ${
                      settingsTab === tab.id
                        ? 'bg-[var(--pi)] text-[var(--pit)]'
                        : 'text-[var(--sub)] hover:text-[var(--tx)]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="space-y-6">
                {settingsTab !== 'general' ? (
                  <SecuritySettingsTabs
                    activeTab={settingsTab}
                    accounts={accounts}
                    getAuthHeaders={getAuthHeaders}
                    onToast={showToast}
                  />
                ) : !userProfile ? (
                  <div className="flex flex-col items-center justify-center p-12 space-y-4 bg-[var(--sf)] border border-[var(--bd)] rounded-[24px]">
                    <RefreshCw size={24} className="animate-spin text-blue-500" />
                    <p className="text-xs font-bold text-[var(--sub)]">Loading profile...</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {isAdmin && (
                      <div
                        onClick={() => {
                          setIsSettingsOpen(false);
                          setAdminTab('overview');
                          setSelectedAdminUserId(null);
                          setSelectedAdminUserDetails(null);
                          setIsAdminPanelOpen(true);
                          syncUrl({ page: 'admin', adminTab: 'overview', adminUserId: null });
                        }}
                        className="p-5 sm:p-6 bg-[var(--sf)] border border-[var(--bd)] hover:border-[#2563EB] rounded-[24px] flex items-center justify-between gap-4 cursor-pointer transition-colors group"
                      >
                        <div className="flex items-center gap-4 min-w-0">
                          <div className="w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/20 shrink-0">
                            <Shield size={22} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <h2 className="text-base font-extrabold text-[var(--tx)]">Admin Control Center</h2>
                              <span className="px-2 py-0.5 rounded-full bg-[var(--pi)] text-[var(--pit)] text-[10px] font-black uppercase tracking-wider">Admin</span>
                            </div>
                            <p className="text-xs text-[var(--sub)] font-medium mt-0.5 truncate">
                              Manage users, registration permissions, system metrics &amp; audit logs
                            </p>
                          </div>
                        </div>
                        <span className="h-9 px-4 rounded-[18px] bg-[var(--pi)] text-[var(--pit)] text-xs font-bold flex items-center gap-1.5 shrink-0 group-hover:opacity-90">
                          <span>Open</span>
                          <ChevronRight size={15} />
                        </span>
                      </div>
                    )}

                    <div className="space-y-3">
                      <h3 className="text-[11px] font-black uppercase text-[var(--sub)] tracking-[0.18em] px-1">Identity &amp; Access</h3>
                      <div className="p-5 sm:p-6 bg-[var(--sf)] border border-[var(--bd)] rounded-[24px] space-y-4">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-[#2563EB] rounded-2xl flex items-center justify-center text-white font-black text-xl shadow-lg shadow-blue-600/20">
                            {userProfile?.username?.[0]?.toUpperCase()}
                          </div>
                          <div>
                            <p className="text-sm font-black text-[var(--tx)]">@{userProfile?.username}</p>
                            <p className="text-[10px] text-[var(--sub)] font-bold uppercase tracking-wider">Cloudyte ID</p>
                          </div>
                        </div>

                        <div className="pt-4 border-t border-[var(--bd)] space-y-3">
                          <p className="text-[10px] font-black text-[var(--sub)] uppercase tracking-widest">Linked Telegram accounts</p>
                          <div className="flex flex-wrap gap-2">
                            {userProfile?.tgIds?.length > 0 ? (
                              userProfile.tgIds.map((tid: string) => (
                                <span key={tid} className="px-3 py-1 bg-[var(--pi)] text-[var(--pit)] text-[10px] font-black rounded-lg">
                                  ID: {tid}
                                </span>
                              ))
                            ) : (
                              <p className="text-xs text-[var(--sub)] font-medium italic">No Telegram accounts linked</p>
                            )}
                          </div>
                          <div className="bg-[var(--bg)] p-3.5 rounded-2xl border border-[var(--bd)]">
                            <p className="text-xs text-[var(--sub)] font-semibold">To link/unlink Telegram, use the bot's /login and /logout commands.</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h3 className="text-[11px] font-black uppercase text-[var(--sub)] tracking-[0.18em] px-1">Appearance &amp; Behavior</h3>
                      <div className="flex items-center justify-between p-5 bg-[var(--sf)] border border-[var(--bd)] rounded-[24px]">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-purple-500/15 rounded-xl flex items-center justify-center text-purple-500"><Eye size={20} /></div>
                          <div>
                            <p className="text-sm font-bold text-[var(--tx)]">Image Thumbnails</p>
                            <p className="text-xs text-[var(--sub)]">Show inline previews for image files</p>
                          </div>
                        </div>
                        <button type="button" onClick={() => updateUserSettings({ showThumbnails: !(userSettings?.showThumbnails ?? true) })} className={`w-12 h-6 rounded-full transition-all relative ${(userSettings?.showThumbnails ?? true) ? 'bg-purple-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
                          <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${(userSettings?.showThumbnails ?? true) ? 'left-7' : 'left-1'}`} />
                        </button>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h3 className="text-[11px] font-black uppercase text-[var(--sub)] tracking-[0.18em] px-1">Sync &amp; Automation</h3>
                      <div className="p-5 bg-[var(--sf)] border border-[var(--bd)] rounded-[24px] space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-blue-500/15 rounded-xl flex items-center justify-center text-blue-500"><RefreshCw size={20} /></div>
                            <div>
                              <p className="text-sm font-bold text-[var(--tx)]">Auto-Mirror (Backup)</p>
                              <p className="text-xs text-[var(--sub)]">Mirror bot uploads to backup drive</p>
                            </div>
                          </div>
                          <button type="button" onClick={() => updateUserSettings({ backupEnabled: !userSettings?.backupEnabled })} className={`w-12 h-6 rounded-full transition-all relative ${userSettings?.backupEnabled ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
                            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${userSettings?.backupEnabled ? 'left-7' : 'left-1'}`} />
                          </button>
                        </div>
                        <div className="space-y-2 pt-2 border-t border-[var(--bd)]">
                          <label className="text-xs font-bold text-[var(--sub)] px-1">Backup Account</label>
                          <select value={userSettings?.backupAccId || ''} onChange={e => updateUserSettings({ backupAccId: e.target.value })} className="w-full bg-[var(--bg)] border border-[var(--bd)] p-3.5 rounded-2xl text-sm font-bold text-[var(--tx)] outline-none focus:border-[#2563EB]">
                            <option value="">Select Backup Account</option>
                            {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.accountType === 'tgdrive' ? `📡 TG Drive (${acc.channelId})` : acc.email}</option>)}
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h3 className="text-[11px] font-black uppercase text-[var(--sub)] tracking-[0.18em] px-1">Connected Accounts</h3>
                      <div className="space-y-3">
                        {accounts.map(acc => {
                          const isMenuOpen = openAccountMenuId === acc.id;
                          const displayName = acc.name || (acc.accountType === 'tgdrive' ? 'TG Drive' : 'Account');
                          return (
                            <div key={acc.id} className="flex items-center justify-between gap-3 p-4 bg-[var(--sf)] border border-[var(--bd)] rounded-[22px] relative">
                              <div className="flex items-center gap-3 min-w-0">
                                {renderProviderBadge(acc.accountType, 'md')}
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <p className="text-sm font-bold truncate text-[var(--tx)]">{displayName}</p>
                                    {acc.isDefault && (
                                      <span className="px-2 py-0.5 rounded-full bg-[var(--pi)] text-[var(--pit)] text-[10px] font-extrabold uppercase tracking-wider shrink-0">
                                        Default
                                      </span>
                                    )}
                                    {acc.error && (
                                      <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-500 text-[10px] font-extrabold uppercase tracking-wider shrink-0">
                                        Needs reconnect
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-[var(--sub)] truncate mt-0.5">{acc.email}</p>
                                </div>
                              </div>

                              <div className="flex items-center gap-1 shrink-0">
                                {acc.error && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (acc.accountType === 'tgdrive') {
                                        setTgDriveModal(true);
                                        syncUrl({ modal: 'tg-drive' });
                                      } else {
                                        handleConnect(acc.accountType === 'onedrive' ? 'onedrive' : 'google');
                                      }
                                    }}
                                    className="px-3 h-8 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition-colors"
                                  >
                                    Reconnect
                                  </button>
                                )}
                                <div className="relative">
                                  <button
                                    type="button"
                                    onClick={() => setOpenAccountMenuId(prev => (prev === acc.id ? null : acc.id))}
                                    className="w-9 h-9 rounded-xl text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)] flex items-center justify-center transition-colors"
                                    aria-label={`Account actions for ${displayName}`}
                                  >
                                    <MoreVertical size={17} />
                                  </button>
                                  {isMenuOpen && (
                                    <>
                                      <div className="fixed inset-0 z-40" onClick={() => setOpenAccountMenuId(null)} />
                                      <div className="absolute right-0 mt-1.5 w-48 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-2xl z-50 p-1.5 space-y-0.5">
                                        {!acc.isDefault && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setOpenAccountMenuId(null);
                                              handleSetDefaultAccount(acc.id);
                                            }}
                                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                                          >
                                            <Check size={14} className="text-[#2563EB]" />
                                            <span>Set as default</span>
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setOpenAccountMenuId(null);
                                            if (acc.accountType === 'tgdrive') {
                                              setTgDriveModal(true);
                                              syncUrl({ modal: 'tg-drive' });
                                            } else {
                                              handleConnect(acc.accountType === 'onedrive' ? 'onedrive' : 'google');
                                            }
                                          }}
                                          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                                        >
                                          <RefreshCw size={14} className="text-[var(--sub)]" />
                                          <span>Reconnect</span>
                                        </button>
                                        <div className="my-1 border-t border-[var(--bd)]" />
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setOpenAccountMenuId(null);
                                            handleUnlink(acc);
                                          }}
                                          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-bold text-rose-500 hover:bg-rose-500/10 transition-colors"
                                        >
                                          <Trash2 size={14} />
                                          <span>Disconnect</span>
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        <button type="button" onClick={() => { setIsSettingsOpen(false); setLinkProviderModal(true); syncUrl({ page: 'drive', modal: 'link-account' }); }} className="w-full flex items-center justify-center gap-2 py-3.5 border-2 border-dashed border-[var(--bd)] rounded-[22px] text-sm font-bold text-[var(--sub)] hover:text-[#2563EB] hover:border-[#2563EB] transition-all">
                          <Plus size={16} /><span>Link Another Account</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : isJobsDrawerOpen ? (
            <JobsDrawer
              variant="page"
              isOpen={isJobsDrawerOpen}
              onClose={() => { setIsJobsDrawerOpen(false); syncUrl({ page: 'drive' }); }}
              getAuthHeaders={getAuthHeaders}
              onToast={showToast}
              onJobsChanged={() => {
                if (selectedAccountId) fetchFiles(selectedAccountId, currentFolderId, debouncedSearch, isTrashView);
              }}
            />
          ) : loading && accounts.length === 0 ? (
            <div className="space-y-6">
              <div className="h-12 w-72 bg-[var(--sf)] border border-[var(--bd)] rounded-[24px] animate-pulse" />
              <div className="space-y-1">
                {[...Array(8)].map((_, i) => (
                  <div
                    key={i}
                    className={`h-16 bg-[var(--sf)] border border-[var(--bd)] animate-pulse ${getRowRadiusClass(i, 8)}`}
                  />
                ))}
              </div>
            </div>
          ) : !loading && accounts.length === 0 ? (
            <div className="max-w-xl mx-auto py-8 md:py-14 space-y-6">
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-[22px] bg-[#2563EB] text-white flex items-center justify-center mx-auto shadow-xl shadow-blue-600/25">
                  <Cloud size={32} fill="currentColor" />
                </div>
                <h1 className="text-2xl sm:text-3xl font-black text-[var(--tx)] tracking-tight">
                  Welcome to Cloudyte
                </h1>
                <p className="text-sm text-[var(--sub)] font-medium max-w-md mx-auto leading-relaxed">
                  Connect your first cloud storage drive to browse, preview, upload, and transfer files across providers from one workspace.
                </p>
              </div>

              <div className="bg-[var(--sf)] border border-[var(--bd)] rounded-[28px] p-4 sm:p-5 space-y-2.5">
                {[
                  {
                    id: 'google' as const,
                    title: 'Google Drive',
                    subtitle: 'Personal Gmail or Google Workspace storage',
                    badge: renderProviderBadge('google', 'md'),
                  },
                  {
                    id: 'onedrive' as const,
                    title: 'Microsoft OneDrive',
                    subtitle: 'Outlook, Microsoft 365 & OneDrive cloud storage',
                    badge: renderProviderBadge('onedrive', 'md'),
                  },
                  {
                    id: 'tgdrive' as const,
                    title: 'Telegram Drive',
                    subtitle: 'Connect a Telegram channel for unlimited storage',
                    badge: renderProviderBadge('tgdrive', 'md'),
                  },
                ].map((opt) => {
                  const selected = welcomeProvider === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setWelcomeProvider(opt.id)}
                      className={`w-full flex items-center gap-3.5 p-3.5 rounded-[20px] border text-left transition-all ${
                        selected
                          ? 'bg-[var(--sel)] border-[#2563EB]'
                          : 'bg-[var(--bg)]/50 border-[var(--bd)] hover:border-[var(--sub)]/40'
                      }`}
                    >
                      {opt.badge}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-extrabold text-[var(--tx)]">{opt.title}</p>
                        <p className="text-xs text-[var(--sub)] truncate mt-0.5">{opt.subtitle}</p>
                      </div>
                      <span
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                          selected
                            ? 'border-[#2563EB] bg-[#2563EB] text-white'
                            : 'border-[var(--sub)]/50'
                        }`}
                      >
                        {selected && <span className="w-2 h-2 rounded-full bg-white" />}
                      </span>
                    </button>
                  );
                })}

                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (welcomeProvider === 'google') handleConnect('google');
                      else if (welcomeProvider === 'onedrive') handleConnect('onedrive');
                      else {
                        setTgDriveModal(true);
                        setTgRegisterError('');
                        setTgChannelInput('');
                        syncUrl({ modal: 'tg-drive' });
                      }
                    }}
                    className="w-full h-12 rounded-[24px] bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20 active:scale-[0.99] transition-all"
                  >
                    <span>
                      {welcomeProvider === 'google'
                        ? 'Continue with Google'
                        : welcomeProvider === 'onedrive'
                        ? 'Continue with OneDrive'
                        : 'Connect Telegram Channel'}
                    </span>
                    <ChevronRight size={17} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Breadcrumbs & Toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar max-w-full py-1">
                  {path.map((item, idx) => {
                    const isLast = !isTrashView && idx === path.length - 1;
                    return (
                      <React.Fragment key={idx}>
                        <button
                          type="button"
                          onClick={() => {
                            navigateUp(idx);
                          }}
                          className={`flex items-center gap-2 py-1 px-1 text-[15px] md:text-base whitespace-nowrap shrink-0 transition-colors ${
                            isLast
                              ? 'text-[var(--tx)] font-extrabold'
                              : 'font-semibold text-[var(--sub)] hover:text-[var(--tx)]'
                          }`}
                        >
                          {idx === 0 && (
                            <Folder
                              size={19}
                              className={isLast ? 'text-[#2563EB] shrink-0' : 'text-[var(--sub)] shrink-0'}
                              fill={isLast ? 'currentColor' : 'none'}
                            />
                          )}
                          <span>{idx === 0 ? 'Files' : item.name}</span>
                        </button>
                        {idx < path.length - 1 && (
                          <ChevronRight size={16} className="text-[var(--sub)] shrink-0" />
                        )}
                      </React.Fragment>
                    );
                  })}
                  {isTrashView && (
                    <>
                      <ChevronRight size={16} className="text-[var(--sub)] shrink-0" />
                      <span className="flex items-center gap-1.5 py-1 px-1 text-[15px] md:text-base font-extrabold text-rose-500 whitespace-nowrap shrink-0">
                        <Trash2 size={16} />
                        <span>Trash</span>
                      </span>
                    </>
                  )}
                </div>

                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setViewMode(prev => (prev === 'list' ? 'grid' : 'list'))}
                    className="w-10 h-10 rounded-[20px] flex items-center justify-center text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)] transition-colors"
                    title={viewMode === 'list' ? 'Switch to Grid View' : 'Switch to List View'}
                    aria-label={viewMode === 'list' ? 'Switch to Grid View' : 'Switch to List View'}
                  >
                    {viewMode === 'list' ? <LayoutGrid size={20} /> : <ListIcon size={20} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => selectedAccountId && fetchFiles(selectedAccountId, currentFolderId, searchQuery, isTrashView)}
                    className="w-10 h-10 rounded-[20px] flex items-center justify-center text-[var(--sub)] hover:bg-[var(--sf)] transition-colors"
                    title="Refresh"
                    aria-label="Refresh"
                  >
                    <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                  </button>
                  {isTrashView ? (
                    <div className="flex items-center gap-1.5 ml-1">
                      <button
                        type="button"
                        onClick={() => toggleTrashView(false)}
                        className="h-10 px-4 rounded-[20px] bg-[var(--tonal)] text-[var(--tonalt)] text-sm font-bold flex items-center gap-2 hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                      >
                        <ArrowLeft size={16} />
                        <span className="hidden sm:inline">Back to Drive</span>
                      </button>
                      {files.length > 0 && (
                        <button
                          type="button"
                          onClick={handleEmptyTrash}
                          className="h-10 px-4 rounded-[20px] bg-rose-600 text-white text-sm font-bold flex items-center gap-2 hover:bg-rose-700 transition-colors whitespace-nowrap shrink-0"
                        >
                          <Trash2 size={16} />
                          <span>Empty Trash</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={handleCreateFolder}
                      className="h-10 px-4 md:px-5 rounded-[20px] bg-[var(--tonal)] text-[var(--tonalt)] text-sm font-bold flex items-center gap-2 ml-1 hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                    >
                      <FolderPlus size={18} />
                      <span className="hidden sm:inline">New folder</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Lightweight Search Type Filter Chips */}
              {(showSearchFilters || searchFilterType !== 'all') && (
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                  {[
                    { id: 'all', label: 'All' },
                    { id: 'folder', label: 'Folders' },
                    { id: 'pdf', label: 'PDF' },
                    { id: 'image', label: 'Images' },
                    { id: 'video', label: 'Videos' },
                    { id: 'doc', label: 'Docs' },
                  ].map((chip) => {
                    const isActive = searchFilterType === chip.id;
                    return (
                      <button
                        key={chip.id}
                        type="button"
                        onClick={() => setSearchFilterType(chip.id as any)}
                        className={`h-8 px-3.5 rounded-[14px] text-xs font-bold flex items-center gap-1.5 border transition-colors whitespace-nowrap shrink-0 ${
                          isActive
                            ? 'bg-[var(--pi)] text-[var(--pit)] border-transparent'
                            : 'bg-[var(--sf)] text-[var(--sub)] border-[var(--bd)] hover:text-[var(--tx)]'
                        }`}
                      >
                        {isActive && <Check size={13} strokeWidth={2.75} />}
                        <span>{chip.label}</span>
                      </button>
                    );
                  })}
                  {(searchFilterType !== 'all' || searchQuery) && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchFilterType('all');
                        setSearchQuery('');
                      }}
                      className="h-8 px-2.5 rounded-[14px] text-xs font-semibold text-[var(--sub)] hover:text-[var(--tx)] whitespace-nowrap shrink-0"
                    >
                      Reset
                    </button>
                  )}
                </div>
              )}

              {/* Inline Non-Blocking Account & Storage Alert Banners */}
              {!isTrashView && selectedAccount?.error && (
                <div className="rounded-[20px] px-4 py-3 bg-rose-500/12 border border-rose-500/30 text-rose-600 dark:text-rose-400 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 rounded-xl bg-rose-500/15 flex items-center justify-center shrink-0">
                      <AlertTriangle size={17} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-extrabold truncate">
                        {selectedAccount.name || selectedAccount.email || 'This drive'} needs to reconnect
                      </p>
                      <p className="text-[11px] opacity-85 truncate">
                        Refresh authorization to continue browsing and uploading files.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedAccount.accountType === 'tgdrive') {
                        setTgDriveModal(true);
                        syncUrl({ modal: 'tg-drive' });
                      } else {
                        handleConnect(selectedAccount.accountType === 'onedrive' ? 'onedrive' : 'google');
                      }
                    }}
                    className="h-8 px-3.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shrink-0 transition-colors"
                  >
                    Reconnect
                  </button>
                </div>
              )}

              {!isTrashView && !selectedAccount?.error && selectedAccount?.accountType !== 'tgdrive' && Number(selectedAccount?.percentage || 0) >= 90 && (
                <div className="rounded-[20px] px-4 py-3 bg-amber-500/12 border border-amber-500/30 text-amber-700 dark:text-amber-300 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
                      <AlertTriangle size={17} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-extrabold truncate">
                        {selectedAccount.name || selectedAccount.email} is {selectedAccount.percentage}% full
                      </p>
                      <p className="text-[11px] opacity-85 truncate">
                        {selectedAccount.usage} of {selectedAccount.total} used — move or archive files to another drive to free up space.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsDrivesExpanded(true)}
                    className="h-8 px-3.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 text-xs font-bold shrink-0 transition-colors"
                  >
                    Switch Drive
                  </button>
                </div>
              )}

              {/* File list / grid */}
              <div className="relative">
                {loading && displayedFiles.length > 0 && (
                  <div className="mb-2 h-1 bg-[var(--pi)] rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: '0%', x: '-100%' }}
                      animate={{ width: '100%', x: '100%' }}
                      transition={{ repeat: Infinity, duration: 1.2, ease: 'easeInOut' }}
                      className="h-full bg-[#2563EB] rounded-full"
                    />
                  </div>
                )}

                {loading && displayedFiles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-32 text-[var(--sub)] gap-4">
                    <RefreshCw size={40} className="animate-spin text-[#2563EB]" />
                    <p className="text-sm font-semibold">{isTrashView ? 'Loading trash...' : 'Loading files...'}</p>
                  </div>
                ) : displayedFiles.length === 0 ? (
                  isTrashView ? (
                    <div className="flex flex-col items-center justify-center py-24 text-[var(--sub)] gap-5">
                      <div className="w-20 h-20 rounded-3xl bg-[var(--sf)] border border-[var(--bd)] flex items-center justify-center">
                        <Trash2 size={36} />
                      </div>
                      <div className="text-center space-y-1">
                        <p className="text-lg font-bold text-[var(--tx)]">Trash is empty</p>
                        <p className="text-sm text-[var(--sub)]">
                          Deleted files from this drive will appear here for recovery or permanent removal.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleTrashView(false)}
                        className="h-10 px-6 rounded-[20px] bg-[var(--pi)] text-[var(--pit)] font-bold text-sm hover:opacity-90 transition-opacity"
                      >
                        Back to Drive
                      </button>
                    </div>
                  ) : (debouncedSearch.trim() || searchFilterType !== 'all') ? (
                    <div className="flex flex-col items-center justify-center py-24 text-[var(--sub)] gap-4">
                      <div className="w-16 h-16 rounded-3xl bg-[var(--sf)] border border-[var(--bd)] flex items-center justify-center">
                        <Search size={28} />
                      </div>
                      <div className="text-center space-y-1 max-w-sm">
                        <p className="text-lg font-bold text-[var(--tx)]">
                          {debouncedSearch.trim() ? `No results for "${debouncedSearch.trim()}"` : `No matching ${searchFilterType} files`}
                        </p>
                        <p className="text-sm text-[var(--sub)]">
                          Try another keyword, clear your type filter, or check another folder.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {debouncedSearch.trim() && (
                          <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            className="h-10 px-5 rounded-[20px] bg-[var(--pi)] text-[var(--pit)] font-bold text-sm hover:opacity-90 transition-opacity"
                          >
                            Clear search
                          </button>
                        )}
                        {searchFilterType !== 'all' && (
                          <button
                            type="button"
                            onClick={() => setSearchFilterType('all')}
                            className="h-10 px-5 rounded-[20px] bg-[var(--sf)] border border-[var(--bd)] text-[var(--tx)] font-bold text-sm hover:border-[var(--sub)]/50 transition-colors"
                          >
                            Show all types
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="border-2 border-dashed border-[var(--bd)] rounded-[28px] bg-[var(--sf)]/50 flex flex-col items-center justify-center py-20 px-6 text-[var(--sub)] gap-4">
                      <div className="w-16 h-16 rounded-3xl bg-[var(--sf)] border border-[var(--bd)] flex items-center justify-center text-[#2563EB]">
                        {isTgDrive ? <TelegramIcon size={32} /> : <UploadCloud size={32} />}
                      </div>
                      <div className="text-center space-y-1 max-w-sm">
                        <p className="text-lg font-bold text-[var(--tx)]">This folder is empty</p>
                        <p className="text-sm text-[var(--sub)]">
                          {isTgDrive
                            ? 'Drop files here or upload to store them in this Telegram channel.'
                            : 'Drop files anywhere here or upload to add items to this folder.'}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                        <label className="h-10 px-6 rounded-[20px] bg-[#2563EB] text-white font-bold text-sm flex items-center gap-2 cursor-pointer hover:opacity-90 transition-opacity">
                          <Upload size={16} />
                          <span>Upload Files</span>
                          <input type="file" className="hidden" onChange={handleUpload} multiple />
                        </label>
                        <button
                          type="button"
                          onClick={handleCreateFolder}
                          className="h-10 px-5 rounded-[20px] bg-[var(--sf)] border border-[var(--bd)] text-[var(--tx)] font-bold text-sm flex items-center gap-2 hover:border-[var(--sub)]/50 transition-colors"
                        >
                          <FolderPlus size={16} />
                          <span>New folder</span>
                        </button>
                      </div>
                    </div>
                  )
                ) : viewMode === 'list' ? (
                  <>
                    {/* Desktop List Header */}
                    <div className="hidden md:grid grid-cols-[44px_1fr_140px_100px_140px] gap-4 items-center px-5 h-8 text-[10px] font-black uppercase tracking-[0.08em] text-[var(--sub)]">
                      <div className="flex items-center justify-center">
                        <input
                          type="checkbox"
                          aria-label="Select all files"
                          className="w-4 h-4 rounded border-[var(--bd)] text-[#2563EB] focus:ring-[#2563EB] cursor-pointer"
                          checked={displayedFiles.length > 0 && selectedFileIds.size === displayedFiles.length}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedFileIds(new Set(displayedFiles.map(f => f.id)));
                            else setSelectedFileIds(new Set());
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'))}
                        className="flex items-center gap-1 text-left text-[var(--tx)] font-black uppercase tracking-[0.08em]"
                      >
                        <span>Name</span>
                        {sortOrder === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                      </button>
                      <span>Modified</span>
                      <span>Size</span>
                      <span />
                    </div>

                    {/* Desktop Connected Stack Rows */}
                    <div className="hidden md:flex flex-col gap-[2px]">
                      {displayedFiles.map((file, idx) => {
                        const isChecked = selectedFileIds.has(file.id);
                        const isFocused = selectedFile?.id === file.id;
                        return (
                          <div
                            key={file.id}
                            onClick={(e) => handleSingleClick(file, e)}
                            onDoubleClick={(e) => handleDoubleClick(file, e)}
                            className={`group grid grid-cols-[44px_1fr_140px_100px_140px] gap-4 items-center px-5 py-2.5 cursor-pointer transition-colors duration-150 ${getRowRadiusClass(idx, displayedFiles.length)} ${
                              isChecked || isFocused ? 'bg-[var(--sel)]' : 'bg-[var(--sf)] hover:bg-[var(--sel)]/50'
                            }`}
                          >
                            <div
                              className="flex items-center justify-center relative"
                              onClick={(e) => toggleSelection(e, file.id)}
                              title={isChecked ? 'Deselect' : 'Select'}
                            >
                              <FileIcon
                                file={file}
                                type={file.type}
                                isTg={file.isTgDrive}
                                accountId={selectedAccountId}
                                showThumbnails={userSettings?.showThumbnails !== false}
                              />
                              <span
                                className={`absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center transition-opacity ${
                                  isChecked
                                    ? 'bg-[#2563EB] text-white ring-2 ring-[var(--sel)] opacity-100'
                                    : 'bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] opacity-0 group-hover:opacity-100'
                                }`}
                              >
                                <Check size={10} strokeWidth={3} />
                              </span>
                            </div>

                            <div className="min-w-0">
                              <p className="text-[15px] font-semibold text-[var(--tx)] truncate">{file.name}</p>
                            </div>

                            <span className="text-sm font-medium text-[var(--sub)] truncate tabular-nums">{file.modified || '—'}</span>

                            <span className="font-mono text-[13px] text-[var(--sub)] tabular-nums truncate">
                              {file.type === 'folder' ? '—' : file.size}
                            </span>

                            <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                {isTrashView ? (
                                  <>
                                    <button onClick={() => handleRestoreFile(file.id)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-emerald-500" title="Restore">
                                      <RotateCcw size={15} />
                                    </button>
                                    <button onClick={() => handlePermanentDeleteFile(file.id)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-rose-500" title="Delete Forever">
                                      <Trash2 size={15} />
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    {file.type !== 'folder' && (
                                      <button onClick={() => openPreview(file)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-[#2563EB]" title="Preview">
                                        <Eye size={15} />
                                      </button>
                                    )}
                                    {file.type !== 'folder' && (
                                      <button onClick={() => handleDownload(file.id)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-[#2563EB]" title="Download">
                                        <Download size={15} />
                                      </button>
                                    )}
                                    <button onClick={() => handleRename(file.id, file.name)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-[#2563EB]" title="Rename">
                                      <Edit3 size={15} />
                                    </button>
                                  </>
                                )}
                              </div>
                              {isChecked ? (
                                <button
                                  type="button"
                                  onClick={(e) => toggleSelection(e, file.id)}
                                  className="p-1 text-[#60A5FA] hover:opacity-80"
                                  title="Selected"
                                >
                                  <CheckCircle2 size={20} fill="currentColor" className="text-[#2563EB]" />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    setContextMenu({ file, x: rect.left - 160, y: rect.bottom });
                                  }}
                                  className="p-1 rounded-lg text-[var(--sub)] hover:text-[var(--tx)]"
                                  title="More actions"
                                >
                                  <MoreVertical size={18} />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Mobile Connected Stack Rows (.l3) */}
                    <div className="md:hidden flex flex-col gap-[2px]">
                      {displayedFiles.map((file, idx) => {
                        const isChecked = selectedFileIds.has(file.id);
                        return (
                          <div
                            key={file.id}
                            onClick={(e) => handleSingleClick(file, e)}
                            className={`grid grid-cols-[40px_1fr_28px] gap-3.5 items-center px-4 py-2.5 cursor-pointer transition-colors ${getRowRadiusClass(idx, displayedFiles.length)} ${
                              isChecked ? 'bg-[var(--sel)]' : 'bg-[var(--sf)]'
                            }`}
                          >
                            <div onClick={(e) => toggleSelection(e, file.id)}>
                              <FileIcon
                                file={file}
                                type={file.type}
                                isTg={file.isTgDrive}
                                accountId={selectedAccountId}
                                showThumbnails={userSettings?.showThumbnails !== false}
                              />
                            </div>
                            <div className="min-w-0">
                              <p className="text-[15px] font-semibold text-[var(--tx)] truncate">{file.name}</p>
                              <p className="text-[12.5px] font-medium text-[var(--sub)] truncate mt-0.5">
                                {file.type === 'folder'
                                  ? `Folder · ${file.modified || '—'}`
                                  : `${file.modified || '—'} · ${file.size}`}
                              </p>
                            </div>
                            <div onClick={(e) => e.stopPropagation()} className="flex justify-end">
                              {isChecked ? (
                                <button type="button" onClick={(e) => toggleSelection(e, file.id)}>
                                  <CheckCircle2 size={20} fill="currentColor" className="text-[#2563EB]" />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    setContextMenu({ file, x: rect.left - 160, y: rect.bottom });
                                  }}
                                  className="p-1 text-[var(--sub)]"
                                >
                                  <MoreVertical size={18} />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="space-y-5">
                    {gridFolders.length > 0 && (
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--sub)] mb-2">Folders</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                          {gridFolders.map(folder => {
                            const isChecked = selectedFileIds.has(folder.id);
                            return (
                              <div
                                key={folder.id}
                                onClick={(e) => handleSingleClick(folder, e)}
                                onDoubleClick={(e) => handleDoubleClick(folder, e)}
                                className={`group h-[60px] px-4 rounded-[20px] border flex items-center gap-3 cursor-pointer transition-colors ${
                                  isChecked || selectedFile?.id === folder.id
                                    ? 'bg-[var(--sel)] border-[#2563EB]'
                                    : 'bg-[var(--sf)] border-[var(--bd)] hover:border-[var(--sub)]/50'
                                }`}
                              >
                                <div onClick={(e) => toggleSelection(e, folder.id)} className="shrink-0 relative w-6 h-6 flex items-center justify-center">
                                  {isChecked ? (
                                    <span className="w-6 h-6 rounded-full bg-[#2563EB] text-white flex items-center justify-center">
                                      <Check size={14} strokeWidth={3} />
                                    </span>
                                  ) : (
                                    <>
                                      <Folder size={24} className="text-[#F59E0B] group-hover:opacity-0 transition-opacity" fill="currentColor" />
                                      <span className="w-6 h-6 rounded-full bg-[var(--bg)] border border-[var(--bd)] text-[var(--sub)] flex items-center justify-center absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Check size={13} strokeWidth={2.5} />
                                      </span>
                                    </>
                                  )}
                                </div>
                                <div className="flex-1 min-w-0 text-sm font-bold text-[var(--tx)] truncate">{folder.name}</div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    setContextMenu({ file: folder, x: rect.left - 160, y: rect.bottom });
                                  }}
                                  className="p-1 text-[var(--sub)] hover:text-[var(--tx)] shrink-0"
                                >
                                  <MoreVertical size={18} />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {gridFiles.length > 0 && (
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--sub)] mb-2">Files</div>
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                          {gridFiles.map(file => {
                            const isChecked = selectedFileIds.has(file.id);
                            const isFocused = selectedFile?.id === file.id;
                            return (
                              <div
                                key={file.id}
                                onClick={(e) => handleSingleClick(file, e)}
                                onDoubleClick={(e) => handleDoubleClick(file, e)}
                                className={`rounded-[20px] overflow-hidden relative cursor-pointer transition-colors group ${
                                  isChecked || isFocused
                                    ? 'bg-[var(--sel)] border-2 border-[#2563EB]'
                                    : 'bg-[var(--sf)] border border-[var(--bd)] hover:border-[var(--sub)]/50'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => toggleSelection(e, file.id)}
                                  aria-label={isChecked ? 'Deselect file' : 'Select file'}
                                  className={`absolute top-2.5 left-2.5 w-6 h-6 rounded-full flex items-center justify-center z-10 transition-opacity ${
                                    isChecked
                                      ? 'bg-[#2563EB] text-white opacity-100'
                                      : 'bg-[var(--sf)]/80 border border-[var(--bd)] text-transparent opacity-0 group-hover:opacity-100'
                                  }`}
                                >
                                  <Check size={14} strokeWidth={3} />
                                </button>

                                <FileIcon
                                  file={file}
                                  type={file.type}
                                  size="card"
                                  isTg={file.isTgDrive}
                                  accountId={selectedAccountId}
                                  showThumbnails={userSettings?.showThumbnails !== false}
                                />

                                <div className="flex items-center gap-2 px-3.5 py-3">
                                  <span className="text-[var(--sub)] shrink-0">
                                    {renderFileTypeGlyph(file.type, 18, file.isTgDrive)}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[13.5px] font-bold text-[var(--tx)] truncate">{file.name}</p>
                                    <p className="text-xs font-medium text-[var(--sub)] truncate mt-0.5">
                                      {file.modified || file.size}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                      setContextMenu({ file, x: rect.left - 160, y: rect.bottom });
                                    }}
                                    className="p-1 text-[var(--sub)] hover:text-[var(--tx)] shrink-0"
                                  >
                                    <MoreVertical size={18} />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Floating Selection Action Bar */}
          <AnimatePresence>
            {selectedFileIds.size > 0 && (() => {
              const selectedFilesList = files.filter(f => selectedFileIds.has(f.id));
              const isSingleFile = selectedFilesList.length === 1 && selectedFilesList[0].type !== 'folder';
              const isSingleZip = isSingleFile && selectedFilesList[0].name.toLowerCase().endsWith('.zip');

              return (
                <motion.div
                  initial={{ y: 80, opacity: 0, x: '-50%' }}
                  animate={{ y: 0, opacity: 1, x: '-50%' }}
                  exit={{ y: 80, opacity: 0, x: '-50%' }}
                  transition={{ type: 'spring', damping: 26, stiffness: 320 }}
                  className="fixed bottom-24 md:bottom-6 left-1/2 h-14 md:h-16 rounded-[32px] bg-[#2563EB] text-white px-5 md:px-6 shadow-[0_8px_20px_rgba(37,99,235,0.4)] flex items-center gap-4 md:gap-5 z-50 max-w-[95vw] overflow-x-auto no-scrollbar"
                >
                  <div className="flex items-center gap-2.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setSelectedFileIds(new Set())}
                      className="p-1 hover:bg-white/15 rounded-full transition-colors"
                      title="Clear Selection"
                    >
                      <X size={18} />
                    </button>
                    <span className="text-[15px] font-bold whitespace-nowrap tabular-nums">
                      {selectedFileIds.size} selected
                    </span>
                  </div>

                  <span className="w-px h-7 bg-[#93C5FD]/60 shrink-0" />

                  <div className="flex items-center gap-3 md:gap-4 shrink-0 text-sm font-bold">
                    {isTrashView ? (
                      <>
                        <button onClick={handleBulkRestore} className="flex items-center gap-1.5 hover:bg-white/15 px-2.5 py-1.5 rounded-xl transition-colors whitespace-nowrap">
                          <RotateCcw size={16} />
                          <span>Restore</span>
                        </button>
                        <button onClick={handleBulkDelete} className="flex items-center gap-1.5 hover:bg-white/15 px-2.5 py-1.5 rounded-xl transition-colors whitespace-nowrap">
                          <Trash2 size={16} />
                          <span>Delete Forever</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => handleOpenMoveModal('copy')} className="flex items-center gap-1.5 hover:bg-white/15 px-2 py-1.5 rounded-xl transition-colors whitespace-nowrap" title="Copy to">
                          <Copy size={16} />
                          <span className="hidden sm:inline">Copy to</span>
                        </button>
                        <button onClick={() => handleOpenMoveModal('move')} className="flex items-center gap-1.5 hover:bg-white/15 px-2 py-1.5 rounded-xl transition-colors whitespace-nowrap" title="Move">
                          <Folder size={16} />
                          <span className="hidden sm:inline">Move</span>
                        </button>
                        {!isSingleZip && (
                          <button onClick={() => handleBulkZipToCloud()} className="hover:bg-white/15 p-2 rounded-xl transition-colors" title="Make Zip">
                            <FileArchive size={17} />
                          </button>
                        )}
                        {isSingleZip ? (
                          <button onClick={() => handleUnzip(selectedFilesList[0])} className="flex items-center gap-1.5 hover:bg-white/15 px-2 py-1.5 rounded-xl transition-colors whitespace-nowrap" title="Unzip">
                            <FileArchive size={16} />
                            <span className="hidden sm:inline">Unzip</span>
                          </button>
                        ) : (
                          <button onClick={!isSingleFile ? handleBulkZip : () => handleDownload(selectedFilesList[0].id)} className="hover:bg-white/15 p-2 rounded-xl transition-colors" title={!isSingleFile ? 'Download as Zip' : 'Download'}>
                            {!isSingleFile ? <Archive size={17} /> : <Download size={17} />}
                          </button>
                        )}
                        <button onClick={handleBulkDelete} className="hover:bg-white/15 p-2 rounded-xl transition-colors" title="Move to Trash">
                          <Trash2 size={17} />
                        </button>
                      </>
                    )}
                  </div>
                </motion.div>
              );
            })()}
          </AnimatePresence>
        </div>

        {/* Mobile Floating Upload Button + Contextual Destination Menu */}
        {!isTrashView && !isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen && accounts.length > 0 && (
          <div className="md:hidden fixed right-4 bottom-24 z-40">
            {uploadMenuAnchor === 'mobile' && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setUploadMenuAnchor(null)} />
                <div className="absolute right-0 bottom-16 w-60 rounded-[22px] bg-[var(--sf)] border border-[var(--bd)] shadow-2xl z-40 p-2 space-y-1">
                  <div className="px-3 py-2 border-b border-[var(--bd)]">
                    <p className="text-[10px] font-black uppercase tracking-wider text-[var(--sub)]">Upload to</p>
                    <p className="text-xs font-extrabold text-[var(--tx)] truncate mt-0.5">
                      {(selectedAccount?.name || (isTgDrive ? 'TG Drive' : selectedAccount?.email || 'Drive'))}
                      {path.length > 1 ? ` › ${path.slice(1).map(p => p.name).join(' › ')}` : ' › Files'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setUploadMenuAnchor(null);
                      fileUploadInputRef.current?.click();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)]"
                  >
                    <UploadCloud size={16} className="text-[#2563EB]" />
                    <span>Upload files</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setUploadMenuAnchor(null);
                      folderUploadInputRef.current?.click();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)]"
                  >
                    <FolderOpen size={16} className="text-[#F59E0B]" />
                    <span>Upload folder</span>
                  </button>
                  <div className="my-1 border-t border-[var(--bd)]" />
                  <button
                    type="button"
                    onClick={() => {
                      setUploadMenuAnchor(null);
                      handleCreateFolder();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)]"
                  >
                    <FolderPlus size={16} className="text-[var(--sub)]" />
                    <span>New folder</span>
                  </button>
                </div>
              </>
            )}
            <button
              type="button"
              onClick={() => setUploadMenuAnchor(prev => (prev === 'mobile' ? null : 'mobile'))}
              className="relative z-40 h-14 px-5 rounded-2xl bg-[#2563EB] text-white font-bold text-[15px] flex items-center gap-2.5 shadow-[0_8px_20px_rgba(37,99,235,0.4)] active:scale-95 transition-transform"
            >
              <Upload size={20} />
              <span>Upload</span>
            </button>
          </div>
        )}

        {/* Mobile Bottom Navigation Bar */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 h-20 bg-[var(--rail)] border-t border-[var(--bd)] flex items-center px-2 z-40">
          {[
            { id: 'files', label: 'Files', icon: <Folder size={20} fill={activeNavTab === 'files' ? 'currentColor' : 'none'} />, onClick: () => { setIsSettingsOpen(false); setIsJobsDrawerOpen(false); setIsAdminPanelOpen(false); if (isTrashView) toggleTrashView(false); else syncUrl({ page: 'drive' }); } },
            { id: 'trash', label: 'Trash', icon: <Trash2 size={20} />, onClick: () => { toggleTrashView(); } },
            { id: 'transfers', label: 'Transfers', icon: <ArrowLeftRight size={20} />, onClick: () => { setIsSettingsOpen(false); setIsAdminPanelOpen(false); setIsJobsDrawerOpen(true); syncUrl({ page: 'jobs' }); } },
            { id: 'drives', label: 'Drives', icon: <Cloud size={20} fill={activeNavTab === 'drives' ? 'currentColor' : 'none'} />, onClick: () => setIsDrivesExpanded(true) },
          ].map(item => {
            const isOn = activeNavTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={item.onClick}
                className={`flex-1 flex flex-col items-center gap-1 text-xs transition-colors ${
                  isOn ? 'text-[var(--tx)] font-extrabold' : 'text-[var(--sub)] font-semibold'
                }`}
              >
                <span className={`w-14 h-8 rounded-2xl flex items-center justify-center transition-colors ${isOn ? 'bg-[var(--pi)] text-[var(--pit)]' : ''}`}>
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* File Details Panel */}
        <AnimatePresence>
          {selectedFile && (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => openFileInspector(null)} className="fixed inset-0 bg-slate-950/35 z-50 lg:bg-transparent" />
              <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 400 }} className="fixed top-0 right-0 h-full w-full max-w-sm bg-[var(--sf)] text-[var(--tx)] shadow-2xl z-[60] border-l border-[var(--bd)] flex flex-col">
                <div className="p-6 flex items-center justify-between border-b border-[var(--bd)]">
                  <h3 className="font-black text-[var(--sub)] uppercase tracking-widest text-xs">File Details</h3>
                  <button onClick={() => openFileInspector(null)} className="p-2 hover:bg-[var(--bg)] rounded-lg text-[var(--sub)] hover:text-[var(--tx)]"><X size={18} /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-8 space-y-8">
                  <div className="flex flex-col items-center text-center space-y-4">
                    <FileIcon file={selectedFile} type={selectedFile.type} size="lg" isTg={selectedFile.isTgDrive} accountId={selectedAccountId} showThumbnails={userSettings?.showThumbnails !== false} />
                    <div className="space-y-1">
                      <h4 className="font-bold text-[var(--tx)] break-all pr-4">{selectedFile.name}</h4>
                      <p className="text-[10px] font-black text-[var(--sub)] uppercase tracking-widest tabular-nums">{selectedFile.size}</p>
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
                    {isTrashView ? (
                      <>
                        <button onClick={() => handleRestoreFile(selectedFile.id)} className="flex flex-col items-center gap-2 p-4 bg-[var(--bg)] rounded-2xl hover:bg-emerald-500/15 text-[var(--sub)] hover:text-emerald-500 transition-all border border-[var(--bd)]">
                          <RotateCcw size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Restore</span>
                        </button>
                        <button onClick={() => handlePermanentDeleteFile(selectedFile.id)} className="flex flex-col items-center gap-2 p-4 bg-[var(--bg)] rounded-2xl hover:bg-rose-500/15 text-[var(--sub)] hover:text-rose-500 transition-all border border-[var(--bd)]">
                          <Trash2 size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Delete Forever</span>
                        </button>
                      </>
                    ) : (
                      <>
                        {selectedFile.type !== 'folder' && (
                          <button onClick={() => handleDownload(selectedFile.id)} className="flex flex-col items-center gap-2 p-4 bg-[var(--bg)] rounded-2xl hover:bg-[var(--sel)] text-[var(--sub)] hover:text-[#2563EB] transition-all border border-[var(--bd)]">
                            <Download size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Download</span>
                          </button>
                        )}
                        <button onClick={() => handleRename(selectedFile.id, selectedFile.name)} className="flex flex-col items-center gap-2 p-4 bg-[var(--bg)] rounded-2xl hover:bg-[var(--sel)] text-[var(--sub)] hover:text-[#2563EB] transition-all border border-[var(--bd)]">
                          <Edit3 size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Rename</span>
                        </button>
                        {selectedFile.type !== 'folder' && (
                          <button onClick={() => handleShare(selectedFile.id)} className="flex flex-col items-center gap-2 p-4 bg-[var(--bg)] rounded-2xl hover:bg-[var(--sel)] text-[var(--sub)] hover:text-[#2563EB] transition-all border border-[var(--bd)]">
                            <Share2 size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Share</span>
                          </button>
                        )}
                        {['image', 'video', 'audio', 'pdf'].includes(selectedFile.type) && (
                          <button onClick={() => openPreview(selectedFile)} className="flex flex-col items-center gap-2 p-4 bg-[var(--bg)] rounded-2xl hover:bg-purple-500/15 text-[var(--sub)] hover:text-purple-500 transition-all border border-[var(--bd)]">
                            <Eye size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Preview</span>
                          </button>
                        )}
                        {selectedFile.name.toLowerCase().endsWith('.zip') && (
                          <button onClick={() => handleUnzip(selectedFile)} className="flex flex-col items-center gap-2 p-4 bg-[var(--bg)] rounded-2xl hover:bg-[var(--sel)] text-[var(--sub)] hover:text-[#2563EB] transition-all border border-[var(--bd)]">
                            <FileArchive size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Unzip</span>
                          </button>
                        )}
                        <button onClick={() => handleDeleteFile(selectedFile.id)} className="flex flex-col items-center gap-2 p-4 bg-[var(--bg)] rounded-2xl hover:bg-rose-500/15 text-[var(--sub)] hover:text-rose-500 transition-all border border-[var(--bd)]">
                          <Trash2 size={20} /><span className="text-[10px] font-black uppercase tracking-widest">Trash</span>
                        </button>
                      </>
                    )}
                  </div>
                  {/* Open in Google Drive / OneDrive link */}
                  {selectedFile.webViewLink && !selectedFile.isTgDrive && (
                    <div className="pt-2">
                      <a href={selectedFile.webViewLink} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 w-full py-4 bg-[var(--sel)] text-[#2563EB] dark:text-[#60A5FA] font-bold rounded-2xl hover:opacity-90 transition-all">
                        <ExternalLink size={18} /><span>Open in {selectedAccount?.accountType === 'onedrive' ? 'OneDrive' : 'Google Drive'}</span>
                      </a>
                    </div>
                  )}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Multi-File Upload Queue Card (Flow D) */}
        <AnimatePresence>
          {(uploadQueue.length > 0 || uploadProgress) && (() => {
            const totalCount = uploadQueue.length || 1;
            const completedCount = uploadQueue.filter(q => q.status === 'completed').length;
            const failedItems = uploadQueue.filter(q => q.status === 'failed');
            const activeItem = uploadQueue.find(q => q.status === 'uploading' || q.status === 'preparing' || q.status === 'completing' || q.status === 'paused');
            const isWorking = Boolean(uploadProgress) || Boolean(activeItem);
            const isPaused = uploadProgress?.status === 'paused' || activeItem?.status === 'paused';
            const activePct = Math.min(100, Math.max(0, Number(uploadProgress?.percent ?? activeItem?.percent ?? 0)));
            const waveWidth = 220;
            const activeEnd = activePct <= 0 ? 0 : Math.min(waveWidth - 2, Math.max(8, (activePct / 100) * (waveWidth - 4) + 2));
            const trackStart = activePct <= 0 ? 2 : Math.min(waveWidth - 4, activeEnd + 5);
            const waveColor = isPaused ? '#F59E0B' : (isTgDrive ? '#0EA5E9' : '#2563EB');

            const headerTitle = failedItems.length > 0 && !isWorking
              ? `${failedItems.length} upload${failedItems.length === 1 ? '' : 's'} failed`
              : isPaused
              ? `Paused · ${uploadProgress?.name || activeItem?.name || ''}`
              : isWorking
              ? `Uploading ${Math.min(totalCount, completedCount + 1)} of ${totalCount}`
              : `Uploaded ${completedCount} of ${totalCount}`;

            return (
              <motion.div
                initial={{ y: 24, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 24, opacity: 0 }}
                className="fixed bottom-24 md:bottom-8 right-4 md:right-8 z-[115] w-[calc(100vw-32px)] max-w-[380px] rounded-[24px] bg-[var(--sf)] border border-[var(--bd)] shadow-2xl overflow-hidden text-[var(--tx)]"
              >
                <div className="px-4 py-3 flex items-center justify-between gap-2 border-b border-[var(--bd)]">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                      failedItems.length > 0 && !isWorking
                        ? 'bg-rose-500/15 text-rose-500'
                        : isPaused
                        ? 'bg-amber-500/15 text-amber-500'
                        : 'bg-[var(--pi)] text-[var(--pit)]'
                    }`}>
                      {isTgDrive ? <TelegramIcon size={16} /> : isWorking ? <UploadCloud size={16} /> : failedItems.length > 0 ? <AlertTriangle size={16} /> : <Check size={16} />}
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-extrabold text-[var(--tx)] truncate">{headerTitle}</p>
                      {(uploadProgress || activeItem) && (
                        <p className="text-[11px] font-medium text-[var(--sub)] truncate tabular-nums">
                          {uploadProgress?.name || activeItem?.name} · {activePct}%
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {isWorking && (
                      <>
                        {isPaused ? (
                          <button
                            type="button"
                            onClick={resumeCurrentUpload}
                            className="w-7 h-7 rounded-lg bg-[#2563EB] text-white flex items-center justify-center hover:bg-blue-700 transition-colors"
                            title="Resume upload"
                          >
                            <Play size={13} fill="currentColor" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={pauseCurrentUpload}
                            disabled={uploadProgress?.status === 'completing'}
                            className="w-7 h-7 rounded-lg bg-[var(--bg)] text-[var(--tx)] flex items-center justify-center hover:opacity-80 disabled:opacity-50"
                            title="Pause upload"
                          >
                            <Pause size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={cancelCurrentUpload}
                          disabled={uploadProgress?.status === 'completing'}
                          className="w-7 h-7 rounded-lg text-[var(--sub)] hover:text-rose-500 hover:bg-rose-500/10 flex items-center justify-center disabled:opacity-50"
                          title="Cancel upload"
                        >
                          <X size={14} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsUploadQueueMinimized(prev => !prev)}
                      className="w-7 h-7 rounded-lg text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)] flex items-center justify-center"
                      title={isUploadQueueMinimized ? 'Expand queue' : 'Minimize queue'}
                    >
                      {isUploadQueueMinimized ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </button>
                    {!isWorking && (
                      <button
                        type="button"
                        onClick={() => setUploadQueue([])}
                        className="w-7 h-7 rounded-lg text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)] flex items-center justify-center"
                        title="Dismiss"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Active Expressive Wavy Progress Line */}
                {(uploadProgress || activeItem) && (
                  <div className="px-4 py-2 bg-[var(--bg)]/45 border-b border-[var(--bd)]">
                    <svg viewBox="0 0 220 10" className="w-full h-[10px] block overflow-visible" aria-hidden="true">
                      <defs>
                        <clipPath id="active-upload-wave">
                          <rect x="0" y="0" width={activeEnd} height="10" />
                        </clipPath>
                      </defs>
                      {trackStart < 216 && (
                        <line x1={trackStart} y1="5" x2="216" y2="5" stroke="var(--tr)" strokeWidth="3" strokeLinecap="round" />
                      )}
                      {activePct > 0 && (
                        <path
                          d="M2 5 Q5 1.8 8 5 T14 5 T20 5 T26 5 T32 5 T38 5 T44 5 T50 5 T56 5 T62 5 T68 5 T74 5 T80 5 T86 5 T92 5 T98 5 T104 5 T110 5 T116 5 T122 5 T128 5 T134 5 T140 5 T146 5 T152 5 T158 5 T164 5 T170 5 T176 5 T182 5 T188 5 T194 5 T200 5 T206 5 T212 5 T216 5"
                          fill="none"
                          stroke={waveColor}
                          strokeWidth="3"
                          strokeLinecap="round"
                          clipPath="url(#active-upload-wave)"
                        />
                      )}
                    </svg>
                  </div>
                )}

                {/* Queue List */}
                {!isUploadQueueMinimized && (
                  <div className="max-h-56 overflow-y-auto p-2.5 space-y-1.5 no-scrollbar">
                    {uploadQueue.map((item) => (
                      <div key={item.id} className="px-2.5 py-2 rounded-xl bg-[var(--bg)]/50 border border-[var(--bd)]/70 flex items-center gap-2.5">
                        <span className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 text-[11px] font-extrabold ${
                          item.status === 'completed'
                            ? 'bg-emerald-500/15 text-emerald-500'
                            : item.status === 'failed'
                            ? 'bg-rose-500/15 text-rose-500'
                            : item.status === 'paused'
                            ? 'bg-amber-500/15 text-amber-500'
                            : 'bg-[var(--pi)] text-[var(--pit)]'
                        }`}>
                          {item.status === 'completed' ? <Check size={13} strokeWidth={2.75} /> : item.status === 'failed' ? <AlertTriangle size={13} /> : <Upload size={12} />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-[var(--tx)] truncate">{item.name}</p>
                          <p className={`text-[10.5px] truncate mt-0.5 tabular-nums ${item.status === 'failed' ? 'text-rose-500 font-semibold' : 'text-[var(--sub)]'}`}>
                            {item.status === 'failed'
                              ? item.error || 'Upload interrupted'
                              : `${formatUploadBytes(item.size)} · ${item.status}`}
                          </p>
                        </div>
                        <span className="text-[11px] font-mono font-bold text-[var(--sub)] tabular-nums shrink-0">
                          {item.percent}%
                        </span>
                      </div>
                    ))}
                    {failedItems.length > 0 && !isWorking && (
                      <button
                        type="button"
                        onClick={retryFailedUploads}
                        className="w-full h-9 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-colors mt-1"
                      >
                        <RefreshCw size={13} />
                        <span>Retry {failedItems.length} failed {failedItems.length === 1 ? 'file' : 'files'}</span>
                      </button>
                    )}
                  </div>
                )}
              </motion.div>
            );
          })()}
        </AnimatePresence>



        {/* Snackbar / Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ y: 40, opacity: 0, x: '-50%' }}
              animate={{ y: 0, opacity: 1, x: '-50%' }}
              exit={{ y: 40, opacity: 0, x: '-50%' }}
              className={`fixed bottom-24 md:bottom-8 left-1/2 z-[260] min-w-[260px] max-w-[92vw] pl-4 pr-3 py-2.5 rounded-[16px] shadow-2xl flex items-center gap-3 border ${
                toast.type === 'error'
                  ? 'bg-rose-600 text-white border-rose-500/40'
                  : 'bg-[var(--tx)] text-[var(--bg)] border-[var(--bd)]'
              }`}
            >
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                  toast.type === 'error' ? 'bg-white/20 text-white' : 'bg-[#2563EB] text-white'
                }`}
              >
                {toast.type === 'error' ? <X size={14} /> : <Check size={14} strokeWidth={2.75} />}
              </span>
              <span className="font-semibold text-[13.5px] tracking-tight flex-1">{toast.message}</span>
              {toast.actionLabel && toast.onAction && (
                <button
                  type="button"
                  onClick={() => {
                    const cb = toast.onAction;
                    setToast(null);
                    cb?.();
                  }}
                  className={`px-2.5 py-1 rounded-lg text-xs font-extrabold uppercase tracking-wider shrink-0 transition-colors ${
                    toast.type === 'error'
                      ? 'bg-white/20 text-white hover:bg-white/30'
                      : 'text-[#60A5FA] hover:bg-white/10'
                  }`}
                >
                  {toast.actionLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => setToast(null)}
                className="p-1 rounded-lg opacity-70 hover:opacity-100 shrink-0"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Link Provider Modal */}
        <AnimatePresence>
          {linkProviderModal && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { setLinkProviderModal(false); syncUrl({ modal: null }); }} className="absolute inset-0 bg-slate-950/65 backdrop-blur-sm" />
              <motion.div initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 10 }} transition={{ duration: 0.15 }} className="bg-[var(--sf)] text-[var(--tx)] p-7 rounded-[28px] shadow-2xl relative w-full max-w-sm space-y-5 border border-[var(--bd)]">
                <div>
                  <h2 className="text-xl font-extrabold text-[var(--tx)] tracking-tight">Add Account</h2>
                  <p className="text-[var(--sub)] text-sm font-medium mt-1">Choose a cloud provider to connect</p>
                </div>
                <div className="grid gap-2.5">
                  <button onClick={() => handleConnect('google')} className="w-full flex items-center gap-3.5 p-3.5 rounded-[20px] border border-[var(--bd)] hover:border-[#2563EB] bg-[var(--bg)]/60 hover:bg-[var(--sel)] transition-all text-left">
                    {renderProviderBadge('google', 'md')}
                    <div><div className="font-extrabold text-sm text-[var(--tx)]">Google Drive</div><div className="text-[11px] font-semibold text-[var(--sub)]">Personal &amp; Workspace</div></div>
                  </button>
                  <button onClick={() => handleConnect('onedrive')} className="w-full flex items-center gap-3.5 p-3.5 rounded-[20px] border border-[var(--bd)] hover:border-[#2563EB] bg-[var(--bg)]/60 hover:bg-[var(--sel)] transition-all text-left">
                    {renderProviderBadge('onedrive', 'md')}
                    <div><div className="font-extrabold text-sm text-[var(--tx)]">Microsoft OneDrive</div><div className="text-[11px] font-semibold text-[var(--sub)]">Outlook &amp; Microsoft 365</div></div>
                  </button>
                  <button onClick={() => { setLinkProviderModal(false); setTgDriveModal(true); setTgRegisterError(''); setTgChannelInput(''); syncUrl({ modal: 'tg-drive' }); }} className="w-full flex items-center gap-3.5 p-3.5 rounded-[20px] border border-[var(--bd)] hover:border-sky-500 bg-[var(--bg)]/60 hover:bg-sky-500/10 transition-all text-left">
                    {renderProviderBadge('tgdrive', 'md')}
                    <div><div className="font-extrabold text-sm text-[var(--tx)]">Telegram Channel</div><div className="text-[11px] font-semibold text-[var(--sub)]">Unlimited TG Storage</div></div>
                  </button>
                </div>
                <button onClick={() => { setLinkProviderModal(false); syncUrl({ modal: null }); }} className="w-full py-3 rounded-[18px] text-sm font-bold text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)] transition-colors">Cancel</button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* TG Drive Register Modal */}
        <AnimatePresence>
          {tgDriveModal && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { setTgDriveModal(false); syncUrl({ modal: null }); }} className="absolute inset-0 bg-slate-950/65 backdrop-blur-sm" />
              <motion.div initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 10 }} transition={{ duration: 0.15 }} className="bg-[var(--sf)] text-[var(--tx)] p-7 rounded-[28px] shadow-2xl relative w-full max-w-sm space-y-5 border border-[var(--bd)]">
                <div className="flex items-center gap-3.5">
                  {renderProviderBadge('tgdrive', 'md')}
                  <div>
                    <h2 className="text-xl font-extrabold text-[var(--tx)] tracking-tight">Register TG Drive</h2>
                    <p className="text-xs text-[var(--sub)] font-medium mt-0.5">Connect a Telegram channel as storage</p>
                  </div>
                </div>
                <div className="bg-sky-500/12 border border-sky-500/30 rounded-[18px] p-3.5 text-xs text-sky-700 dark:text-sky-300 font-medium space-y-1">
                  <p className="font-extrabold">Before registering:</p>
                  <p>1. Create a Telegram channel</p>
                  <p>2. Add your bot as an <strong>Administrator</strong></p>
                  <p>3. Copy the channel ID (e.g. <code className="bg-sky-500/15 px-1 rounded font-mono">-1001234567890</code>)</p>
                </div>
                <div className="space-y-3.5">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase text-[var(--sub)] px-1 tracking-widest">Drive Name</label>
                    <input
                      autoFocus
                      value={tgDriveNameInput}
                      onChange={e => setTgDriveNameInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRegisterTgDrive(); }}
                      placeholder="e.g. My Storage, Videos Channel"
                      className="w-full px-4 py-3.5 bg-[var(--bg)] border border-[var(--bd)] focus:border-sky-500 rounded-2xl outline-none transition-all font-bold text-sm text-[var(--tx)]"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase text-[var(--sub)] px-1 tracking-widest">Channel ID or Username</label>
                    <input
                      value={tgChannelInput}
                      onChange={e => setTgChannelInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRegisterTgDrive(); }}
                      placeholder="-1001234567890 or @mychannel"
                      className="w-full px-4 py-3.5 bg-[var(--bg)] border border-[var(--bd)] focus:border-sky-500 rounded-2xl outline-none transition-all font-bold text-sm text-[var(--tx)]"
                    />
                  </div>
                </div>
                {tgRegisterError && <motion.p initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="text-rose-500 text-xs font-bold px-1">{tgRegisterError}</motion.p>}
                <div className="flex gap-2.5 pt-1">
                  <button onClick={() => { setTgDriveModal(false); setTgChannelInput(''); setTgDriveNameInput(''); setTgRegisterError(''); syncUrl({ modal: null }); }} className="flex-1 py-3.5 text-[var(--sub)] hover:text-[var(--tx)] font-bold hover:bg-[var(--bg)] rounded-[18px] transition-colors text-sm">Cancel</button>
                  <button onClick={handleRegisterTgDrive} disabled={tgRegisterLoading || !tgChannelInput.trim()} className="flex-1 bg-sky-500 text-white font-bold py-3.5 rounded-[18px] hover:bg-sky-600 shadow-lg shadow-sky-500/20 transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm">
                    {tgRegisterLoading ? <><RefreshCw size={16} className="animate-spin" /><span>Connecting...</span></> : <><Send size={16} /><span>Connect</span></>}
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
                <motion.div initial={{ opacity: 0, scale: 0.95, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: -4 }} style={{ top, left }} className="fixed z-[100] bg-[var(--sf)] text-[var(--tx)] border border-[var(--bd)] rounded-[20px] shadow-2xl overflow-y-auto max-h-[80vh] w-48 no-scrollbar">
                  <div className="px-3.5 py-2.5 border-b border-[var(--bd)]"><p className="text-xs font-extrabold text-[var(--sub)] truncate">{contextMenu.file.name}</p></div>
                  <div className="p-1.5 space-y-0.5">
                    {isTrashView ? (
                      <>
                        <button onClick={() => { handleRestoreFile(contextMenu.file.id); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-emerald-500 hover:bg-emerald-500/10 transition-colors"><RotateCcw size={15} /> Restore</button>
                        <button onClick={() => { openFileInspector(contextMenu.file); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><Info size={15} /> Details</button>
                        <button onClick={() => { handlePermanentDeleteFile(contextMenu.file.id); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-rose-500 hover:bg-rose-500/10 transition-colors"><Trash2 size={15} /> Delete Forever</button>
                      </>
                    ) : (
                      <>
                        {contextMenu.file.type !== 'folder' && <button onClick={() => { openPreview(contextMenu.file); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--sel)] hover:text-[#2563EB] transition-colors"><Eye size={15} /> Preview</button>}
                        {contextMenu.file.type !== 'folder' && <button onClick={() => { openFileInspector(contextMenu.file); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><Info size={15} /> Details</button>}
                        <button onClick={() => { handleRename(contextMenu.file.id, contextMenu.file.name); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><Edit3 size={15} /> Rename</button>
                        {contextMenu.file.type !== 'folder' && <button onClick={() => { handleDownload(contextMenu.file.id); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><Download size={15} /> Download</button>}
                        {contextMenu.file.type !== 'folder' && <button onClick={() => { handleShare(contextMenu.file); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><Share2 size={15} /> Share</button>}
                        <button onClick={() => { setSelectedFileIds(new Set([contextMenu.file.id])); setContextMenu(null); handleOpenMoveModal('move'); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><Folder size={15} /> Move</button>
                        <button onClick={() => { setSelectedFileIds(new Set([contextMenu.file.id])); setContextMenu(null); handleOpenMoveModal('copy'); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><Copy size={15} /> Copy</button>
                        
                        {isZip ? (
                          <button onClick={() => { handleUnzip(contextMenu.file); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><FileArchive size={15} /> Unzip</button>
                        ) : (
                          <>
                            <button onClick={() => { setContextMenu(null); handleBulkZipToCloud(new Set([contextMenu.file.id])); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><FileArchive size={15} /> Make Zip</button>
                            {contextMenu.file.type === 'folder' && (
                              <button onClick={() => { setContextMenu(null); handleBulkZip(new Set([contextMenu.file.id])); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"><Archive size={15} /> Download as Zip</button>
                            )}
                          </>
                        )}

                        <div className="my-1 border-t border-[var(--bd)]" />
                        <button onClick={() => { handleDeleteFile(contextMenu.file.id); setContextMenu(null); }} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-rose-500 hover:bg-rose-500/10 transition-colors"><Trash2 size={15} /> Move to Trash</button>
                      </>
                    )}
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
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { setPreviewFile(null); syncUrl({ previewFileId: null }); }} className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" />
              <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className="relative z-10 bg-[var(--sf)] text-[var(--tx)] border border-[var(--bd)] rounded-[28px] shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--bd)] shrink-0">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <FileIcon file={previewFile} type={previewFile.type} isTg={previewFile.isTgDrive} accountId={selectedAccountId} />
                    <div className="overflow-hidden">
                      <p className="font-extrabold text-[var(--tx)] text-sm truncate">{previewFile.name}</p>
                      <p className="text-[10px] font-bold text-[var(--sub)] uppercase tracking-widest tabular-nums">{previewFile.size}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {['image', 'video', 'audio'].includes(previewFile.type) && <button onClick={() => openFullScreenGallery(previewFile)} className="p-2.5 rounded-xl bg-[var(--bg)] text-[var(--sub)] hover:text-[#2563EB] transition-colors" title="Full Screen Gallery"><Maximize size={18} /></button>}
                    {previewFile.type !== 'folder' && <button onClick={() => handleDownload(previewFile.id)} className="p-2.5 rounded-xl bg-[var(--bg)] text-[var(--sub)] hover:text-[#2563EB] transition-colors" title="Download"><Download size={18} /></button>}
                    {previewFile.type !== 'folder' && <button onClick={() => handleShare(previewFile.id)} className="p-2.5 rounded-xl bg-[var(--bg)] text-[var(--sub)] hover:text-[#2563EB] transition-colors" title="Share"><Share2 size={18} /></button>}
                    <button onClick={() => { setPreviewFile(null); syncUrl({ previewFileId: null }); }} className="p-2.5 rounded-xl bg-[var(--bg)] text-[var(--sub)] hover:text-[var(--tx)] transition-colors"><X size={18} /></button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto flex items-center justify-center p-6 bg-[var(--bg)] min-h-[300px]">
                  {previewFile.type === 'image' ? (
                    <img src={previewFile.url || `/api/download/${selectedAccountId}/${previewFile.id}?preview=1`} alt={previewFile.name} className="max-w-full max-h-[60vh] rounded-xl shadow-lg object-contain cursor-pointer transition-transform hover:scale-[1.02]" onClick={() => openFullScreenGallery(previewFile)} />
                  ) : previewFile.type === 'video' ? (
                    <div className="relative group cursor-pointer max-w-full max-h-[60vh]">
                      <video controls autoPlay className="max-w-full max-h-[60vh] rounded-xl shadow-lg" src={previewFile.url || `/api/download/${selectedAccountId}/${previewFile.id}?preview=1`} />
                    </div>
                  ) : previewFile.type === 'audio' ? (
                    <audio controls autoPlay className="w-full max-w-md" src={previewFile.url || `/api/download/${selectedAccountId}/${previewFile.id}?preview=1`} />
                  ) : previewFile.type === 'pdf' && (previewFile.url || (previewFile.webViewLink && !previewFile.isTgDrive)) ? (
                    <iframe src={previewFile.url || previewFile.webViewLink} className="w-full h-[60vh] rounded-xl border border-[var(--bd)]" title={previewFile.name} />
                  ) : (
                    <div className="text-center space-y-6">
                      <div className="w-20 h-20 mx-auto"><FileIcon file={previewFile} type={previewFile.type} size="lg" isTg={previewFile.isTgDrive} accountId={selectedAccountId} /></div>
                      <div className="space-y-2">
                        <p className="font-bold text-[var(--tx)]">Preview not available in browser</p>
                        <p className="text-sm text-[var(--sub)]">Download the file to view it.</p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-3 justify-center">
                        {previewFile.webViewLink && !previewFile.isTgDrive && (
                          <a href={previewFile.webViewLink} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 px-6 py-3 bg-[var(--sel)] text-[#2563EB] font-bold rounded-2xl hover:opacity-90 transition-all">
                            <ExternalLink size={16} /> Open in Drive
                          </a>
                        )}
                        <button onClick={() => handleDownload(previewFile.id)} className="flex items-center justify-center gap-2 px-6 py-3 bg-[var(--sf)] border border-[var(--bd)] text-[var(--tx)] font-bold rounded-2xl hover:border-[var(--sub)]/50 transition-all">
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

        {/* Move/Copy Destination Picker Modal (Flow C) */}
        <AnimatePresence>
          {isMoveModalOpen && (
            <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => { setIsMoveModalOpen(false); syncUrl({ modal: null }); }}
                className="absolute inset-0 bg-slate-950/65 backdrop-blur-sm"
              />
              <motion.div
                initial={{ scale: 0.96, opacity: 0, y: 16 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.96, opacity: 0, y: 16 }}
                className="relative z-10 bg-[var(--sf)] text-[var(--tx)] rounded-[28px] shadow-2xl w-full max-w-lg overflow-hidden border border-[var(--bd)] flex flex-col h-[74vh] max-h-[640px]"
              >
                {/* Modal Header */}
                <div className="px-6 pt-5 pb-4 border-b border-[var(--bd)] flex items-center justify-between gap-3 shrink-0">
                  <div className="min-w-0">
                    <h3 className="font-extrabold text-[var(--tx)] text-lg capitalize tracking-tight">
                      {modalAction} {selectedFileIds.size} {selectedFileIds.size === 1 ? 'item' : 'items'}
                    </h3>
                    <p className="text-xs text-[var(--sub)] font-medium mt-0.5 truncate">
                      Pick a drive and destination folder
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setIsMoveModalOpen(false); syncUrl({ modal: null }); }}
                    className="w-9 h-9 rounded-full bg-[var(--bg)] border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)] flex items-center justify-center transition-colors shrink-0"
                    aria-label="Close"
                  >
                    <X size={17} />
                  </button>
                </div>

                {/* Drive Provider Pill Switcher */}
                <div className="px-5 py-3 border-b border-[var(--bd)] flex items-center gap-2 overflow-x-auto no-scrollbar shrink-0 bg-[var(--bg)]/45">
                  {accounts.map((acc) => {
                    const isTarget = moveTargetAccountId === acc.id;
                    const accLabel = acc.name || (acc.accountType === 'tgdrive' ? 'TG Drive' : acc.email);
                    return (
                      <button
                        key={acc.id}
                        type="button"
                        onClick={() => navigateMoveAccount(acc.id)}
                        className={`h-9 pl-1.5 pr-3 rounded-[14px] border flex items-center gap-2 text-xs font-bold whitespace-nowrap shrink-0 transition-all ${
                          isTarget
                            ? 'bg-[var(--sel)] border-[#2563EB] text-[var(--tx)]'
                            : 'bg-[var(--sf)] border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)]'
                        }`}
                      >
                        {renderProviderBadge(acc.accountType, 'sm')}
                        <span className="max-w-[140px] truncate">{accLabel}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Destination Breadcrumb & Inline New Folder Trigger */}
                <div className="px-5 py-2.5 border-b border-[var(--bd)] flex items-center justify-between gap-2 shrink-0">
                  <div className="flex items-center gap-1 overflow-x-auto no-scrollbar text-xs font-bold min-w-0">
                    {movePath.map((crumb, idx) => {
                      const isLast = idx === movePath.length - 1;
                      return (
                        <React.Fragment key={crumb.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setMovePath(prev => prev.slice(0, idx + 1));
                              setMoveTargetFolderId(crumb.id);
                              if (moveTargetAccountId) fetchMoveFolders(moveTargetAccountId, crumb.id);
                            }}
                            className={`px-2 py-1 rounded-lg truncate max-w-[130px] transition-colors ${
                              isLast ? 'bg-[var(--pi)] text-[var(--pit)]' : 'text-[var(--sub)] hover:text-[var(--tx)]'
                            }`}
                          >
                            {crumb.name}
                          </button>
                          {idx < movePath.length - 1 && <ChevronRight size={13} className="text-[var(--sub)] shrink-0" />}
                        </React.Fragment>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setMoveInlineFolderMode(prev => !prev);
                      setMoveInlineFolderName('');
                    }}
                    className="h-8 px-2.5 rounded-xl bg-[var(--tonal)] text-[var(--tonalt)] text-xs font-bold flex items-center gap-1.5 hover:opacity-90 transition-opacity shrink-0"
                  >
                    <FolderPlus size={14} />
                    <span>New folder</span>
                  </button>
                </div>

                {/* Inline New Folder Row */}
                {moveInlineFolderMode && (
                  <div className="px-5 py-2.5 border-b border-[var(--bd)] bg-[var(--bg)]/60 flex items-center gap-2 shrink-0">
                    <input
                      autoFocus
                      type="text"
                      value={moveInlineFolderName}
                      onChange={e => setMoveInlineFolderName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleCreateMoveFolderInline(); }}
                      placeholder="Folder name..."
                      className="flex-1 h-9 px-3 rounded-xl bg-[var(--sf)] border border-[var(--bd)] focus:border-[#2563EB] text-xs font-bold text-[var(--tx)] outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleCreateMoveFolderInline}
                      disabled={moveCreatingFolder || !moveInlineFolderName.trim()}
                      className="h-9 px-3.5 rounded-xl bg-[#2563EB] text-white text-xs font-bold disabled:opacity-50"
                    >
                      {moveCreatingFolder ? 'Creating...' : 'Create'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setMoveInlineFolderMode(false)}
                      className="h-9 px-2.5 rounded-xl text-xs font-semibold text-[var(--sub)] hover:text-[var(--tx)]"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Folder List */}
                <div className="flex-1 overflow-y-auto p-4 bg-[var(--bg)]/35">
                  {moveLoading ? (
                    <div className="flex items-center justify-center h-full">
                      <RefreshCw className="animate-spin text-[#2563EB]" size={24} />
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {moveTargetFolderId !== 'root' && (
                        <button
                          type="button"
                          onClick={() => {
                            if (movePath.length > 1) {
                              const parent = movePath[movePath.length - 2];
                              setMovePath(prev => prev.slice(0, prev.length - 1));
                              setMoveTargetFolderId(parent.id);
                              if (moveTargetAccountId) fetchMoveFolders(moveTargetAccountId, parent.id);
                            } else {
                              navigateMoveFolder('root');
                            }
                          }}
                          className="w-full flex items-center gap-3 p-3 rounded-[16px] bg-[var(--sf)] border border-[var(--bd)] hover:border-[var(--sub)]/40 text-left text-xs font-bold text-[var(--sub)] hover:text-[var(--tx)] transition-colors"
                        >
                          <ArrowLeft size={16} />
                          <span>Up one folder</span>
                        </button>
                      )}
                      {moveFoldersList.length === 0 ? (
                        <div className="text-center py-12 px-4 space-y-1.5">
                          <Folder size={28} className="mx-auto text-[var(--sub)] opacity-50" />
                          <p className="text-sm font-bold text-[var(--tx)]">No subfolders here</p>
                          <p className="text-xs text-[var(--sub)]">
                            You can {modalAction} directly into <span className="font-semibold">{movePath[movePath.length - 1]?.name}</span> or create a new folder.
                          </p>
                        </div>
                      ) : (
                        moveFoldersList.map(f => (
                          <button
                            key={f.id}
                            type="button"
                            onClick={() => navigateMoveFolder(f)}
                            className="w-full flex items-center gap-3 p-3 rounded-[16px] bg-[var(--sf)] border border-[var(--bd)] hover:border-[#2563EB]/60 text-left transition-colors group"
                          >
                            <span className="w-9 h-9 rounded-xl bg-amber-500/15 text-[#F59E0B] flex items-center justify-center shrink-0">
                              <Folder size={17} fill="currentColor" />
                            </span>
                            <span className="font-bold text-sm text-[var(--tx)] truncate flex-1">{f.name}</span>
                            <ChevronRight size={17} className="text-[var(--sub)] group-hover:text-[var(--tx)] shrink-0" />
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Modal Footer */}
                <div className="px-6 py-4 bg-[var(--sf)] border-t border-[var(--bd)] shrink-0 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => { setIsMoveModalOpen(false); syncUrl({ modal: null }); }}
                    className="h-10 px-4 rounded-[18px] font-bold text-sm text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)] transition-colors whitespace-nowrap shrink-0"
                  >
                    Cancel
                  </button>
                  <div className="flex items-center gap-2">
                    {moveTargetAccountId && moveTargetAccountId !== selectedAccountId && (
                      <button
                        type="button"
                        onClick={() => handleMoveConfirm(true)}
                        disabled={moveLoading}
                        className="h-10 px-4 rounded-[18px] font-bold border border-[var(--bd)] text-[var(--tx)] hover:border-[var(--sub)]/60 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 text-xs sm:text-sm"
                      >
                        Backup Batch
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleMoveConfirm(false)}
                      disabled={moveLoading}
                      className="h-10 px-5 rounded-[18px] font-bold text-sm bg-[#2563EB] text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-600/20 capitalize whitespace-nowrap shrink-0"
                    >
                      {modalAction} here
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Full Screen Gallery Modal */}
        <AnimatePresence>
          {fullScreenGalleryFile && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[200] flex items-center justify-center bg-black/95 backdrop-blur-xl" onClick={() => { setFullScreenGalleryFile(null); syncUrl({ galleryFileId: null }); }} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
              
              <div className="absolute top-4 right-4 z-50">
                <button onClick={(e) => { e.stopPropagation(); setFullScreenGalleryFile(null); syncUrl({ galleryFileId: null }); }} className="p-3 bg-white/10 hover:bg-white/20 text-white rounded-full backdrop-blur-md transition-all">
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

        <ShareModal
          isOpen={Boolean(shareTargetFile)}
          file={shareTargetFile}
          accountId={selectedAccountId}
          getAuthHeaders={getAuthHeaders}
          onClose={() => { setShareTargetFile(null); syncUrl({ shareFileId: null }); }}
          onToast={showToast}
        />
      </main>
    </div>
  );
}

