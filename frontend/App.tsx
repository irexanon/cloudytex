import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Plus, Search, Trash2, RotateCcw, Edit3, Download, Folder, FolderPlus, File as FileIconLucide, ChevronRight, ChevronLeft, ChevronDown, 
  LogOut, Cloud, HardDrive, X, RefreshCw, Check, CheckCircle2, LayoutGrid, 
  List as ListIcon, Info, Moon, Sun, Eye, Settings, MoreVertical, MoreHorizontal, 
  Share2, Send, ArrowLeft, ArrowUp, ArrowDown, ExternalLink, Archive, FileArchive, Copy,
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
import FileIcon from "./components/FileIcon";
import TelegramIcon from "./components/Icons/TelegramIcon";
import {
  parseAppLocation,
  buildAppUrl,
  type AppPage,
  type AppRouteState,
  type BreadcrumbItem,
  type OverlayModal,
  type SettingsTab,
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
  const [viewMode, setViewMode]           = useState<'list' | 'grid'>('grid');
  const [isDrivesExpanded, setIsDrivesExpanded] = useState(false);
  const [sortBy, setSortBy]               = useState<'name' | 'modified' | 'size'>('name');
  const [sortOrder, setSortOrder]         = useState<'asc' | 'desc'>('asc');
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [focusedFileId, setFocusedFileId] = useState<string | null>(null);
  const [previewInfoOpen, setPreviewInfoOpen] = useState(false);
  const [isBackupDropdownOpen, setIsBackupDropdownOpen] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [runningJobsCount, setRunningJobsCount] = useState(0);
  const [runningJobsPct, setRunningJobsPct] = useState(0);
  const [cachedJobs, setCachedJobs] = useState<any[] | null>(null);
  const [userSettings, setUserSettings]   = useState<any>(null);
  const [linkProviderModal, setLinkProviderModal] = useState(initialRoute.modal === 'link-account');
  const [tgDriveModal, setTgDriveModal]   = useState(initialRoute.modal === 'tg-drive');
  const [tgChannelInput, setTgChannelInput] = useState('');
  const [tgDriveNameInput, setTgDriveNameInput] = useState('');
  const [tgRegisterLoading, setTgRegisterLoading] = useState(false);
  const [tgRegisterError, setTgRegisterError] = useState('');
  const [tgImportAccount, setTgImportAccount] = useState<any | null>(null);
  const [tgImportText, setTgImportText] = useState('');
  const [tgImportFileName, setTgImportFileName] = useState('');
  const [tgImportLoading, setTgImportLoading] = useState(false);
  const [tgImportError, setTgImportError] = useState('');
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
  const [uploadMenuAnchor, setUploadMenuAnchor] = useState<'toolbar' | 'mobile' | null>(null);
  const [isBreadcrumbMenuOpen, setIsBreadcrumbMenuOpen] = useState(false);
  const [isMobileFolderMenuOpen, setIsMobileFolderMenuOpen] = useState(false);
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
  const [previewMediaError, setPreviewMediaError] = useState<string | null>(null);
  const [previewTextContent, setPreviewTextContent] = useState<string | null>(null);
  const [previewTextLoading, setPreviewTextLoading] = useState(false);
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialRoute.settingsTab);
  const [driveTransferModal, setDriveTransferModal] = useState<{ sourceAccount: any; isMove: boolean } | null>(null);
  const [driveTransferTargetId, setDriveTransferTargetId] = useState<string>('');
  const [driveTransferTargetFolder, setDriveTransferTargetFolder] = useState<string>('');
  const [driveTransferConflict, setDriveTransferConflict] = useState<'skip' | 'rename' | 'overwrite'>('skip');
  const [driveTransferSubmitting, setDriveTransferSubmitting] = useState<boolean>(false);
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
    setFocusedFileId(fileId);
  };

  const handleSingleClick = (file: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.innerWidth < 768) {
      if (file.type === 'folder') navigateToFolder(file);
      else openPreview(file);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      toggleSelection(e, file.id);
      return;
    }
    setFocusedFileId(file.id);
    // If Details Inspector is already open, live-update it to follow focus (Google Drive behavior)
    if (selectedFile) {
      setSelectedFile(file);
      syncUrl({ infoFileId: file.id }, 'replace');
    }
  };

  const handleDoubleClick = (file: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setFocusedFileId(file.id);
    if (file.type === 'folder') navigateToFolder(file);
    else openPreview(file);
  };

  const handleRowContextMenu = (file: any, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFocusedFileId(file.id);
    setContextMenu({ file, x: e.clientX, y: e.clientY });
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

  const fetchAccounts = useCallback(async (forceRefresh = false) => {
    if (!isAuthenticated) return;
    const controller = new AbortController();
    const tId = setTimeout(() => controller.abort(), 15000);
    try {
      setLoading(true);
      const url = forceRefresh ? '/api/accounts?refresh=1' : '/api/accounts';
      const res = await fetch(url, { headers: getAuthHeaders(), signal: controller.signal });
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
        if (!res.ok) {
          showToast(data?.error || 'Could not load trash items', 'error');
          setFiles([]);
          return;
        }
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
      if (!res.ok) {
        showToast(data?.error || 'Could not load files from this drive', 'error');
        setFiles([]);
        return;
      }
      setFiles(Array.isArray(data) ? data : []);
    } catch (err: any) {
      showToast(err?.message || 'Could not load files', 'error');
    } finally { setLoading(false); }
  }, [getAuthHeaders, isTrashView, showToast]);

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
  useEffect(() => {
    setPreviewMediaError(null);
    setPreviewTextContent(null);
    setPreviewTextLoading(false);
    if (!previewFile || !selectedAccountId || previewFile.isEncrypted) return;
    const lowerName = String(previewFile.name || '').toLowerCase();
    const lowerMime = String(previewFile.mimeType || '').toLowerCase();
    const isTextLike = Boolean(
      previewFile.isNote ||
      lowerMime.startsWith('text/') ||
      /\.(txt|md|log|csv|json)$/i.test(lowerName)
    );
    const maxPreviewBytes = 512 * 1024;
    if (!isTextLike || Number(previewFile.sizeBytes || 0) > maxPreviewBytes) return;

    const controller = new AbortController();
    setPreviewTextLoading(true);
    const srcUrl = previewFile.url || `/api/download/${encodeURIComponent(selectedAccountId)}/${encodeURIComponent(previewFile.id)}?preview=1`;
    fetch(srcUrl, { headers: getAuthHeaders(), signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          let errMsg = 'Unable to load note preview.';
          try {
            const j = await res.json();
            if (j?.error) errMsg = j.error;
          } catch {}
          throw new Error(errMsg);
        }
        return res.text();
      })
      .then((txt) => {
        if (!controller.signal.aborted) setPreviewTextContent(txt);
      })
      .catch((err: any) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        fetchAccounts(true);
        setPreviewMediaError(err?.message || 'Unable to load this text note.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewTextLoading(false);
      });
    return () => controller.abort();
  }, [previewFile?.id, selectedAccountId]);

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

  // ── Bulk Import Telegram Channel / Forum Group JSON ───────────────────────
  const SAMPLE_TG_IMPORT_JSON = JSON.stringify(
    {
      isForum: true,
      topics: [
        { threadId: 1, name: 'General' },
        { threadId: 12, name: 'Movies' },
        { threadId: 45, name: 'Notes' },
      ],
      files: [
        {
          messageId: 101,
          threadId: 12,
          name: 'Interstellar.mkv',
          size: 2147483648,
          mimeType: 'video/x-matroska',
          date: 1732000000,
          caption: '1080p BluRay',
        },
        {
          messageId: 102,
          threadId: 45,
          name: 'Server Credentials.txt',
          text: 'Host: example.com\nNotes from group thread',
          date: 1732000500,
        },
      ],
    },
    null,
    2
  );

  const openTgImportModal = (acc: any) => {
    setTgImportAccount(acc);
    setTgImportText('');
    setTgImportFileName('');
    setTgImportError('');
  };

  const handleTgImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      setTgImportError('JSON file exceeds the 15 MB limit. Please split it into smaller batches.');
      return;
    }
    try {
      const text = await file.text();
      setTgImportText(text);
      setTgImportFileName(file.name);
      setTgImportError('');
    } catch {
      setTgImportError('Could not read the selected JSON file.');
    }
  };

  const getTgImportPreview = (raw: string): { valid: boolean; topics: number; files: number; error?: string } => {
    const trimmed = raw.trim();
    if (!trimmed) return { valid: false, topics: 0, files: 0 };
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return { valid: true, topics: 0, files: parsed.length };
      }
      if (parsed && typeof parsed === 'object') {
        const topicsArr = parsed.topics || parsed.threads || parsed.folders || [];
        const filesArr = parsed.files || parsed.messages || parsed.media || [];
        if (!Array.isArray(topicsArr) && !Array.isArray(filesArr)) {
          return { valid: false, topics: 0, files: 0, error: 'JSON must include a "topics" or "files" array.' };
        }
        return {
          valid: true,
          topics: Array.isArray(topicsArr) ? topicsArr.length : 0,
          files: Array.isArray(filesArr) ? filesArr.length : 0,
        };
      }
      return { valid: false, topics: 0, files: 0, error: 'JSON root must be an object or array.' };
    } catch {
      return { valid: false, topics: 0, files: 0, error: 'Invalid JSON syntax.' };
    }
  };

  const handleImportTgJson = async () => {
    if (!tgImportAccount || !tgImportText.trim()) return;
    let payload: any;
    try {
      payload = JSON.parse(tgImportText);
    } catch {
      setTgImportError('Invalid JSON syntax. Please check the file or pasted text.');
      return;
    }
    setTgImportLoading(true);
    setTgImportError('');
    try {
      const res = await fetch(`/api/tgdrive/${encodeURIComponent(tgImportAccount.id)}/import`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      const targetAccId = tgImportAccount.id;
      setTgImportAccount(null);
      setTgImportText('');
      setTgImportFileName('');
      const parts: string[] = [];
      if (data.importedTopics > 0) parts.push(`${data.importedTopics} topic folder${data.importedTopics === 1 ? '' : 's'}`);
      parts.push(`${data.importedFiles} file${data.importedFiles === 1 ? '' : 's'}`);
      if (data.skippedDuplicates > 0) parts.push(`${data.skippedDuplicates} duplicate${data.skippedDuplicates === 1 ? '' : 's'} skipped`);
      showToast(`Imported ${parts.join(', ')}`);
      fetchAccounts();
      if (selectedAccountId === targetAccId) {
        fetchFiles(targetAccId, currentFolderId, debouncedSearch, isTrashView);
      }
    } catch (err: any) {
      setTgImportError(err.message || 'Import failed');
    } finally {
      setTgImportLoading(false);
    }
  };

  const handleExportTgJson = async (acc: any) => {
    if (!acc?.id) return;
    try {
      const res = await fetch(`/api/tgdrive/${encodeURIComponent(acc.id)}/export`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        let errMsg = 'Export failed';
        try {
          const j = await res.json();
          if (j?.error) errMsg = j.error;
        } catch {}
        throw new Error(errMsg);
      }
      const blob = await res.blob();
      const safeName = String(acc.name || 'tgdrive')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'tgdrive';
      saveAs(blob, `${safeName}-export.json`);
      showToast(`Exported ${acc.name || 'TG Drive'} JSON`);
    } catch (err: any) {
      showToast(err?.message || 'Failed to export JSON', 'error');
    }
  };

  const openDriveTransferModal = (sourceAccount: any, isMove: boolean) => {
    const otherAccounts = accounts.filter((a) => a.id !== sourceAccount.id);
    setDriveTransferTargetId(otherAccounts[0]?.id || '');
    setDriveTransferTargetFolder('');
    setDriveTransferConflict('skip');
    setDriveTransferSubmitting(false);
    setDriveTransferModal({ sourceAccount, isMove });
  };

  const handleStartDriveTransfer = async () => {
    if (!driveTransferModal?.sourceAccount?.id) return;
    if (!driveTransferTargetId) {
      showToast('Please select a destination drive', 'error');
      return;
    }
    const cleanTargetFolder = driveTransferTargetFolder.trim().replace(/^\/+|\/+$/g, '') || 'root';
    if (driveTransferTargetId === driveTransferModal.sourceAccount.id && cleanTargetFolder === 'root') {
      showToast('Choose a different destination drive or enter a subfolder path', 'error');
      return;
    }
    setDriveTransferSubmitting(true);
    try {
      const res = await fetch('/api/transfers/drive', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAccountId: driveTransferModal.sourceAccount.id,
          targetAccountId: driveTransferTargetId,
          sourceFolderId: 'root',
          targetFolderId: cleanTargetFolder,
          isMove: driveTransferModal.isMove,
          conflictStrategy: driveTransferConflict,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to start drive transfer');
      const actionWord = driveTransferModal.isMove ? 'move' : 'copy';
      showToast(`Whole-drive ${actionWord} started in background`);
      setDriveTransferModal(null);
      setIsSettingsOpen(false);
      setIsJobsDrawerOpen(true);
      syncUrl({ page: 'jobs' });
    } catch (err: any) {
      showToast(err?.message || 'Failed to start drive transfer', 'error');
    } finally {
      setDriveTransferSubmitting(false);
    }
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
    let ticketErr: Error | null = null;
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
      } else if (res.status === 403 || res.status === 404) {
        const errData = await res.json().catch(() => null);
        if (errData?.code === 'TG_CHANNEL_ACCESS_DENIED' || errData?.error) {
          ticketErr = new Error(errData.error || 'Access denied to this file');
        }
      }
    } catch { /* fallback below */ }
    if (ticketErr) throw ticketErr;
    const token = localStorage.getItem('cloudyte_token') || '';
    const suffix = opts.preview ? `?preview=1&token=${encodeURIComponent(token)}` : `?token=${encodeURIComponent(token)}`;
    return `/api/download/${encodeURIComponent(accId)}/${encodeURIComponent(fileId)}${suffix}`;
  }, [getAuthHeaders]);

  // ── Download: uses short-lived resumable download ticket (supports HEAD, byte-range, & resume) ─
  const handleDownload = async (fileId: string) => {
    if (!selectedAccountId) return;
    try {
      const url = await requestDownloadTicketUrl(selectedAccountId, fileId, { singleUse: false, ttlSeconds: 3600 });
      const link = document.createElement('a');
      link.href = url;
      link.rel = 'noopener noreferrer';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      showToast(err.message || 'Download failed', 'error');
      fetchAccounts();
    }
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
    if (!selectedAccountId || !file || file.type === 'folder') return;
    setFullScreenGalleryFile(null);
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

  const openFullScreenGallery = useCallback(async (file: any, opts: { syncHistory?: boolean } = {}) => {
    await openPreview(file, opts);
  }, [openPreview]);

  const previewableFiles = files.filter(f => f.type !== 'folder');
  const activePreviewIndex = previewFile ? previewableFiles.findIndex(f => f.id === previewFile.id) : -1;
  const hasNextPreview = activePreviewIndex >= 0 && activePreviewIndex < previewableFiles.length - 1;
  const hasPrevPreview = activePreviewIndex > 0;

  const navigatePreview = useCallback(async (direction: 'next' | 'prev', e?: React.MouseEvent) => {
    e?.stopPropagation();
    let target: any = null;
    if (direction === 'next' && activePreviewIndex >= 0 && activePreviewIndex < previewableFiles.length - 1) {
      target = previewableFiles[activePreviewIndex + 1];
    }
    if (direction === 'prev' && activePreviewIndex > 0) {
      target = previewableFiles[activePreviewIndex - 1];
    }
    if (!target || !selectedAccountId) return;
    const url = await requestDownloadTicketUrl(selectedAccountId, target.id, {
      singleUse: false,
      ttlSeconds: 600,
      preview: true,
    });
    setPreviewFile({ ...target, url });
    syncUrl({ previewFileId: target.id, galleryFileId: null }, 'replace');
  }, [activePreviewIndex, previewableFiles, selectedAccountId, requestDownloadTicketUrl, syncUrl]);

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
    if (distance > minSwipeDistance && hasNextPreview) navigatePreview('next');
    if (distance < -minSwipeDistance && hasPrevPreview) navigatePreview('prev');
    touchStartX.current = null;
    touchEndX.current = null;
  };

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

  // Lightweight running-jobs polling for header status pill & instant Transfers cache
  useEffect(() => {
    if (!isAuthenticated) {
      setRunningJobsCount(0);
      setRunningJobsPct(0);
      setCachedJobs(null);
      return;
    }
    let cancelled = false;
    const pollActiveJobs = async () => {
      try {
        const res = await fetch('/api/jobs', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const list = await res.json();
        if (cancelled || !Array.isArray(list)) return;
        setCachedJobs(list);
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

  const parseReadableSizeToBytes = (rawSize: any): number => {
    if (typeof rawSize === 'number' && Number.isFinite(rawSize)) return rawSize;
    const str = String(rawSize || '').trim();
    const match = str.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return num * (mult[unit] || 1);
  };

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
      let cmp = 0;
      if (sortBy === 'size') {
        cmp = parseReadableSizeToBytes(a.sizeBytes ?? a.size) - parseReadableSizeToBytes(b.sizeBytes ?? b.size);
      } else if (sortBy === 'modified') {
        const aTime = typeof a.updatedAt === 'number' ? a.updatedAt : (Date.parse(a.modifiedTime || a.modified || a.createdAt || '') || 0);
        const bTime = typeof b.updatedAt === 'number' ? b.updatedAt : (Date.parse(b.modifiedTime || b.modified || b.createdAt || '') || 0);
        cmp = aTime - bTime;
      }
      if (cmp === 0) {
        cmp = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [files, sortBy, sortOrder, searchFilterType]);

  // Global keyboard shortcuts for Lightbox & Desktop File Browser
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (previewFile) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          navigatePreview('next');
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          navigatePreview('prev');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setPreviewFile(null);
          setPreviewInfoOpen(false);
          syncUrl({ previewFileId: null, galleryFileId: null });
        } else if (e.key.toLowerCase() === 'i' && !isTyping) {
          setPreviewInfoOpen(prev => !prev);
        }
        return;
      }

      if (isTyping || !isAuthenticated) return;
      if (confirmModal?.isOpen || promptModal?.isOpen || isMoveModalOpen || linkProviderModal || tgDriveModal || tgImportAccount || driveTransferModal || shareTargetFile) return;

      if (e.key === 'Escape') {
        if (contextMenu) { setContextMenu(null); return; }
        if (isSortMenuOpen) { setIsSortMenuOpen(false); return; }
        if (isBreadcrumbMenuOpen) { setIsBreadcrumbMenuOpen(false); return; }
        if (isMobileFolderMenuOpen) { setIsMobileFolderMenuOpen(false); return; }
        if (uploadMenuAnchor) { setUploadMenuAnchor(null); return; }
        if (selectedFile) { openFileInspector(null); return; }
        if (selectedFileIds.size > 0) { setSelectedFileIds(new Set()); return; }
        if (focusedFileId) { setFocusedFileId(null); return; }
        return;
      }

      if (isSettingsOpen || isJobsDrawerOpen || isAdminPanelOpen || displayedFiles.length === 0) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedFileIds(new Set(displayedFiles.map(f => f.id)));
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const curIdx = displayedFiles.findIndex(f => f.id === focusedFileId);
        const nextIdx =
          e.key === 'ArrowDown'
            ? (curIdx < 0 ? 0 : Math.min(displayedFiles.length - 1, curIdx + 1))
            : (curIdx <= 0 ? 0 : curIdx - 1);
        const nextFile = displayedFiles[nextIdx];
        if (nextFile) {
          setFocusedFileId(nextFile.id);
          if (selectedFile) {
            setSelectedFile(nextFile);
            syncUrl({ infoFileId: nextFile.id }, 'replace');
          }
        }
        return;
      }

      if (e.key === 'Enter' && focusedFileId) {
        const focused = displayedFiles.find(f => f.id === focusedFileId);
        if (focused) {
          e.preventDefault();
          if (focused.type === 'folder') navigateToFolder(focused);
          else openPreview(focused);
        }
        return;
      }

      if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
        if (selectedFileIds.size > 0) {
          e.preventDefault();
          handleBulkDelete();
        } else if (focusedFileId) {
          e.preventDefault();
          handleDeleteFile(focusedFileId);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [
    previewFile,
    navigatePreview,
    syncUrl,
    isAuthenticated,
    confirmModal?.isOpen,
    promptModal?.isOpen,
    isMoveModalOpen,
    linkProviderModal,
    tgDriveModal,
    tgImportAccount,
    driveTransferModal,
    shareTargetFile,
    contextMenu,
    isSortMenuOpen,
    isBreadcrumbMenuOpen,
    isMobileFolderMenuOpen,
    uploadMenuAnchor,
    selectedFile,
    openFileInspector,
    selectedFileIds,
    focusedFileId,
    isSettingsOpen,
    isJobsDrawerOpen,
    isAdminPanelOpen,
    displayedFiles,
    openPreview,
  ]);

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
      <div className={`min-h-screen bg-[var(--bg)] text-[var(--tx)] flex flex-col items-center justify-center p-6 relative transition-colors duration-200 ${isDarkMode ? 'dark' : ''}`}>
        {/* Theme toggle in corner */}
        <button
          type="button"
          onClick={() => setIsDarkMode(!isDarkMode)}
          className="fixed top-5 right-5 w-10 h-10 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)] flex items-center justify-center transition-colors"
          title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <div className="w-full max-w-[400px] bg-[var(--sf)] border border-[var(--bd)] rounded-[28px] p-8 shadow-sm">
          <div className="flex flex-col items-center text-center mb-7">
            <div className="w-12 h-12 rounded-2xl bg-[#2563EB] text-white flex items-center justify-center shadow-md shadow-blue-600/20 mb-4">
              <Cloud size={24} fill="currentColor" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--tx)] tracking-tight">
              {isRegisterMode ? 'Create your account' : 'Sign in to Cloudyte'}
            </h1>
            <p className="text-sm text-[var(--sub)] mt-1">
              {isRegisterMode ? 'Set up a workspace for your cloud drives' : 'Access all your connected drives in one place'}
            </p>
          </div>

          <form onSubmit={isRegisterMode ? handleRegister : handleLogin} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[var(--sub)]">Username</label>
              <input
                name="username"
                type="text"
                placeholder="Enter username"
                required
                autoComplete="username"
                className="w-full h-11 px-4 bg-[var(--bg)] border border-[var(--bd)] focus:border-[#2563EB] rounded-xl outline-none transition-colors text-sm font-medium text-[var(--tx)] placeholder:text-[var(--sub)]/70"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[var(--sub)]">Password</label>
              <input
                name="password"
                type="password"
                placeholder="Enter password"
                required
                autoComplete={isRegisterMode ? 'new-password' : 'current-password'}
                className="w-full h-11 px-4 bg-[var(--bg)] border border-[var(--bd)] focus:border-[#2563EB] rounded-xl outline-none transition-colors text-sm font-medium text-[var(--tx)] placeholder:text-[var(--sub)]/70"
              />
            </div>
            {isRegisterMode && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[var(--sub)]">Confirm password</label>
                <input
                  name="confirm_password"
                  type="password"
                  placeholder="Re-enter password"
                  required
                  autoComplete="new-password"
                  className="w-full h-11 px-4 bg-[var(--bg)] border border-[var(--bd)] focus:border-[#2563EB] rounded-xl outline-none transition-colors text-sm font-medium text-[var(--tx)] placeholder:text-[var(--sub)]/70"
                />
              </div>
            )}

            {loginError && (
              <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-rose-600 dark:text-rose-400 text-xs font-medium">
                {loginError}
              </motion.p>
            )}

            <button
              disabled={isLoggingIn}
              className="w-full h-11 bg-[#2563EB] hover:bg-blue-700 text-white rounded-xl font-semibold text-sm transition-colors active:scale-[0.99] flex items-center justify-center gap-2 disabled:opacity-50 mt-2"
            >
              {isLoggingIn ? (
                <><RefreshCw size={16} className="animate-spin" /><span>{isRegisterMode ? 'Creating account...' : 'Signing in...'}</span></>
              ) : (
                <span>{isRegisterMode ? 'Create account' : 'Sign in'}</span>
              )}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-[var(--bd)] flex flex-col items-center gap-2 text-center">
            {!regSettings ? (
              <div className="flex items-center gap-2 text-[var(--sub)] text-xs">
                <RefreshCw size={12} className="animate-spin" />
                <span>Loading workspace settings...</span>
              </div>
            ) : isRegisterMode ? (
              <button
                type="button"
                onClick={() => {
                  setIsRegisterMode(false);
                  setLoginError(null);
                  window.history.pushState(null, '', '/login');
                }}
                className="text-xs font-semibold text-[#2563EB] dark:text-[#60A5FA] hover:underline"
              >
                Already have an account? Sign in
              </button>
            ) : canRegisterOnWeb ? (
              <button
                type="button"
                onClick={() => {
                  setIsRegisterMode(true);
                  setLoginError(null);
                  window.history.pushState(null, '', '/register');
                }}
                className="text-xs font-semibold text-[#2563EB] dark:text-[#60A5FA] hover:underline"
              >
                New here? Create an account
              </button>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-[var(--sub)]">
                  Registration is invite-only on this workspace.
                </p>
                {regSettings?.botRegistrationEnabled !== false && !isRegDisabled && (
                  <p className="text-xs text-[var(--sub)]">
                    Use <span className="font-mono text-[#2563EB] dark:text-[#60A5FA]">/register</span> in the Telegram bot.
                  </p>
                )}
              </div>
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

  const isMobileSubfolderHeader =
    !isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen && !isTrashView && path.length > 1;




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
                  setIsDrivesExpanded(false);
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
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" title={acc.errorMessage || 'Drive access issue'} />
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
          <div className="absolute inset-0 z-50 bg-[#2563EB]/[0.06] ring-2 ring-inset ring-[#2563EB]/45 backdrop-blur-[1.5px] pointer-events-none flex items-end justify-center pb-10 px-4">
            <div className="bg-[var(--sf)] border border-[#2563EB]/40 rounded-2xl shadow-xl px-5 py-3.5 flex items-center gap-3.5 max-w-md">
              <span className="w-10 h-10 rounded-xl bg-[#2563EB]/12 text-[#2563EB] flex items-center justify-center shrink-0">
                <UploadCloud size={20} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--tx)]">Drop files to upload</p>
                <p className="text-xs text-[var(--sub)] truncate mt-0.5">
                  {(selectedAccount?.name || (isTgDrive ? 'TG Drive' : selectedAccount?.email || 'Drive'))}
                  {path.length > 1 ? ` › ${path.slice(1).map(p => p.name).join(' › ')}` : ' › Files'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Top Header */}
        <header className="h-16 md:h-[68px] px-4 md:px-7 flex items-center gap-3 sticky top-0 z-40 bg-[var(--bg)]/95 backdrop-blur-md shrink-0">
          {/* Mobile Header Left: Subfolder Back + Name (GDrive style), Drive Switcher Pill, or Sub-page Title */}
          {isMobileSubfolderHeader ? (
            <div className="md:hidden flex items-center gap-1.5 min-w-0 flex-1">
              <button
                type="button"
                onClick={() => {
                  setIsMobileFolderMenuOpen(false);
                  navigateUp(path.length - 2);
                }}
                className="w-9 h-9 -ml-1.5 rounded-full flex items-center justify-center text-[var(--tx)] hover:bg-[var(--sf)] active:scale-95 transition-all shrink-0"
                aria-label="Go back"
                title="Back"
              >
                <ArrowLeft size={20} />
              </button>
              <span
                className="text-[17px] font-semibold text-[var(--tx)] truncate leading-tight"
                title={path[path.length - 1]?.name}
              >
                {path[path.length - 1]?.name}
              </span>
            </div>
          ) : !isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen ? (
            <button
              type="button"
              onClick={() => setIsDrivesExpanded(true)}
              className="md:hidden h-10 pl-1.5 pr-3 rounded-[20px] bg-[var(--sf)] border border-[var(--bd)] flex items-center gap-2 text-sm font-semibold text-[var(--tx)] max-w-[200px] shrink-0"
            >
              {renderProviderBadge(selectedAccount?.accountType || 'google', 'sm')}
              <span className="truncate">
                {selectedAccount?.name || (isTgDrive ? 'TG Drive' : selectedAccount?.email || 'Select Drive')}
              </span>
              <ChevronDown size={15} className="text-[var(--sub)] shrink-0" />
            </button>
          ) : (
            <div className="md:hidden flex items-center gap-2">
              <span className="w-8 h-8 rounded-xl bg-[#2563EB] text-white flex items-center justify-center">
                <Cloud size={16} fill="currentColor" />
              </span>
              <span className="text-sm font-semibold text-[var(--tx)]">
                {isAdminPanelOpen ? 'Admin' : isSettingsOpen ? 'Settings' : 'Transfers'}
              </span>
            </div>
          )}

          {/* Desktop Active Drive Identity Pill + Compact Search Bar */}
          {!isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen && (
            <div className="hidden md:flex items-center gap-2.5 flex-1 min-w-0 max-w-[740px]">
              {accounts.length > 0 && (
                <button
                  type="button"
                  onClick={() => setIsDrivesExpanded(prev => !prev)}
                  className={`h-11 pl-2 pr-3 rounded-2xl border flex items-center gap-2 text-[13px] font-semibold transition-colors max-w-[220px] shrink-0 ${
                    isDrivesExpanded
                      ? 'bg-[var(--sel)] border-[#2563EB]/40 text-[var(--tx)]'
                      : 'bg-[var(--sf)] border-[var(--bd)] text-[var(--tx)] hover:bg-[var(--hover)]'
                  }`}
                  title="Switch connected drive"
                  aria-expanded={isDrivesExpanded}
                >
                  {renderProviderBadge(selectedAccount?.accountType || 'google', 'sm')}
                  <span className="truncate">
                    {selectedAccount?.name || (isTgDrive ? 'TG Drive' : selectedAccount?.email || 'Select Drive')}
                  </span>
                  <ChevronDown
                    size={14}
                    className={`text-[var(--sub)] shrink-0 transition-transform duration-200 ${isDrivesExpanded ? 'rotate-180' : ''}`}
                  />
                </button>
              )}

              <label className="flex flex-1 min-w-0 h-11 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] items-center pl-3.5 pr-1.5 gap-2.5 text-[var(--sub)] focus-within:border-[#2563EB] transition-colors">
                <Search size={17} className="shrink-0" />
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={isTgDrive ? 'Search TG Drive files...' : 'Search in this drive'}
                  className="border-0 outline-0 flex-1 min-w-0 text-sm font-normal bg-transparent text-[var(--tx)] placeholder:text-[var(--sub)]"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="p-1.5 rounded-xl hover:bg-[var(--hover)] text-[var(--sub)] hover:text-[var(--tx)]"
                    aria-label="Clear search"
                  >
                    <X size={15} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowSearchFilters(prev => !prev)}
                  className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors shrink-0 ${
                    showSearchFilters || searchFilterType !== 'all'
                      ? 'bg-[var(--pi)] text-[var(--pit)]'
                      : 'text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--hover)]'
                  }`}
                  title="Filter by file type"
                  aria-label="Toggle type filters"
                  aria-pressed={showSearchFilters}
                >
                  <SlidersHorizontal size={15} />
                </button>
              </label>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2 md:gap-2.5 shrink-0">
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
                className="hidden sm:flex items-center gap-2.5 h-9 px-3.5 rounded-2xl border border-[var(--bd)] bg-[var(--sf)] text-xs font-medium text-[var(--tx)] hover:border-[#2563EB]/60 transition-colors tabular-nums whitespace-nowrap shrink-0"
                title="View active transfers and uploads"
              >
                <svg width="44" height="10" viewBox="0 0 48 12" aria-hidden="true">
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
                onClick={() => {
                  setIsMobileFolderMenuOpen(false);
                  setMobileSearchOpen(prev => !prev);
                }}
                className={
                  isMobileSubfolderHeader
                    ? 'md:hidden w-9 h-9 rounded-full text-[var(--tx)] hover:bg-[var(--sf)] flex items-center justify-center transition-colors'
                    : 'md:hidden w-9 h-9 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] flex items-center justify-center'
                }
                aria-label="Toggle search"
              >
                {mobileSearchOpen ? <X size={19} /> : <Search size={19} />}
              </button>
            )}

            {/* Mobile Subfolder 3-Dot Menu (native GDrive style) */}
            {isMobileSubfolderHeader && (
              <div className="md:hidden relative">
                <button
                  type="button"
                  onClick={() => setIsMobileFolderMenuOpen(prev => !prev)}
                  className="w-9 h-9 -mr-1 rounded-full text-[var(--tx)] hover:bg-[var(--sf)] flex items-center justify-center transition-colors"
                  aria-label="Folder options"
                  aria-expanded={isMobileFolderMenuOpen}
                >
                  <MoreVertical size={19} />
                </button>
                {isMobileFolderMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsMobileFolderMenuOpen(false)} />
                    <div className="absolute right-0 mt-2 w-60 max-w-[82vw] rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-2xl z-50 p-1.5 space-y-0.5 max-h-[75vh] overflow-y-auto">
                      <div className="px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-[var(--sub)]">
                        Folder path
                      </div>
                      {path.slice(0, -1).map((ancestor, idx) => (
                        <button
                          key={`mobile-path-${ancestor.id ?? 'root'}-${idx}`}
                          type="button"
                          onClick={() => {
                            setIsMobileFolderMenuOpen(false);
                            navigateUp(idx);
                          }}
                          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs font-semibold text-[var(--tx)] hover:bg-[var(--hover)] transition-colors text-left"
                        >
                          <Folder
                            size={15}
                            className={idx === 0 ? 'text-[#2563EB] shrink-0' : 'text-[#F59E0B] shrink-0'}
                            fill={idx === 0 ? 'none' : 'currentColor'}
                          />
                          <span className="truncate">{idx === 0 ? 'Files' : ancestor.name}</span>
                        </button>
                      ))}
                      <div className="my-1 border-t border-[var(--bd)]" />
                      <button
                        type="button"
                        onClick={() => {
                          setIsMobileFolderMenuOpen(false);
                          setIsDrivesExpanded(true);
                        }}
                        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs font-semibold text-[var(--tx)] hover:bg-[var(--hover)] transition-colors"
                      >
                        <HardDrive size={15} className="text-[var(--sub)] shrink-0" />
                        <span>Switch drive</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsMobileFolderMenuOpen(false);
                          setIsDarkMode(!isDarkMode);
                        }}
                        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs font-semibold text-[var(--tx)] hover:bg-[var(--hover)] transition-colors"
                      >
                        {isDarkMode ? <Sun size={15} className="text-[var(--sub)] shrink-0" /> : <Moon size={15} className="text-[var(--sub)] shrink-0" />}
                        <span>{isDarkMode ? 'Light mode' : 'Dark mode'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsMobileFolderMenuOpen(false);
                          setIsJobsDrawerOpen(false);
                          setIsAdminPanelOpen(false);
                          setSettingsTab('general');
                          setIsSettingsOpen(true);
                          syncUrl({ page: 'settings', settingsTab: 'general' });
                        }}
                        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs font-semibold text-[var(--tx)] hover:bg-[var(--hover)] transition-colors"
                      >
                        <Settings size={15} className="text-[var(--sub)] shrink-0" />
                        <span>Settings</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Theme Toggle Circle */}
            <button
              type="button"
              onClick={() => setIsDarkMode(!isDarkMode)}
              className={`${isMobileSubfolderHeader ? 'hidden md:flex' : 'flex'} w-9 h-9 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--hover)] items-center justify-center transition-colors shrink-0`}
              title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDarkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            {/* Avatar Circle & Account Menu */}
            <div className={`${isMobileSubfolderHeader ? 'hidden md:block' : 'block'} relative`}>
              <button
                type="button"
                onClick={() => setIsProfileMenuOpen(prev => !prev)}
                className="w-9 h-9 rounded-full bg-[#2563EB] text-white text-xs font-semibold flex items-center justify-center shadow-sm hover:opacity-90 transition-opacity shrink-0"
                title={username ? `@${username}` : 'Account'}
              >
                {userInitials}
              </button>

              {isProfileMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsProfileMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-56 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-xl z-50 p-1.5 space-y-0.5">
                    <div className="px-3 py-2.5 border-b border-[var(--bd)]">
                      <p className="text-sm font-semibold text-[var(--tx)] truncate">
                        {username ? `@${username}` : 'Account'}
                      </p>
                      <p className="text-xs font-medium text-[var(--sub)] mt-0.5">
                        {isAdmin ? 'Administrator' : 'Cloudyte member'}
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
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium text-[var(--tx)] hover:bg-[var(--hover)] transition-colors"
                    >
                      <Settings size={15} className="text-[var(--sub)]" />
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
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium text-rose-500 hover:bg-rose-500/10 transition-colors"
                    >
                      <LogOut size={15} />
                      <span>Sign out</span>
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
                    <h1 className="text-xl sm:text-2xl font-bold text-[var(--tx)] tracking-tight">Settings</h1>
                    <p className="text-xs sm:text-sm text-[var(--sub)]">Manage preferences, active sessions, access tokens, and shared links</p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 p-1 bg-[var(--sf)] border border-[var(--bd)] rounded-2xl overflow-x-auto no-scrollbar w-fit max-w-full">
                {[
                  { id: 'general', label: 'General' },
                  { id: 'accounts', label: `Accounts (${accounts.length})` },
                  { id: 'sessions', label: 'Active Sessions' },
                  { id: 'tokens', label: 'Access Tokens' },
                  { id: 'shares', label: 'Shared Links' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      const nextTab = tab.id as SettingsTab;
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
                {settingsTab === 'accounts' ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
                      <div>
                        <h3 className="text-sm font-bold text-[var(--tx)]">Connected Drives</h3>
                        <p className="text-xs text-[var(--sub)] mt-0.5">
                          Manage cloud drives, copy or move an entire drive server-side, or import/export TG Drive backups.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setIsSettingsOpen(false); setLinkProviderModal(true); syncUrl({ page: 'drive', modal: 'link-account' }); }}
                        className="h-9 px-4 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm shrink-0"
                      >
                        <Plus size={15} />
                        <span>Connect New Drive</span>
                      </button>
                    </div>

                    {accounts.length === 0 ? (
                      <div className="p-10 text-center bg-[var(--sf)] border border-[var(--bd)] rounded-[22px] space-y-3">
                        <div className="w-12 h-12 mx-auto rounded-2xl bg-[var(--pi)] text-[var(--pit)] flex items-center justify-center">
                          <HardDrive size={22} />
                        </div>
                        <p className="text-sm font-bold text-[var(--tx)]">No connected drives yet</p>
                        <p className="text-xs text-[var(--sub)] max-w-sm mx-auto">
                          Link Google Drive, Microsoft OneDrive, or a Telegram Channel / Forum Group to get started.
                        </p>
                      </div>
                    ) : (
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
                                  {acc.error && acc.errorMessage && (
                                    <p className="text-xs text-rose-500 font-medium mt-1 break-words">{acc.errorMessage}</p>
                                  )}
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
                                      <div className="absolute right-0 mt-1.5 w-52 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-2xl z-50 p-1.5 space-y-0.5">
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
                                            openDriveTransferModal(acc, false);
                                          }}
                                          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                                        >
                                          <Copy size={14} className="text-[#2563EB]" />
                                          <span>Copy Drive</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setOpenAccountMenuId(null);
                                            openDriveTransferModal(acc, true);
                                          }}
                                          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                                        >
                                          <ArrowLeftRight size={14} className="text-amber-500" />
                                          <span>Move Drive</span>
                                        </button>
                                        {acc.accountType === 'tgdrive' && (
                                          <>
                                            <div className="my-1 border-t border-[var(--bd)]" />
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setOpenAccountMenuId(null);
                                                openTgImportModal(acc);
                                              }}
                                              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                                            >
                                              <Upload size={14} className="text-sky-500" />
                                              <span>Import JSON</span>
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setOpenAccountMenuId(null);
                                                handleExportTgJson(acc);
                                              }}
                                              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-bold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                                            >
                                              <Download size={14} className="text-sky-500" />
                                              <span>Export JSON</span>
                                            </button>
                                          </>
                                        )}
                                        <div className="my-1 border-t border-[var(--bd)]" />
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
                    )}
                  </div>
                ) : settingsTab !== 'general' ? (
                  <SecuritySettingsTabs
                    activeTab={settingsTab}
                    accounts={accounts}
                    getAuthHeaders={getAuthHeaders}
                    onToast={showToast}
                  />
                ) : !userProfile ? (
                  <div className="flex flex-col items-center justify-center p-12 space-y-4 bg-[var(--sf)] border border-[var(--bd)] rounded-2xl">
                    <RefreshCw size={22} className="animate-spin text-blue-500" />
                    <p className="text-xs font-medium text-[var(--sub)]">Loading profile...</p>
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
                        className="p-5 sm:p-6 bg-[var(--sf)] border border-[var(--bd)] hover:border-[#2563EB] rounded-2xl flex items-center justify-between gap-4 cursor-pointer transition-colors group"
                      >
                        <div className="flex items-center gap-4 min-w-0">
                          <div className="w-11 h-11 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-sm shrink-0">
                            <Shield size={20} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <h2 className="text-[15px] font-semibold text-[var(--tx)]">Admin Control Center</h2>
                              <span className="px-2 py-0.5 rounded-full bg-[var(--pi)] text-[var(--pit)] text-[11px] font-semibold">Admin</span>
                            </div>
                            <p className="text-xs text-[var(--sub)] mt-0.5 truncate">
                              Manage users, registration permissions, system metrics &amp; audit logs
                            </p>
                          </div>
                        </div>
                        <span className="h-9 px-3.5 rounded-xl bg-[var(--pi)] text-[var(--pit)] text-xs font-semibold flex items-center gap-1 shrink-0 group-hover:opacity-90">
                          <span>Open</span>
                          <ChevronRight size={15} />
                        </span>
                      </div>
                    )}

                    <div className="space-y-2.5">
                      <h3 className="text-xs font-semibold text-[var(--sub)] px-1">Identity &amp; access</h3>
                      <div className="p-5 sm:p-6 bg-[var(--sf)] border border-[var(--bd)] rounded-2xl space-y-4">
                        <div className="flex items-center gap-3.5">
                          <div className="w-11 h-11 bg-[#2563EB] rounded-2xl flex items-center justify-center text-white font-bold text-lg">
                            {userProfile?.username?.[0]?.toUpperCase()}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-[var(--tx)]">@{userProfile?.username}</p>
                            <p className="text-xs text-[var(--sub)]">Cloudyte ID</p>
                          </div>
                        </div>

                        <div className="pt-4 border-t border-[var(--bd)] space-y-2.5">
                          <p className="text-xs font-medium text-[var(--sub)]">Linked Telegram accounts</p>
                          <div className="flex flex-wrap gap-2">
                            {userProfile?.tgIds?.length > 0 ? (
                              userProfile.tgIds.map((tid: string) => (
                                <span key={tid} className="px-2.5 py-1 bg-[var(--pi)] text-[var(--pit)] text-xs font-mono font-medium rounded-lg">
                                  ID: {tid}
                                </span>
                              ))
                            ) : (
                              <p className="text-xs text-[var(--sub)]">No Telegram accounts linked</p>
                            )}
                          </div>
                          <div className="bg-[var(--bg)] p-3 rounded-xl border border-[var(--bd)]">
                            <p className="text-xs text-[var(--sub)]">To link or unlink Telegram, use the bot's <span className="font-mono text-[var(--tx)]">/login</span> and <span className="font-mono text-[var(--tx)]">/logout</span> commands.</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2.5">
                      <h3 className="text-xs font-semibold text-[var(--sub)] px-1">Appearance &amp; behavior</h3>
                      <div className="flex items-center justify-between p-5 bg-[var(--sf)] border border-[var(--bd)] rounded-2xl">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-purple-500/12 rounded-xl flex items-center justify-center text-purple-500"><Eye size={18} /></div>
                          <div>
                            <p className="text-sm font-semibold text-[var(--tx)]">Image thumbnails</p>
                            <p className="text-xs text-[var(--sub)]">Show inline previews for image files</p>
                          </div>
                        </div>
                        <button type="button" onClick={() => updateUserSettings({ showThumbnails: !(userSettings?.showThumbnails ?? true) })} className={`w-11 h-6 rounded-full transition-all relative ${(userSettings?.showThumbnails ?? true) ? 'bg-purple-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
                          <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${(userSettings?.showThumbnails ?? true) ? 'left-6' : 'left-1'}`} />
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2.5">
                      <h3 className="text-xs font-semibold text-[var(--sub)] px-1">Sync &amp; automation</h3>
                      <div className="p-5 bg-[var(--sf)] border border-[var(--bd)] rounded-2xl space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-blue-500/12 rounded-xl flex items-center justify-center text-blue-500"><RefreshCw size={18} /></div>
                            <div>
                              <p className="text-sm font-semibold text-[var(--tx)]">Auto-mirror backup</p>
                              <p className="text-xs text-[var(--sub)]">Mirror bot uploads to a backup drive</p>
                            </div>
                          </div>
                          <button type="button" onClick={() => updateUserSettings({ backupEnabled: !userSettings?.backupEnabled })} className={`w-11 h-6 rounded-full transition-all relative ${userSettings?.backupEnabled ? 'bg-[#2563EB]' : 'bg-slate-300 dark:bg-slate-700'}`}>
                            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${userSettings?.backupEnabled ? 'left-6' : 'left-1'}`} />
                          </button>
                        </div>
                        <div className="space-y-1.5 pt-3 border-t border-[var(--bd)]">
                          <span className="block text-xs font-medium text-[var(--sub)] px-0.5">Backup destination</span>
                          {(() => {
                            const selectedBackup = accounts.find(a => a.id === userSettings?.backupAccId);
                            const selectedLabel = selectedBackup
                              ? (selectedBackup.name || (selectedBackup.accountType === 'tgdrive' ? `TG Drive (${selectedBackup.channelId})` : selectedBackup.email))
                              : 'Select a backup drive';
                            return (
                              <div className="relative">
                                <button
                                  type="button"
                                  onClick={() => setIsBackupDropdownOpen(prev => !prev)}
                                  className="w-full h-11 px-3.5 rounded-xl bg-[var(--bg)] border border-[var(--bd)] hover:border-[var(--sub)]/50 flex items-center justify-between gap-2 text-sm text-[var(--tx)] transition-colors"
                                >
                                  <span className="flex items-center gap-2.5 min-w-0">
                                    {selectedBackup && renderProviderBadge(selectedBackup.accountType, 'sm')}
                                    <span className={`truncate ${selectedBackup ? 'font-medium text-[var(--tx)]' : 'text-[var(--sub)]'}`}>
                                      {selectedLabel}
                                    </span>
                                  </span>
                                  <ChevronDown size={15} className={`text-[var(--sub)] shrink-0 transition-transform ${isBackupDropdownOpen ? 'rotate-180' : ''}`} />
                                </button>
                                {isBackupDropdownOpen && (
                                  <>
                                    <div className="fixed inset-0 z-40" onClick={() => setIsBackupDropdownOpen(false)} />
                                    <div className="absolute left-0 right-0 mt-1.5 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-xl z-50 p-1.5 max-h-60 overflow-y-auto space-y-0.5">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          updateUserSettings({ backupAccId: '' });
                                          setIsBackupDropdownOpen(false);
                                        }}
                                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
                                          !userSettings?.backupAccId
                                            ? 'bg-[var(--sel)] text-[var(--tx)]'
                                            : 'text-[var(--sub)] hover:bg-[var(--hover)] hover:text-[var(--tx)]'
                                        }`}
                                      >
                                        <span>None (disabled)</span>
                                        {!userSettings?.backupAccId && <Check size={14} className="text-[#2563EB]" />}
                                      </button>
                                      {accounts.map(acc => {
                                        const isActive = userSettings?.backupAccId === acc.id;
                                        const label = acc.name || (acc.accountType === 'tgdrive' ? `TG Drive (${acc.channelId})` : acc.email);
                                        return (
                                          <button
                                            key={acc.id}
                                            type="button"
                                            onClick={() => {
                                              updateUserSettings({ backupAccId: acc.id });
                                              setIsBackupDropdownOpen(false);
                                            }}
                                            className={`w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
                                              isActive
                                                ? 'bg-[var(--sel)] text-[var(--tx)]'
                                                : 'text-[var(--tx)] hover:bg-[var(--hover)]'
                                            }`}
                                          >
                                            <span className="flex items-center gap-2.5 min-w-0">
                                              {renderProviderBadge(acc.accountType, 'sm')}
                                              <span className="truncate">{label}</span>
                                            </span>
                                            {isActive && <Check size={14} className="text-[#2563EB] shrink-0" />}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </>
                                )}
                              </div>
                            );
                          })()}
                        </div>
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
              initialJobs={cachedJobs}
              onJobsSynced={setCachedJobs}
              onJobsChanged={() => {
                if (selectedAccountId) fetchFiles(selectedAccountId, currentFolderId, debouncedSearch, isTrashView);
              }}
            />
          ) : loading && accounts.length === 0 ? (
            <div className="space-y-4 pt-1">
              <div className="h-8 w-44 bg-[var(--sf)] border border-[var(--bd)] rounded-xl animate-pulse" />
              <div className="rounded-2xl bg-[var(--sf)] border border-[var(--bd)] divide-y divide-[var(--bd)]/60 overflow-hidden">
                {[...Array(7)].map((_, i) => (
                  <div key={i} className="h-[52px] px-4 flex items-center gap-4">
                    <div className="w-8 h-8 rounded-lg bg-[var(--bg)] animate-pulse shrink-0" />
                    <div className="h-3.5 rounded-md bg-[var(--bg)] animate-pulse flex-1 max-w-[260px]" />
                    <div className="hidden md:block h-3 w-20 rounded-md bg-[var(--bg)] animate-pulse ml-auto" />
                    <div className="hidden md:block h-3 w-14 rounded-md bg-[var(--bg)] animate-pulse" />
                  </div>
                ))}
              </div>
            </div>
          ) : !loading && accounts.length === 0 ? (
            <div className="max-w-xl mx-auto py-8 md:py-14 space-y-6">
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-[22px] bg-[#2563EB] text-white flex items-center justify-center mx-auto shadow-xl shadow-blue-600/25">
                  <Cloud size={32} fill="currentColor" />
                </div>
                <h1 className="text-2xl sm:text-3xl font-bold text-[var(--tx)] tracking-tight">
                  Welcome to Cloudyte
                </h1>
                <p className="text-sm text-[var(--sub)] max-w-md mx-auto leading-relaxed">
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
                        <p className="text-sm font-semibold text-[var(--tx)]">{opt.title}</p>
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
                    className="w-full h-11 rounded-2xl bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-sm active:scale-[0.99] transition-all"
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
            <div
              className="space-y-3.5"
              onClick={(e) => {
                if (e.target === e.currentTarget) setFocusedFileId(null);
              }}
            >
              {/* Mobile Toolbar (Native Google Drive style: Grid + Refresh left, Sort right; Upload & New Folder hidden in favor of + FAB) */}
              <div className="flex md:hidden items-center justify-between gap-2">
                {isTrashView ? (
                  <>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="flex items-center gap-1.5 py-1 text-[15px] font-semibold text-rose-500 whitespace-nowrap">
                        <Trash2 size={15} />
                        <span>Trash</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => setViewMode(prev => (prev === 'list' ? 'grid' : 'list'))}
                        className="w-9 h-9 rounded-xl flex items-center justify-center text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)] transition-colors"
                        aria-label={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
                      >
                        {viewMode === 'list' ? <LayoutGrid size={18} /> : <ListIcon size={18} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => selectedAccountId && fetchFiles(selectedAccountId, currentFolderId, searchQuery, isTrashView)}
                        className="w-9 h-9 rounded-xl flex items-center justify-center text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)] transition-colors"
                        aria-label="Refresh"
                      >
                        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleTrashView(false)}
                        className="h-9 px-3 rounded-xl bg-[var(--tonal)] text-[var(--tonalt)] text-xs font-semibold flex items-center gap-1.5 shrink-0"
                        aria-label="Back to Drive"
                      >
                        <ArrowLeft size={15} />
                      </button>
                      {files.length > 0 && (
                        <button
                          type="button"
                          onClick={handleEmptyTrash}
                          className="h-9 px-3 rounded-xl bg-rose-600 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0"
                        >
                          <Trash2 size={14} />
                          <span>Empty</span>
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {/* Left: Grid/List toggle + Refresh icon */}
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setViewMode(prev => (prev === 'list' ? 'grid' : 'list'))}
                        className="w-9 h-9 rounded-xl flex items-center justify-center text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)] transition-colors"
                        title={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
                        aria-label={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
                      >
                        {viewMode === 'list' ? <LayoutGrid size={18} /> : <ListIcon size={18} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => selectedAccountId && fetchFiles(selectedAccountId, currentFolderId, searchQuery, isTrashView)}
                        className="w-9 h-9 rounded-xl flex items-center justify-center text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)] transition-colors"
                        title="Refresh"
                        aria-label="Refresh"
                      >
                        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                      </button>
                    </div>

                    {/* Right: Name Sort selector */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setIsSortMenuOpen(prev => !prev)}
                        className={`h-9 px-2.5 rounded-xl flex items-center gap-1.5 text-xs font-semibold transition-colors ${
                          isSortMenuOpen
                            ? 'bg-[var(--pi)] text-[var(--pit)]'
                            : 'text-[var(--tx)] hover:bg-[var(--sf)]'
                        }`}
                        title="Sort files"
                        aria-expanded={isSortMenuOpen}
                      >
                        {sortOrder === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                        <span className="capitalize">{sortBy}</span>
                        <ChevronDown size={13} className="opacity-70" />
                      </button>
                      {isSortMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setIsSortMenuOpen(false)} />
                          <div className="absolute right-0 mt-1.5 w-44 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-xl z-50 p-1.5 space-y-0.5">
                            <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--sub)]">Sort by</div>
                            {(
                              [
                                { id: 'name', label: 'Name' },
                                { id: 'modified', label: 'Modified' },
                                { id: 'size', label: 'Size' },
                              ] as const
                            ).map((opt) => (
                              <button
                                key={`m-sort-${opt.id}`}
                                type="button"
                                onClick={() => {
                                  setSortBy(opt.id);
                                  setIsSortMenuOpen(false);
                                }}
                                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                                  sortBy === opt.id
                                    ? 'bg-[var(--sel)] text-[var(--tx)]'
                                    : 'text-[var(--tx)] hover:bg-[var(--hover)]'
                                }`}
                              >
                                <span>{opt.label}</span>
                                {sortBy === opt.id && <Check size={13} className="text-[#2563EB]" />}
                              </button>
                            ))}
                            <div className="my-1 border-t border-[var(--bd)]" />
                            <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--sub)]">Direction</div>
                            {(
                              [
                                { id: 'asc', label: 'Ascending', icon: <ArrowUp size={12} /> },
                                { id: 'desc', label: 'Descending', icon: <ArrowDown size={12} /> },
                              ] as const
                            ).map((dir) => (
                              <button
                                key={`m-dir-${dir.id}`}
                                type="button"
                                onClick={() => {
                                  setSortOrder(dir.id);
                                  setIsSortMenuOpen(false);
                                }}
                                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                                  sortOrder === dir.id
                                    ? 'bg-[var(--sel)] text-[var(--tx)]'
                                    : 'text-[var(--tx)] hover:bg-[var(--hover)]'
                                }`}
                              >
                                <span className="flex items-center gap-1.5">
                                  {dir.icon}
                                  <span>{dir.label}</span>
                                </span>
                                {sortOrder === dir.id && <Check size={13} className="text-[#2563EB]" />}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Desktop Breadcrumbs & Toolbar */}
              <div className="hidden md:flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 min-w-0 py-1">
                  {isTrashView ? (
                    <>
                      <button
                        type="button"
                        onClick={() => navigateUp(0)}
                        className="flex items-center gap-2 py-1 px-1.5 rounded-lg text-[15px] font-medium text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--hover)] whitespace-nowrap shrink-0 transition-colors"
                      >
                        <Folder size={18} className="text-[var(--sub)] shrink-0" />
                        <span>Files</span>
                      </button>
                      <ChevronRight size={15} className="text-[var(--sub)] shrink-0" />
                      <span className="flex items-center gap-1.5 py-1 px-1.5 text-[15px] font-semibold text-rose-500 whitespace-nowrap shrink-0">
                        <Trash2 size={15} />
                        <span>Trash</span>
                      </span>
                    </>
                  ) : path.length <= 1 ? (
                    <button
                      type="button"
                      onClick={() => navigateUp(0)}
                      className="flex items-center gap-2 py-1 px-1.5 rounded-lg text-[15px] font-semibold text-[var(--tx)] whitespace-nowrap shrink-0 transition-colors"
                    >
                      <Folder size={18} className="text-[#2563EB] shrink-0" fill="currentColor" />
                      <span>Files</span>
                    </button>
                  ) : (
                    <>
                      <div className="relative shrink-0">
                        <button
                          type="button"
                          onClick={() => setIsBreadcrumbMenuOpen(prev => !prev)}
                          title="Parent folders"
                          aria-label="Show parent folders"
                          aria-expanded={isBreadcrumbMenuOpen}
                          className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${
                            isBreadcrumbMenuOpen
                              ? 'bg-[var(--pi)] text-[var(--pit)]'
                              : 'text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)]'
                          }`}
                        >
                          <MoreHorizontal size={17} />
                        </button>
                        {isBreadcrumbMenuOpen && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setIsBreadcrumbMenuOpen(false)} />
                            <div className="absolute left-0 mt-1.5 w-60 max-w-[80vw] rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-2xl z-50 p-1.5 space-y-0.5 max-h-72 overflow-y-auto">
                              <div className="px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-[var(--sub)]">
                                Folder path
                              </div>
                              {path.slice(0, -1).map((ancestor, idx) => (
                                <button
                                  key={`${ancestor.id ?? 'root'}-${idx}`}
                                  type="button"
                                  onClick={() => {
                                    setIsBreadcrumbMenuOpen(false);
                                    navigateUp(idx);
                                  }}
                                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs font-semibold text-[var(--tx)] hover:bg-[var(--hover)] transition-colors text-left"
                                >
                                  <Folder
                                    size={15}
                                    className={idx === 0 ? 'text-[#2563EB] shrink-0' : 'text-[#F59E0B] shrink-0'}
                                    fill={idx === 0 ? 'none' : 'currentColor'}
                                  />
                                  <span className="truncate">{idx === 0 ? 'Files' : ancestor.name}</span>
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                      <ChevronRight size={15} className="text-[var(--sub)] shrink-0" />
                      <div
                        className="flex items-center gap-2 py-1 px-1.5 rounded-lg text-[15px] font-semibold text-[var(--tx)] min-w-0"
                        title={path[path.length - 1]?.name}
                      >
                        <Folder size={17} className="text-[#2563EB] shrink-0" fill="currentColor" />
                        <span className="truncate max-w-[180px] sm:max-w-[320px] md:max-w-[420px]">
                          {path[path.length - 1]?.name}
                        </span>
                      </div>
                    </>
                  )}
                </div>

                <div className="ml-auto flex items-center gap-1 shrink-0">
                  {/* Sort Menu (works for both List & Grid views) */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setIsSortMenuOpen(prev => !prev)}
                      className={`h-9 px-2.5 rounded-xl flex items-center gap-1.5 text-xs font-medium transition-colors ${
                        isSortMenuOpen
                          ? 'bg-[var(--pi)] text-[var(--pit)]'
                          : 'text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)]'
                      }`}
                      title="Sort files"
                      aria-expanded={isSortMenuOpen}
                    >
                      {sortOrder === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                      <span className="capitalize">{sortBy}</span>
                      <ChevronDown size={13} className="opacity-70" />
                    </button>
                    {isSortMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setIsSortMenuOpen(false)} />
                        <div className="absolute right-0 mt-1.5 w-44 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-xl z-50 p-1.5 space-y-0.5">
                          <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--sub)]">Sort by</div>
                          {(
                            [
                              { id: 'name', label: 'Name' },
                              { id: 'modified', label: 'Modified' },
                              { id: 'size', label: 'Size' },
                            ] as const
                          ).map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => {
                                setSortBy(opt.id);
                                setIsSortMenuOpen(false);
                              }}
                              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                                sortBy === opt.id
                                  ? 'bg-[var(--sel)] text-[var(--tx)]'
                                  : 'text-[var(--tx)] hover:bg-[var(--hover)]'
                              }`}
                            >
                              <span>{opt.label}</span>
                              {sortBy === opt.id && <Check size={13} className="text-[#2563EB]" />}
                            </button>
                          ))}
                          <div className="my-1 border-t border-[var(--bd)]" />
                          <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--sub)]">Direction</div>
                          {(
                            [
                              { id: 'asc', label: 'Ascending', icon: <ArrowUp size={12} /> },
                              { id: 'desc', label: 'Descending', icon: <ArrowDown size={12} /> },
                            ] as const
                          ).map((dir) => (
                            <button
                              key={dir.id}
                              type="button"
                              onClick={() => {
                                setSortOrder(dir.id);
                                setIsSortMenuOpen(false);
                              }}
                              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                                sortOrder === dir.id
                                  ? 'bg-[var(--sel)] text-[var(--tx)]'
                                  : 'text-[var(--tx)] hover:bg-[var(--hover)]'
                              }`}
                            >
                              <span className="flex items-center gap-1.5">
                                {dir.icon}
                                <span>{dir.label}</span>
                              </span>
                              {sortOrder === dir.id && <Check size={13} className="text-[#2563EB]" />}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Single Grid / List View Toggle */}
                  <button
                    type="button"
                    onClick={() => setViewMode(prev => (prev === 'list' ? 'grid' : 'list'))}
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)] transition-colors"
                    title={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
                    aria-label={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
                  >
                    {viewMode === 'list' ? <LayoutGrid size={18} /> : <ListIcon size={18} />}
                  </button>

                  <button
                    type="button"
                    onClick={() => selectedAccountId && fetchFiles(selectedAccountId, currentFolderId, searchQuery, isTrashView)}
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--sf)] transition-colors"
                    title="Refresh"
                    aria-label="Refresh"
                  >
                    <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                  </button>

                  {isTrashView ? (
                    <div className="flex items-center gap-1.5 ml-1">
                      <button
                        type="button"
                        onClick={() => toggleTrashView(false)}
                        className="h-9 px-3.5 rounded-xl bg-[var(--tonal)] text-[var(--tonalt)] text-xs font-semibold flex items-center gap-1.5 hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                      >
                        <ArrowLeft size={15} />
                        <span>Back to Drive</span>
                      </button>
                      {files.length > 0 && (
                        <button
                          type="button"
                          onClick={handleEmptyTrash}
                          className="h-9 px-3.5 rounded-xl bg-rose-600 text-white text-xs font-semibold flex items-center gap-1.5 hover:bg-rose-700 transition-colors whitespace-nowrap shrink-0"
                        >
                          <Trash2 size={15} />
                          <span>Empty Trash</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 ml-1">
                      <button
                        type="button"
                        onClick={handleCreateFolder}
                        className="h-9 px-3.5 md:px-4 rounded-xl bg-[var(--tonal)] text-[var(--tonalt)] text-xs font-semibold flex items-center gap-1.5 hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                        title="New folder"
                      >
                        <FolderPlus size={16} />
                        <span>New folder</span>
                      </button>

                      <div className="relative">
                        <button
                          type="button"
                          disabled={accounts.length === 0}
                          onClick={() => setUploadMenuAnchor(prev => (prev === 'toolbar' ? null : 'toolbar'))}
                          title="Upload files or folder"
                          aria-label="Upload"
                          className={`h-9 px-3.5 md:px-4 rounded-xl bg-[var(--pi)] text-[var(--pit)] text-xs font-semibold flex items-center gap-1.5 hover:opacity-90 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 ${
                            accounts.length === 0 ? 'opacity-40 pointer-events-none' : ''
                          }`}
                        >
                          <Upload size={15} />
                          <span>Upload</span>
                        </button>

                        {uploadMenuAnchor === 'toolbar' && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setUploadMenuAnchor(null)} />
                            <div className="absolute right-0 mt-1.5 w-60 rounded-[22px] bg-[var(--sf)] border border-[var(--bd)] shadow-2xl z-50 p-2 space-y-1">
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
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Lightweight Search Type Filter Chips */}
              {(showSearchFilters || searchFilterType !== 'all') && (
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-0.5">
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
                        className={`h-8 px-3 rounded-xl text-xs font-medium flex items-center gap-1.5 border transition-colors whitespace-nowrap shrink-0 ${
                          isActive
                            ? 'bg-[var(--pi)] text-[var(--pit)] border-transparent'
                            : 'bg-[var(--sf)] text-[var(--sub)] border-[var(--bd)] hover:text-[var(--tx)]'
                        }`}
                      >
                        {isActive && <Check size={13} strokeWidth={2.5} />}
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
                      className="h-8 px-2.5 rounded-xl text-xs font-medium text-[var(--sub)] hover:text-[var(--tx)] whitespace-nowrap shrink-0"
                    >
                      Reset
                    </button>
                  )}
                </div>
              )}

              {/* Inline Non-Blocking Account & Storage Alert Banners */}
              {selectedAccount?.error && (
                <div className="rounded-2xl px-4 py-3 bg-rose-500/10 border border-rose-500/25 text-rose-600 dark:text-rose-400 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="w-8 h-8 rounded-xl bg-rose-500/15 flex items-center justify-center shrink-0">
                      <AlertTriangle size={16} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-semibold">
                        {selectedAccount.accountType === 'tgdrive'
                          ? `${selectedAccount.name || 'TG Drive'} — Telegram channel inaccessible`
                          : `${selectedAccount.name || selectedAccount.email || 'This drive'} needs to reconnect`}
                      </p>
                      <p className="text-xs opacity-90 break-words">
                        {selectedAccount.errorMessage ||
                          (selectedAccount.accountType === 'tgdrive'
                            ? 'Telegram bot does not have admin access to this channel. Add the bot back as an Admin to restore downloads and previews.'
                            : 'Refresh authorization to continue browsing and uploading files.')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => fetchAccounts(true)}
                      className="h-8 px-3 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-700 dark:text-rose-300 text-xs font-semibold transition-colors"
                    >
                      Re-check
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedAccount.accountType === 'tgdrive') {
                          setTgChannelInput(selectedAccount.channelId || '');
                          setTgDriveNameInput(selectedAccount.name || '');
                          setTgDriveModal(true);
                          syncUrl({ modal: 'tg-drive' });
                        } else {
                          handleConnect(selectedAccount.accountType === 'onedrive' ? 'onedrive' : 'google');
                        }
                      }}
                      className="h-8 px-3.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold transition-colors"
                    >
                      Reconnect
                    </button>
                  </div>
                </div>
              )}

              {!isTrashView && !selectedAccount?.error && selectedAccount?.accountType !== 'tgdrive' && Number(selectedAccount?.percentage || 0) >= 90 && (
                <div className="rounded-2xl px-4 py-3 bg-amber-500/10 border border-amber-500/25 text-amber-700 dark:text-amber-300 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
                      <AlertTriangle size={16} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-semibold truncate">
                        {selectedAccount.name || selectedAccount.email} is {selectedAccount.percentage}% full
                      </p>
                      <p className="text-xs opacity-85 truncate">
                        {selectedAccount.usage} of {selectedAccount.total} used — move or archive files to another drive to free up space.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsDrivesExpanded(true)}
                    className="h-8 px-3.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 text-xs font-semibold shrink-0 transition-colors"
                  >
                    Switch drive
                  </button>
                </div>
              )}

              {/* File list / grid */}
              <div className="relative">
                {loading && displayedFiles.length > 0 && (
                  <div className="mb-2 h-0.5 bg-[var(--pi)] rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: '0%', x: '-100%' }}
                      animate={{ width: '100%', x: '100%' }}
                      transition={{ repeat: Infinity, duration: 1.2, ease: 'easeInOut' }}
                      className="h-full bg-[#2563EB] rounded-full"
                    />
                  </div>
                )}

                {loading && displayedFiles.length === 0 ? (
                  viewMode === 'list' ? (
                    <div className="rounded-2xl bg-[var(--sf)] border border-[var(--bd)] divide-y divide-[var(--bd)]/60 overflow-hidden">
                      {[...Array(8)].map((_, i) => (
                        <div key={i} className="h-[52px] px-4 flex items-center gap-3.5">
                          <div className="hidden md:block w-4 h-4 rounded bg-[var(--bg)] animate-pulse shrink-0" />
                          <div className="w-8 h-8 rounded-lg bg-[var(--bg)] animate-pulse shrink-0" />
                          <div
                            className="h-3.5 rounded-md bg-[var(--bg)] animate-pulse"
                            style={{ width: `${140 + ((i * 37) % 160)}px` }}
                          />
                          <div className="hidden md:block h-3 w-20 rounded-md bg-[var(--bg)] animate-pulse ml-auto" />
                          <div className="hidden md:block h-3 w-14 rounded-md bg-[var(--bg)] animate-pulse ml-6" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                      {[...Array(12)].map((_, i) => (
                        <div key={i} className="p-4 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] flex flex-col items-center gap-3">
                          <div className="w-20 h-20 rounded-2xl bg-[var(--bg)] animate-pulse" />
                          <div className="w-full space-y-1.5 flex flex-col items-center">
                            <div className="h-3.5 w-3/4 rounded-md bg-[var(--bg)] animate-pulse" />
                            <div className="h-3 w-1/3 rounded-md bg-[var(--bg)] animate-pulse" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                ) : displayedFiles.length === 0 ? (
                  isTrashView ? (
                    <div className="flex flex-col items-center justify-center py-24 text-[var(--sub)] gap-4">
                      <div className="w-16 h-16 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] flex items-center justify-center">
                        <Trash2 size={28} />
                      </div>
                      <div className="text-center space-y-1 max-w-sm">
                        <p className="text-base font-semibold text-[var(--tx)]">Trash is empty</p>
                        <p className="text-sm text-[var(--sub)]">
                          Deleted files from this drive will appear here for recovery or permanent removal.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleTrashView(false)}
                        className="h-9 px-5 rounded-xl bg-[var(--pi)] text-[var(--pit)] font-semibold text-xs hover:opacity-90 transition-opacity"
                      >
                        Back to Drive
                      </button>
                    </div>
                  ) : (debouncedSearch.trim() || searchFilterType !== 'all') ? (
                    <div className="flex flex-col items-center justify-center py-24 text-[var(--sub)] gap-4">
                      <div className="w-14 h-14 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] flex items-center justify-center">
                        <Search size={24} />
                      </div>
                      <div className="text-center space-y-1 max-w-sm">
                        <p className="text-base font-semibold text-[var(--tx)]">
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
                            className="h-9 px-4 rounded-xl bg-[var(--pi)] text-[var(--pit)] font-semibold text-xs hover:opacity-90 transition-opacity"
                          >
                            Clear search
                          </button>
                        )}
                        {searchFilterType !== 'all' && (
                          <button
                            type="button"
                            onClick={() => setSearchFilterType('all')}
                            className="h-9 px-4 rounded-xl bg-[var(--sf)] border border-[var(--bd)] text-[var(--tx)] font-semibold text-xs hover:border-[var(--sub)]/50 transition-colors"
                          >
                            Show all types
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="border border-dashed border-[var(--bd)] rounded-2xl bg-[var(--sf)]/50 flex flex-col items-center justify-center py-20 px-6 text-[var(--sub)] gap-4">
                      <div className="w-14 h-14 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] flex items-center justify-center text-[#2563EB]">
                        {isTgDrive ? <TelegramIcon size={28} /> : <UploadCloud size={28} />}
                      </div>
                      <div className="text-center space-y-1 max-w-sm">
                        <p className="text-base font-semibold text-[var(--tx)]">This folder is empty</p>
                        <p className="text-sm text-[var(--sub)]">
                          {isTgDrive
                            ? 'Drop files here or upload to store them in this Telegram channel.'
                            : 'Drop files anywhere here or upload to add items to this folder.'}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                        <label className="h-9 px-4 rounded-xl bg-[#2563EB] text-white font-semibold text-xs flex items-center gap-2 cursor-pointer hover:bg-blue-700 transition-colors">
                          <Upload size={15} />
                          <span>Upload files</span>
                          <input type="file" className="hidden" onChange={handleUpload} multiple />
                        </label>
                        <button
                          type="button"
                          onClick={handleCreateFolder}
                          className="h-9 px-4 rounded-xl bg-[var(--sf)] border border-[var(--bd)] text-[var(--tx)] font-semibold text-xs flex items-center gap-2 hover:bg-[var(--hover)] transition-colors"
                        >
                          <FolderPlus size={15} />
                          <span>New folder</span>
                        </button>
                      </div>
                    </div>
                  )
                ) : viewMode === 'list' ? (
                  <>
                    {/* Clean Hairline Desktop File Table */}
                    <div className="hidden md:block rounded-2xl bg-[var(--sf)] border border-[var(--bd)] overflow-hidden">
                      {/* Table Header */}
                      <div className="grid grid-cols-[32px_38px_1fr_140px_100px_132px] gap-3 items-center px-4 h-10 bg-[var(--bg)]/45 border-b border-[var(--bd)] text-xs font-medium text-[var(--sub)] select-none">
                        <div className="flex items-center justify-center">
                          {(() => {
                            const allSelected = displayedFiles.length > 0 && selectedFileIds.size === displayedFiles.length;
                            const someSelected = selectedFileIds.size > 0 && !allSelected;
                            return (
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={allSelected ? 'true' : someSelected ? 'mixed' : 'false'}
                                aria-label="Select all files"
                                onClick={() => {
                                  if (allSelected) setSelectedFileIds(new Set());
                                  else setSelectedFileIds(new Set(displayedFiles.map(f => f.id)));
                                }}
                                className={`w-4 h-4 rounded-[5px] border flex items-center justify-center transition-colors ${
                                  allSelected || someSelected
                                    ? 'bg-[#2563EB] border-[#2563EB] text-white'
                                    : 'border-[var(--sub)]/45 hover:border-[#2563EB] bg-transparent'
                                }`}
                              >
                                {allSelected ? (
                                  <Check size={11} strokeWidth={3} />
                                ) : someSelected ? (
                                  <span className="w-2 h-0.5 rounded-full bg-white" />
                                ) : null}
                              </button>
                            );
                          })()}
                        </div>
                        <span />
                        <button
                          type="button"
                          onClick={() => {
                            if (sortBy === 'name') setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
                            else { setSortBy('name'); setSortOrder('asc'); }
                          }}
                          className={`flex items-center gap-1 text-left transition-colors ${
                            sortBy === 'name' ? 'text-[var(--tx)] font-semibold' : 'hover:text-[var(--tx)]'
                          }`}
                        >
                          <span>Name</span>
                          {sortBy === 'name' && (sortOrder === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (sortBy === 'modified') setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
                            else { setSortBy('modified'); setSortOrder('desc'); }
                          }}
                          className={`flex items-center gap-1 text-left transition-colors ${
                            sortBy === 'modified' ? 'text-[var(--tx)] font-semibold' : 'hover:text-[var(--tx)]'
                          }`}
                        >
                          <span>Modified</span>
                          {sortBy === 'modified' && (sortOrder === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (sortBy === 'size') setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
                            else { setSortBy('size'); setSortOrder('desc'); }
                          }}
                          className={`flex items-center gap-1 text-left transition-colors ${
                            sortBy === 'size' ? 'text-[var(--tx)] font-semibold' : 'hover:text-[var(--tx)]'
                          }`}
                        >
                          <span>Size</span>
                          {sortBy === 'size' && (sortOrder === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
                        </button>
                        <span />
                      </div>

                      {/* Table Rows */}
                      <div className="divide-y divide-[var(--bd)]/60">
                        {displayedFiles.map((file) => {
                          const isChecked = selectedFileIds.has(file.id);
                          const isFocused = focusedFileId === file.id || selectedFile?.id === file.id;
                          const isHighlighted = isChecked || isFocused;
                          return (
                            <div
                              key={file.id}
                              onClick={(e) => handleSingleClick(file, e)}
                              onDoubleClick={(e) => handleDoubleClick(file, e)}
                              onContextMenu={(e) => handleRowContextMenu(file, e)}
                              className={`group grid grid-cols-[32px_38px_1fr_140px_100px_132px] gap-3 items-center px-4 h-[52px] cursor-pointer transition-colors select-none ${
                                isHighlighted
                                  ? 'bg-[var(--sel)] shadow-[inset_3px_0_0_#2563EB]'
                                  : 'hover:bg-[var(--hover)]'
                              }`}
                            >
                              <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                                <button
                                  type="button"
                                  role="checkbox"
                                  aria-checked={isChecked}
                                  aria-label={isChecked ? `Deselect ${file.name}` : `Select ${file.name}`}
                                  onClick={(e) => toggleSelection(e, file.id)}
                                  className={`w-4 h-4 rounded-[5px] border flex items-center justify-center transition-all ${
                                    isChecked
                                      ? 'bg-[#2563EB] border-[#2563EB] text-white opacity-100'
                                      : selectedFileIds.size > 0
                                      ? 'border-[var(--sub)]/45 hover:border-[#2563EB] opacity-100'
                                      : 'border-[var(--sub)]/45 hover:border-[#2563EB] opacity-0 group-hover:opacity-100 focus:opacity-100'
                                  }`}
                                >
                                  {isChecked && <Check size={11} strokeWidth={3} />}
                                </button>
                              </div>

                              <div className="flex items-center justify-center">
                                <FileIcon
                                  file={file}
                                  type={file.type}
                                  isTg={file.isTgDrive}
                                  accountId={selectedAccountId}
                                  showThumbnails={userSettings?.showThumbnails !== false}
                                />
                              </div>

                              <div className="min-w-0">
                                {file.isNote && file.textPreview ? (
                                  <p className="text-sm font-normal text-[var(--tx)] truncate" title={file.textPreview}>
                                    {file.textPreview.replace(/\s+/g, ' ')}
                                  </p>
                                ) : (
                                  <p className="text-sm font-medium text-[var(--tx)] truncate">{file.name}</p>
                                )}
                              </div>

                              <span className="text-[13px] font-normal text-[var(--sub)] truncate tabular-nums">
                                {file.modified || '—'}
                              </span>

                              <span className="font-mono text-xs text-[var(--sub)] tabular-nums truncate">
                                {file.type === 'folder' ? '—' : file.size}
                              </span>

                              <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                  {isTrashView ? (
                                    <>
                                      <button type="button" onClick={() => handleRestoreFile(file.id)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-emerald-500 hover:bg-[var(--bg)]/70" title="Restore">
                                        <RotateCcw size={15} />
                                      </button>
                                      <button type="button" onClick={() => handlePermanentDeleteFile(file.id)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-rose-500 hover:bg-[var(--bg)]/70" title="Delete forever">
                                        <Trash2 size={15} />
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      {file.type !== 'folder' && (
                                        <button type="button" onClick={() => openPreview(file)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-[#2563EB] hover:bg-[var(--bg)]/70" title="Preview">
                                          <Eye size={15} />
                                        </button>
                                      )}
                                      {file.type !== 'folder' && (
                                        <button type="button" onClick={() => handleDownload(file.id)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-[#2563EB] hover:bg-[var(--bg)]/70" title="Download">
                                          <Download size={15} />
                                        </button>
                                      )}
                                      <button type="button" onClick={() => handleRename(file.id, file.name)} className="p-1.5 rounded-lg text-[var(--sub)] hover:text-[#2563EB] hover:bg-[var(--bg)]/70" title="Rename">
                                        <Edit3 size={15} />
                                      </button>
                                    </>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    setContextMenu({ file, x: rect.left - 160, y: rect.bottom });
                                  }}
                                  className="p-1.5 rounded-lg text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)]/70 transition-colors"
                                  title="More actions"
                                  aria-label={`More actions for ${file.name}`}
                                >
                                  <MoreVertical size={16} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Mobile Hairline List */}
                    <div className="md:hidden rounded-2xl bg-[var(--sf)] border border-[var(--bd)] divide-y divide-[var(--bd)]/60 overflow-hidden">
                      {displayedFiles.map((file) => {
                        const isChecked = selectedFileIds.has(file.id);
                        return (
                          <div
                            key={file.id}
                            onClick={(e) => handleSingleClick(file, e)}
                            onContextMenu={(e) => handleRowContextMenu(file, e)}
                            className={`grid grid-cols-[40px_1fr_28px] gap-3 items-center px-3.5 py-2.5 cursor-pointer transition-colors ${
                              isChecked ? 'bg-[var(--sel)]' : 'active:bg-[var(--hover)]'
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
                              {file.isNote && file.textPreview ? (
                                <p className="text-[13.5px] font-normal text-[var(--tx)] line-clamp-2 leading-snug">
                                  {file.textPreview}
                                </p>
                              ) : (
                                <p className="text-[14.5px] font-medium text-[var(--tx)] truncate">{file.name}</p>
                              )}
                              <p className="text-xs text-[var(--sub)] truncate mt-0.5 tabular-nums">
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
                                  <MoreVertical size={17} />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                    {displayedFiles.map(file => {
                      const isChecked = selectedFileIds.has(file.id);
                      const isFocused = focusedFileId === file.id || selectedFile?.id === file.id;
                      return (
                        <div
                          key={file.id}
                          onClick={(e) => handleSingleClick(file, e)}
                          onDoubleClick={(e) => handleDoubleClick(file, e)}
                          onContextMenu={(e) => handleRowContextMenu(file, e)}
                          className={`group relative rounded-2xl p-4 border flex flex-col items-center text-center cursor-pointer transition-all select-none ${
                            isChecked || isFocused
                              ? 'bg-[var(--sel)] border-[#2563EB] ring-1 ring-[#2563EB]/30'
                              : 'bg-[var(--sf)] border-[var(--bd)] hover:border-[#2563EB]/45 hover:bg-[var(--hover)]/60'
                          }`}
                        >
                          {/* Top-left selection checkbox */}
                          <button
                            type="button"
                            onClick={(e) => toggleSelection(e, file.id)}
                            aria-label={isChecked ? `Deselect ${file.name}` : `Select ${file.name}`}
                            className={`absolute top-2.5 left-2.5 w-5 h-5 rounded-[6px] flex items-center justify-center z-10 transition-all ${
                              isChecked
                                ? 'bg-[#2563EB] text-white opacity-100 shadow-sm'
                                : selectedFileIds.size > 0
                                ? 'bg-[var(--sf)] border border-[var(--sub)]/45 text-transparent opacity-100'
                                : 'bg-[var(--sf)]/90 border border-[var(--bd)] text-transparent opacity-0 group-hover:opacity-100'
                            }`}
                          >
                            <Check size={12} strokeWidth={3} />
                          </button>

                          {/* Top-right actions menu */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setContextMenu({ file, x: rect.left - 160, y: rect.bottom });
                            }}
                            aria-label={`More actions for ${file.name}`}
                            className="absolute top-2 right-2 p-1 rounded-lg text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)]/80 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity z-10"
                          >
                            <MoreVertical size={16} />
                          </button>

                          {file.isNote && file.textPreview ? (
                            <>
                              <div className="mt-2 mb-3 w-full h-[92px] rounded-xl bg-[var(--bg)]/85 border border-[var(--bd)]/80 p-3 text-left overflow-hidden flex flex-col justify-start">
                                <p className="text-[12px] leading-relaxed text-[var(--tx)] font-normal whitespace-pre-wrap break-words line-clamp-4">
                                  {file.textPreview}
                                </p>
                              </div>
                              <div className="w-full min-w-0 space-y-0.5">
                                <p className="text-[11.5px] text-[var(--sub)] truncate tabular-nums">
                                  {file.modified && file.modified !== '-' ? `${file.modified} · ${file.size}` : file.size || '—'}
                                </p>
                              </div>
                            </>
                          ) : (
                            <>
                              {/* Centered Large Icon or Image Thumbnail */}
                              <div className="mt-2 mb-3 flex items-center justify-center">
                                <FileIcon
                                  file={file}
                                  type={file.type}
                                  size="lg"
                                  isTg={file.isTgDrive}
                                  accountId={selectedAccountId}
                                  showThumbnails={userSettings?.showThumbnails !== false}
                                />
                              </div>

                              {/* Centered Name & Subtle Meta */}
                              <div className="w-full min-w-0 space-y-0.5">
                                <p className="text-[13.5px] font-semibold text-[var(--tx)] truncate" title={file.name}>
                                  {file.name}
                                </p>
                                <p className="text-[11.5px] text-[var(--sub)] truncate tabular-nums">
                                  {file.type === 'folder' ? 'Folder' : file.size || file.modified || '—'}
                                </p>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
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

        {/* Mobile Floating + Speed-Dial Button (Upload & New Folder sub-buttons) */}
        {!isTrashView && !isSettingsOpen && !isJobsDrawerOpen && !isAdminPanelOpen && accounts.length > 0 && (
          <div className="md:hidden fixed right-4 bottom-24 z-40 flex flex-col items-end">
            <AnimatePresence>
              {uploadMenuAnchor === 'mobile' && (
                <>
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="fixed inset-0 bg-black/25 backdrop-blur-[1px] z-30"
                    onClick={() => setUploadMenuAnchor(null)}
                  />
                  <motion.div
                    initial={{ opacity: 0, y: 12, scale: 0.94 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.94 }}
                    transition={{ duration: 0.16, ease: 'easeOut' }}
                    className="relative z-40 mb-3 flex flex-col items-end gap-2.5"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setUploadMenuAnchor(null);
                        handleCreateFolder();
                      }}
                      className="flex items-center gap-2.5 pl-4 pr-3.5 h-11 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-xl text-[13px] font-semibold text-[var(--tx)] active:scale-95 transition-transform whitespace-nowrap"
                    >
                      <span>New folder</span>
                      <span className="w-7 h-7 rounded-xl bg-[var(--tonal)] text-[var(--tonalt)] flex items-center justify-center shrink-0">
                        <FolderPlus size={16} />
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setUploadMenuAnchor(null);
                        folderUploadInputRef.current?.click();
                      }}
                      className="flex items-center gap-2.5 pl-4 pr-3.5 h-11 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-xl text-[13px] font-semibold text-[var(--tx)] active:scale-95 transition-transform whitespace-nowrap"
                    >
                      <span>Upload folder</span>
                      <span className="w-7 h-7 rounded-xl bg-amber-500/15 text-[#F59E0B] flex items-center justify-center shrink-0">
                        <FolderOpen size={16} />
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setUploadMenuAnchor(null);
                        fileUploadInputRef.current?.click();
                      }}
                      className="flex items-center gap-2.5 pl-4 pr-3.5 h-11 rounded-2xl bg-[var(--sf)] border border-[var(--bd)] shadow-xl text-[13px] font-semibold text-[var(--tx)] active:scale-95 transition-transform whitespace-nowrap"
                    >
                      <span>Upload files</span>
                      <span className="w-7 h-7 rounded-xl bg-[#2563EB]/15 text-[#2563EB] flex items-center justify-center shrink-0">
                        <UploadCloud size={16} />
                      </span>
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>

            <button
              type="button"
              onClick={() => setUploadMenuAnchor(prev => (prev === 'mobile' ? null : 'mobile'))}
              aria-label={uploadMenuAnchor === 'mobile' ? 'Close create menu' : 'Create or upload'}
              aria-expanded={uploadMenuAnchor === 'mobile'}
              className="relative z-40 w-14 h-14 rounded-2xl bg-[#2563EB] text-white flex items-center justify-center shadow-[0_8px_22px_rgba(37,99,235,0.42)] active:scale-95 transition-all"
            >
              <Plus
                size={26}
                strokeWidth={2.4}
                className={`transition-transform duration-200 ${uploadMenuAnchor === 'mobile' ? 'rotate-45' : ''}`}
              />
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
                <div className="px-6 py-4 flex items-center justify-between border-b border-[var(--bd)]">
                  <h3 className="font-semibold text-[var(--tx)] text-sm">File details</h3>
                  <button type="button" onClick={() => openFileInspector(null)} className="p-1.5 hover:bg-[var(--hover)] rounded-xl text-[var(--sub)] hover:text-[var(--tx)] transition-colors"><X size={17} /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  <div className="flex flex-col items-center text-center space-y-3">
                    <FileIcon file={selectedFile} type={selectedFile.type} size="lg" isTg={selectedFile.isTgDrive} accountId={selectedAccountId} showThumbnails={userSettings?.showThumbnails !== false} />
                    <div className="space-y-1 max-w-full">
                      <h4 className="font-semibold text-[15px] text-[var(--tx)] break-words">{selectedFile.name}</h4>
                      <p className="text-xs font-mono text-[var(--sub)] tabular-nums">{selectedFile.type === 'folder' ? 'Folder' : selectedFile.size}</p>
                      {selectedFile.isTgDrive && <p className="text-xs font-medium text-sky-500 flex items-center justify-center gap-1"><TelegramIcon size={11} /> Telegram storage</p>}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <DetailRow label="Type" value={selectedFile.type ? selectedFile.type.charAt(0).toUpperCase() + selectedFile.type.slice(1) : 'File'} />
                    <DetailRow label="Created" value={selectedFile.createdAt || '—'} />
                    <DetailRow label="Modified" value={selectedFile.modified || '—'} />
                    {selectedFile.folder !== undefined && <DetailRow label="Folder" value={selectedFile.folder || 'Root'} />}
                  </div>
                  <div className="pt-2 grid grid-cols-2 gap-2.5">
                    {isTrashView ? (
                      <>
                        <button type="button" onClick={() => handleRestoreFile(selectedFile.id)} className="flex flex-col items-center gap-1.5 p-3.5 bg-[var(--bg)] rounded-xl hover:bg-emerald-500/12 text-[var(--sub)] hover:text-emerald-500 transition-colors border border-[var(--bd)]">
                          <RotateCcw size={18} /><span className="text-xs font-medium">Restore</span>
                        </button>
                        <button type="button" onClick={() => handlePermanentDeleteFile(selectedFile.id)} className="flex flex-col items-center gap-1.5 p-3.5 bg-[var(--bg)] rounded-xl hover:bg-rose-500/12 text-[var(--sub)] hover:text-rose-500 transition-colors border border-[var(--bd)]">
                          <Trash2 size={18} /><span className="text-xs font-medium">Delete forever</span>
                        </button>
                      </>
                    ) : (
                      <>
                        {selectedFile.type !== 'folder' && (
                          <button type="button" onClick={() => handleDownload(selectedFile.id)} className="flex flex-col items-center gap-1.5 p-3.5 bg-[var(--bg)] rounded-xl hover:bg-[var(--sel)] text-[var(--sub)] hover:text-[#2563EB] transition-colors border border-[var(--bd)]">
                            <Download size={18} /><span className="text-xs font-medium">Download</span>
                          </button>
                        )}
                        <button type="button" onClick={() => handleRename(selectedFile.id, selectedFile.name)} className="flex flex-col items-center gap-1.5 p-3.5 bg-[var(--bg)] rounded-xl hover:bg-[var(--sel)] text-[var(--sub)] hover:text-[#2563EB] transition-colors border border-[var(--bd)]">
                          <Edit3 size={18} /><span className="text-xs font-medium">Rename</span>
                        </button>
                        {selectedFile.type !== 'folder' && (
                          <button type="button" onClick={() => handleShare(selectedFile.id)} className="flex flex-col items-center gap-1.5 p-3.5 bg-[var(--bg)] rounded-xl hover:bg-[var(--sel)] text-[var(--sub)] hover:text-[#2563EB] transition-colors border border-[var(--bd)]">
                            <Share2 size={18} /><span className="text-xs font-medium">Share</span>
                          </button>
                        )}
                        {['image', 'video', 'audio', 'pdf'].includes(selectedFile.type) && (
                          <button type="button" onClick={() => openPreview(selectedFile)} className="flex flex-col items-center gap-1.5 p-3.5 bg-[var(--bg)] rounded-xl hover:bg-purple-500/12 text-[var(--sub)] hover:text-purple-500 transition-colors border border-[var(--bd)]">
                            <Eye size={18} /><span className="text-xs font-medium">Preview</span>
                          </button>
                        )}
                        {selectedFile.name.toLowerCase().endsWith('.zip') && (
                          <button type="button" onClick={() => handleUnzip(selectedFile)} className="flex flex-col items-center gap-1.5 p-3.5 bg-[var(--bg)] rounded-xl hover:bg-[var(--sel)] text-[var(--sub)] hover:text-[#2563EB] transition-colors border border-[var(--bd)]">
                            <FileArchive size={18} /><span className="text-xs font-medium">Unzip</span>
                          </button>
                        )}
                        <button type="button" onClick={() => handleDeleteFile(selectedFile.id)} className="flex flex-col items-center gap-1.5 p-3.5 bg-[var(--bg)] rounded-xl hover:bg-rose-500/12 text-[var(--sub)] hover:text-rose-500 transition-colors border border-[var(--bd)]">
                          <Trash2 size={18} /><span className="text-xs font-medium">Move to trash</span>
                        </button>
                      </>
                    )}
                  </div>
                  {/* Open in Google Drive / OneDrive link */}
                  {selectedFile.webViewLink && !selectedFile.isTgDrive && (
                    <div className="pt-1">
                      <a href={selectedFile.webViewLink} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 w-full py-3 bg-[var(--sel)] text-[#2563EB] dark:text-[#60A5FA] text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity">
                        <ExternalLink size={16} /><span>Open in {selectedAccount?.accountType === 'onedrive' ? 'OneDrive' : 'Google Drive'}</span>
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
                    <p className="text-xs text-[var(--sub)] font-medium mt-0.5">Connect a Telegram channel or group</p>
                  </div>
                </div>
                <div className="bg-sky-500/12 border border-sky-500/30 rounded-[18px] p-3.5 text-xs text-sky-700 dark:text-sky-300 font-medium space-y-1">
                  <p className="font-extrabold">Before registering:</p>
                  <p>1. Create or open a Telegram Channel or Group (Forum Groups map Topics to Folders automatically)</p>
                  <p>2. Add your bot as an <strong>Administrator</strong></p>
                  <p>3. Copy the chat ID (e.g. <code className="bg-sky-500/15 px-1 rounded font-mono">-1001234567890</code>)</p>
                </div>
                <div className="space-y-3.5">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase text-[var(--sub)] px-1 tracking-widest">Drive Name</label>
                    <input
                      autoFocus
                      value={tgDriveNameInput}
                      onChange={e => setTgDriveNameInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRegisterTgDrive(); }}
                      placeholder="e.g. My Storage, Media Group"
                      className="w-full px-4 py-3.5 bg-[var(--bg)] border border-[var(--bd)] focus:border-sky-500 rounded-2xl outline-none transition-all font-bold text-sm text-[var(--tx)]"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase text-[var(--sub)] px-1 tracking-widest">Channel / Group ID or Username</label>
                    <input
                      value={tgChannelInput}
                      onChange={e => setTgChannelInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRegisterTgDrive(); }}
                      placeholder="-1001234567890 or @mygroup"
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

        {/* TG Drive JSON Import Modal */}
        <AnimatePresence>
          {tgImportAccount && (() => {
            const preview = getTgImportPreview(tgImportText);
            return (
              <div className="fixed inset-0 z-[210] flex items-center justify-center p-4 sm:p-6">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => { if (!tgImportLoading) setTgImportAccount(null); }}
                  className="absolute inset-0 bg-slate-950/65 backdrop-blur-sm"
                />
                <motion.div
                  initial={{ scale: 0.95, opacity: 0, y: 10 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.95, opacity: 0, y: 10 }}
                  transition={{ duration: 0.15 }}
                  className="bg-[var(--sf)] text-[var(--tx)] p-6 sm:p-7 rounded-[28px] shadow-2xl relative w-full max-w-lg space-y-4 border border-[var(--bd)] max-h-[90vh] overflow-y-auto"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {renderProviderBadge('tgdrive', 'md')}
                      <div className="min-w-0">
                        <h2 className="text-lg font-extrabold text-[var(--tx)] tracking-tight truncate">
                          Import JSON into {tgImportAccount.name || 'TG Drive'}
                        </h2>
                        <p className="text-xs text-[var(--sub)] font-medium mt-0.5 truncate">
                          {tgImportAccount.email}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={tgImportLoading}
                      onClick={() => setTgImportAccount(null)}
                      className="w-8 h-8 rounded-xl text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)] flex items-center justify-center transition-colors shrink-0"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  <div className="bg-sky-500/10 border border-sky-500/25 rounded-[18px] p-3.5 text-xs text-sky-700 dark:text-sky-300 font-medium space-y-1">
                    <p className="font-extrabold">Import historical topics, media &amp; text notes:</p>
                    <p>Upload or paste your scanner JSON export. Forum topics become folders, General maps to root, items with <code className="bg-sky-500/15 px-1 rounded font-mono">text</code>/<code className="bg-sky-500/15 px-1 rounded font-mono">message</code> become <code className="bg-sky-500/15 px-1 rounded font-mono">.txt</code> notes, and duplicates are skipped.</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <label className="cursor-pointer inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[var(--bg)] border border-[var(--bd)] hover:border-sky-500/60 text-xs font-bold text-[var(--tx)] transition-colors">
                      <Upload size={14} className="text-sky-500" />
                      <span>{tgImportFileName ? tgImportFileName : 'Choose .json file'}</span>
                      <input
                        type="file"
                        accept=".json,application/json"
                        onChange={handleTgImportFileChange}
                        className="hidden"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(SAMPLE_TG_IMPORT_JSON).then(
                          () => showToast('Sample JSON copied to clipboard'),
                          () => showToast('Could not copy sample JSON', 'error')
                        );
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)] border border-[var(--bd)] transition-colors"
                    >
                      <Copy size={13} />
                      <span>Copy sample format</span>
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between px-1">
                      <label className="text-[10px] font-black uppercase text-[var(--sub)] tracking-widest">JSON Payload</label>
                      {tgImportText.trim() && preview.valid && (
                        <span className="text-[11px] font-bold text-emerald-500">
                          Ready: {preview.topics} topic{preview.topics === 1 ? '' : 's'}, {preview.files} file{preview.files === 1 ? '' : 's'}
                        </span>
                      )}
                      {tgImportText.trim() && !preview.valid && preview.error && (
                        <span className="text-[11px] font-bold text-rose-500">{preview.error}</span>
                      )}
                    </div>
                    <textarea
                      rows={8}
                      value={tgImportText}
                      onChange={e => { setTgImportText(e.target.value); setTgImportError(''); }}
                      placeholder={`{\n  "isForum": true,\n  "topics": [{ "threadId": 12, "name": "Movies" }],\n  "files": [{ "messageId": 101, "threadId": 12, "name": "Movie.mkv", "size": 1048576 }]\n}`}
                      className="w-full px-3.5 py-3 bg-[var(--bg)] border border-[var(--bd)] focus:border-sky-500 rounded-2xl outline-none transition-all font-mono text-xs text-[var(--tx)] resize-y"
                    />
                  </div>

                  {tgImportError && (
                    <p className="text-rose-500 text-xs font-bold px-1">{tgImportError}</p>
                  )}

                  <div className="flex gap-2.5 pt-1">
                    <button
                      type="button"
                      disabled={tgImportLoading}
                      onClick={() => setTgImportAccount(null)}
                      className="flex-1 py-3.5 text-[var(--sub)] hover:text-[var(--tx)] font-bold hover:bg-[var(--bg)] rounded-[18px] transition-colors text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleImportTgJson}
                      disabled={tgImportLoading || !preview.valid || (preview.topics === 0 && preview.files === 0)}
                      className="flex-1 bg-sky-500 text-white font-bold py-3.5 rounded-[18px] hover:bg-sky-600 shadow-lg shadow-sky-500/20 transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                    >
                      {tgImportLoading ? (
                        <><RefreshCw size={16} className="animate-spin" /><span>Importing...</span></>
                      ) : (
                        <><Upload size={16} /><span>Import Now</span></>
                      )}
                    </button>
                  </div>
                </motion.div>
              </div>
            );
          })()}
        </AnimatePresence>

        {/* Server-Side Whole-Drive Copy / Move Modal */}
        <AnimatePresence>
          {driveTransferModal && (() => {
            const src = driveTransferModal.sourceAccount;
            const isMoveAction = driveTransferModal.isMove;
            const srcLabel = src.name || (src.accountType === 'tgdrive' ? 'TG Drive' : src.email || 'Source Drive');
            const destinationOptions = accounts.filter((a) => a.id !== src.id);
            const selectedDest = accounts.find((a) => a.id === driveTransferTargetId);
            const isFastTgCopy = src.accountType === 'tgdrive' && selectedDest?.accountType === 'tgdrive';
            return (
              <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => { if (!driveTransferSubmitting) setDriveTransferModal(null); }}
                  className="fixed inset-0 bg-black/60 backdrop-blur-md"
                />
                <motion.div
                  initial={{ opacity: 0, scale: 0.96, y: 12 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 12 }}
                  className="relative w-full max-w-lg bg-[var(--sf)] rounded-[28px] border border-[var(--bd)] shadow-2xl p-6 space-y-5 z-10 max-h-[90vh] overflow-y-auto"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${isMoveAction ? 'bg-amber-500/15 text-amber-500' : 'bg-[#2563EB]/15 text-[#2563EB]'}`}>
                        {isMoveAction ? <ArrowLeftRight size={20} /> : <Copy size={20} />}
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-base font-extrabold text-[var(--tx)] truncate">
                          {isMoveAction ? 'Move Whole Drive' : 'Copy Whole Drive'}
                        </h3>
                        <p className="text-xs text-[var(--sub)] truncate mt-0.5">
                          Server-side background transfer preserving all folders
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={driveTransferSubmitting}
                      onClick={() => setDriveTransferModal(null)}
                      className="w-9 h-9 rounded-full hover:bg-[var(--bg)] flex items-center justify-center text-[var(--sub)] transition-colors shrink-0"
                    >
                      <X size={18} />
                    </button>
                  </div>

                  {/* Source Drive */}
                  <div className="space-y-1.5">
                    <span className="text-xs font-semibold text-[var(--sub)] px-0.5">Source Drive</span>
                    <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-[var(--bg)] border border-[var(--bd)]">
                      {renderProviderBadge(src.accountType, 'sm')}
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[var(--tx)] truncate">{srcLabel}</p>
                        <p className="text-xs text-[var(--sub)] truncate">{src.email}</p>
                      </div>
                    </div>
                  </div>

                  {/* Destination Drive */}
                  <div className="space-y-1.5">
                    <span className="text-xs font-semibold text-[var(--sub)] px-0.5">Destination Drive</span>
                    {destinationOptions.length === 0 ? (
                      <div className="p-4 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-xs text-[var(--sub)]">
                        Link at least one more cloud drive first to {isMoveAction ? 'move' : 'copy'} this entire drive.
                      </div>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                        {destinationOptions.map((dest) => {
                          const selected = driveTransferTargetId === dest.id;
                          const label = dest.name || (dest.accountType === 'tgdrive' ? 'TG Drive' : dest.email);
                          return (
                            <button
                              key={dest.id}
                              type="button"
                              onClick={() => setDriveTransferTargetId(dest.id)}
                              className={`w-full flex items-center justify-between gap-3 p-3 rounded-2xl border text-left transition-colors ${
                                selected
                                  ? 'bg-[var(--sel)] border-[#2563EB]'
                                  : 'bg-[var(--bg)] border-[var(--bd)] hover:border-[var(--sub)]/50'
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                {renderProviderBadge(dest.accountType, 'sm')}
                                <div className="min-w-0">
                                  <p className="text-xs font-bold text-[var(--tx)] truncate">{label}</p>
                                  <p className="text-[11px] text-[var(--sub)] truncate">{dest.email}</p>
                                </div>
                              </div>
                              {selected && <Check size={16} className="text-[#2563EB] shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Optional Target Subfolder */}
                  {destinationOptions.length > 0 && (
                    <>
                      <div className="space-y-1.5">
                        <label className="block text-xs font-semibold text-[var(--sub)] px-0.5">
                          Destination subfolder (optional)
                        </label>
                        <input
                          type="text"
                          value={driveTransferTargetFolder}
                          onChange={(e) => setDriveTransferTargetFolder(e.target.value)}
                          placeholder="Leave empty for drive root (e.g. Backups/OldDrive)"
                          className="w-full h-11 px-3.5 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] focus:border-[#2563EB] text-xs font-medium text-[var(--tx)] outline-none"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <span className="block text-xs font-semibold text-[var(--sub)] px-0.5">If a file already exists</span>
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { id: 'skip', label: 'Skip existing' },
                            { id: 'rename', label: 'Keep both' },
                            { id: 'overwrite', label: 'Overwrite' },
                          ].map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => setDriveTransferConflict(opt.id as 'skip' | 'rename' | 'overwrite')}
                              className={`h-9 px-2.5 rounded-xl text-xs font-bold border transition-colors ${
                                driveTransferConflict === opt.id
                                  ? 'bg-[var(--pi)] text-[var(--pit)] border-transparent'
                                  : 'bg-[var(--bg)] text-[var(--sub)] border-[var(--bd)] hover:text-[var(--tx)]'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {isFastTgCopy && (
                    <div className="p-3 rounded-2xl bg-sky-500/10 border border-sky-500/20 text-xs text-sky-600 dark:text-sky-400 font-medium">
                      TG Drive → TG Drive fast-copy enabled: files &amp; notes transfer directly inside Telegram with near-zero server bandwidth.
                    </div>
                  )}

                  {isMoveAction && (
                    <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/25 text-xs text-amber-700 dark:text-amber-300 font-medium flex items-start gap-2">
                      <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                      <span>
                        Move mode removes each source file only after it is safely confirmed in the destination drive. Skipped or failed files remain untouched.
                      </span>
                    </div>
                  )}

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      type="button"
                      disabled={driveTransferSubmitting}
                      onClick={() => setDriveTransferModal(null)}
                      className="flex-1 h-11 rounded-[18px] bg-[var(--bg)] border border-[var(--bd)] text-sm font-bold text-[var(--tx)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={driveTransferSubmitting || !driveTransferTargetId || destinationOptions.length === 0}
                      onClick={handleStartDriveTransfer}
                      className={`flex-1 h-11 rounded-[18px] text-sm font-bold text-white shadow-lg transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                        isMoveAction
                          ? 'bg-amber-600 hover:bg-amber-700 shadow-amber-600/20'
                          : 'bg-[#2563EB] hover:bg-blue-700 shadow-blue-600/20'
                      }`}
                    >
                      {driveTransferSubmitting ? (
                        <><RefreshCw size={15} className="animate-spin" /><span>Starting...</span></>
                      ) : isMoveAction ? (
                        <><ArrowLeftRight size={15} /><span>Start Drive Move</span></>
                      ) : (
                        <><Copy size={15} /><span>Start Drive Copy</span></>
                      )}
                    </button>
                  </div>
                </motion.div>
              </div>
            );
          })()}
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

        {/* Unified Immersive Lightbox Preview */}
        <AnimatePresence>
          {previewFile && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[200] flex flex-col bg-slate-950/92 backdrop-blur-xl text-white"
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {/* Lightbox Top Bar */}
              <div className="h-16 px-4 sm:px-6 flex items-center justify-between gap-3 border-b border-white/10 bg-slate-950/50 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewFile(null);
                      setPreviewInfoOpen(false);
                      syncUrl({ previewFileId: null, galleryFileId: null });
                    }}
                    className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/15 text-white flex items-center justify-center transition-colors shrink-0"
                    title="Close preview (Esc)"
                    aria-label="Close preview"
                  >
                    <X size={18} />
                  </button>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{previewFile.name}</p>
                    <p className="text-xs text-slate-400 tabular-nums truncate">
                      {previewFile.size}
                      {activePreviewIndex >= 0 && previewableFiles.length > 1
                        ? ` · ${activePreviewIndex + 1} of ${previewableFiles.length}`
                        : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {previewFile.type !== 'folder' && (
                    <button
                      type="button"
                      onClick={() => handleDownload(previewFile.id)}
                      className="h-9 px-3 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium flex items-center gap-1.5 transition-colors"
                      title="Download"
                    >
                      <Download size={15} />
                      <span className="hidden sm:inline">Download</span>
                    </button>
                  )}
                  {previewFile.type !== 'folder' && (
                    <button
                      type="button"
                      onClick={() => handleShare(previewFile.id)}
                      className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/15 text-white flex items-center justify-center transition-colors"
                      title="Share"
                      aria-label="Share"
                    >
                      <Share2 size={16} />
                    </button>
                  )}
                  {previewFile.webViewLink && !previewFile.isTgDrive && (
                    <a
                      href={previewFile.webViewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/15 text-white flex items-center justify-center transition-colors"
                      title="Open in Drive"
                      aria-label="Open in Drive"
                    >
                      <ExternalLink size={16} />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => setPreviewInfoOpen(prev => !prev)}
                    className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
                      previewInfoOpen
                        ? 'bg-[#2563EB] text-white'
                        : 'bg-white/10 hover:bg-white/15 text-white'
                    }`}
                    title="File details (I)"
                    aria-label="Toggle file details"
                    aria-pressed={previewInfoOpen}
                  >
                    <Info size={16} />
                  </button>
                </div>
              </div>

              {/* Lightbox Main Stage + Optional Inline Info Drawer */}
              <div className="flex-1 min-h-0 flex relative overflow-hidden">
                <div
                  className="flex-1 min-w-0 relative flex items-center justify-center p-4 sm:p-8"
                  onClick={() => {
                    setPreviewFile(null);
                    setPreviewInfoOpen(false);
                    syncUrl({ previewFileId: null, galleryFileId: null });
                  }}
                >
                  {hasPrevPreview && (
                    <button
                      type="button"
                      onClick={(e) => navigatePreview('prev', e)}
                      className="absolute left-3 sm:left-5 z-20 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur-md flex items-center justify-center transition-colors"
                      title="Previous file (←)"
                      aria-label="Previous file"
                    >
                      <ChevronLeft size={22} />
                    </button>
                  )}

                  <div
                    className="max-w-full max-h-full flex items-center justify-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {previewMediaError ? (
                      <div className="rounded-2xl bg-slate-900/90 border border-rose-500/30 p-7 max-w-md text-center space-y-4 shadow-2xl">
                        <div className="w-12 h-12 rounded-2xl bg-rose-500/15 text-rose-400 flex items-center justify-center mx-auto">
                          <AlertTriangle size={22} />
                        </div>
                        <div className="space-y-1.5">
                          <p className="text-base font-semibold text-white">Couldn't load file</p>
                          <p className="text-sm text-slate-300 leading-relaxed">{previewMediaError}</p>
                        </div>
                        <div className="flex flex-wrap gap-2.5 justify-center pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setPreviewMediaError(null);
                              fetchAccounts(true);
                            }}
                            className="h-9 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-semibold transition-colors"
                          >
                            Retry
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDownload(previewFile.id)}
                            className="h-9 px-4 rounded-xl bg-[#2563EB] hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
                          >
                            Download
                          </button>
                        </div>
                      </div>
                    ) : previewFile.type === 'image' ? (
                      <img
                        src={previewFile.url || `/api/download/${selectedAccountId}/${previewFile.id}?preview=1`}
                        alt={previewFile.name}
                        onError={() => {
                          fetchAccounts(true);
                          setPreviewMediaError(
                            selectedAccount?.errorMessage ||
                              (selectedAccount?.accountType === 'tgdrive'
                                ? 'Unable to fetch this file from the Telegram channel. Make sure the bot is still an Admin in the channel.'
                                : 'Unable to load this preview from the cloud provider.')
                          );
                        }}
                        className="max-w-full max-h-[82vh] rounded-xl shadow-2xl object-contain"
                      />
                    ) : previewFile.type === 'video' ? (
                      <video
                        controls
                        autoPlay
                        onError={() => {
                          fetchAccounts(true);
                          setPreviewMediaError(
                            selectedAccount?.errorMessage ||
                              (selectedAccount?.accountType === 'tgdrive'
                                ? 'Unable to stream this video from the Telegram channel. Make sure the bot is still an Admin in the channel.'
                                : 'Unable to stream this video from the cloud provider.')
                          );
                        }}
                        className="max-w-full max-h-[82vh] rounded-xl shadow-2xl bg-black"
                        src={previewFile.url || `/api/download/${selectedAccountId}/${previewFile.id}?preview=1`}
                      />
                    ) : previewFile.type === 'audio' ? (
                      <div className="w-full max-w-md rounded-2xl bg-slate-900/90 border border-white/10 p-6 space-y-5 text-center shadow-2xl">
                        <div className="flex justify-center">
                          <FileIcon file={previewFile} type={previewFile.type} size="lg" isTg={previewFile.isTgDrive} accountId={selectedAccountId} />
                        </div>
                        <p className="text-sm font-semibold text-white truncate">{previewFile.name}</p>
                        <audio
                          controls
                          autoPlay
                          onError={() => {
                            fetchAccounts(true);
                            setPreviewMediaError(
                              selectedAccount?.errorMessage ||
                                (selectedAccount?.accountType === 'tgdrive'
                                  ? 'Unable to stream this audio from the Telegram channel. Make sure the bot is still an Admin in the channel.'
                                  : 'Unable to play this audio file.')
                            );
                          }}
                          className="w-full"
                          src={previewFile.url || `/api/download/${selectedAccountId}/${previewFile.id}?preview=1`}
                        />
                      </div>
                    ) : previewFile.type === 'pdf' && (previewFile.url || (previewFile.webViewLink && !previewFile.isTgDrive)) ? (
                      <iframe
                        src={previewFile.url || previewFile.webViewLink}
                        className="w-[90vw] max-w-5xl h-[82vh] rounded-xl bg-white shadow-2xl border border-white/10"
                        title={previewFile.name}
                      />
                    ) : (previewTextLoading || previewTextContent !== null) ? (
                      <div className="w-[90vw] max-w-3xl max-h-[82vh] rounded-2xl bg-slate-900/95 border border-white/10 shadow-2xl flex flex-col overflow-hidden">
                        <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between gap-3 bg-slate-950/50">
                          <span className="text-xs font-semibold text-slate-300 truncate">{previewFile.name}</span>
                          <span className="text-[11px] font-medium text-slate-400 shrink-0">{previewFile.size}</span>
                        </div>
                        <div className="p-5 overflow-auto flex-1">
                          {previewTextLoading ? (
                            <div className="py-12 flex items-center justify-center gap-2 text-slate-400 text-sm">
                              <RefreshCw size={16} className="animate-spin" />
                              <span>Loading note...</span>
                            </div>
                          ) : (
                            <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-slate-100 select-text">
                              {previewTextContent || '(Empty note)'}
                            </pre>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-2xl bg-slate-900/90 border border-white/10 p-8 max-w-md text-center space-y-5 shadow-2xl">
                        <div className="flex justify-center">
                          <FileIcon file={previewFile} type={previewFile.type} size="lg" isTg={previewFile.isTgDrive} accountId={selectedAccountId} />
                        </div>
                        <div className="space-y-1.5">
                          <p className="text-base font-semibold text-white">Preview isn't available</p>
                          <p className="text-sm text-slate-400">
                            Download this file to view it on your device.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2.5 justify-center pt-1">
                          {previewFile.webViewLink && !previewFile.isTgDrive && (
                            <a
                              href={previewFile.webViewLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="h-10 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors"
                            >
                              <ExternalLink size={15} /> Open in Drive
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDownload(previewFile.id)}
                            className="h-10 px-5 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold inline-flex items-center gap-2 transition-colors"
                          >
                            <Download size={15} /> Download
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {hasNextPreview && (
                    <button
                      type="button"
                      onClick={(e) => navigatePreview('next', e)}
                      className="absolute right-3 sm:right-5 z-20 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur-md flex items-center justify-center transition-colors"
                      title="Next file (→)"
                      aria-label="Next file"
                    >
                      <ChevronRight size={22} />
                    </button>
                  )}
                </div>

                {/* Inline Lightbox Details Panel */}
                {previewInfoOpen && (
                  <aside
                    onClick={(e) => e.stopPropagation()}
                    className="w-80 max-w-[85vw] shrink-0 bg-[#0d1322] border-l border-white/10 p-5 overflow-y-auto space-y-5"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-white">File details</h3>
                      <button
                        type="button"
                        onClick={() => setPreviewInfoOpen(false)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10"
                      >
                        <X size={15} />
                      </button>
                    </div>
                    <div className="space-y-3 text-xs">
                      <div className="flex justify-between gap-3 py-2 border-b border-white/10">
                        <span className="text-slate-400">Name</span>
                        <span className="text-white font-medium text-right break-all">{previewFile.name}</span>
                      </div>
                      <div className="flex justify-between gap-3 py-2 border-b border-white/10">
                        <span className="text-slate-400">Type</span>
                        <span className="text-white font-medium capitalize">{previewFile.type || 'File'}</span>
                      </div>
                      <div className="flex justify-between gap-3 py-2 border-b border-white/10">
                        <span className="text-slate-400">Size</span>
                        <span className="text-white font-mono tabular-nums">{previewFile.size || '—'}</span>
                      </div>
                      <div className="flex justify-between gap-3 py-2 border-b border-white/10">
                        <span className="text-slate-400">Modified</span>
                        <span className="text-white tabular-nums">{previewFile.modified || '—'}</span>
                      </div>
                      <div className="flex justify-between gap-3 py-2 border-b border-white/10">
                        <span className="text-slate-400">Created</span>
                        <span className="text-white tabular-nums">{previewFile.createdAt || '—'}</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => handleDownload(previewFile.id)}
                        className="h-9 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <Download size={14} /> Download
                      </button>
                      <button
                        type="button"
                        onClick={() => handleShare(previewFile.id)}
                        className="h-9 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <Share2 size={14} /> Share
                      </button>
                    </div>
                  </aside>
                )}
              </div>
            </motion.div>
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

