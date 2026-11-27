export type AppPage = 'drive' | 'settings' | 'jobs' | 'admin' | 'temp';
export type SettingsTab = 'general' | 'accounts' | 'sessions' | 'tokens' | 'shares';
export type AdminTab = 'overview' | 'metrics' | 'audit';
export type OverlayModal = 'link-account' | 'tg-drive' | 'move' | 'copy' | null;

export interface BreadcrumbItem {
  id: string | null;
  name: string;
}

export interface AppRouteState {
  authMode: 'login' | 'register' | null;
  page: AppPage;
  accountId: string | null;
  folderId: string | null;
  tempRoomCode: string | null;
  trash: boolean;
  settingsTab: SettingsTab;
  adminTab: AdminTab;
  adminUserId: string | null;
  search: string;
  previewFileId: string | null;
  galleryFileId: string | null;
  shareFileId: string | null;
  infoFileId: string | null;
  modal: OverlayModal;
}

const VALID_SETTINGS_TABS = new Set<SettingsTab>(['general', 'accounts', 'sessions', 'tokens', 'shares']);
const VALID_ADMIN_TABS = new Set<AdminTab>(['overview', 'metrics', 'audit']);
const VALID_MODALS = new Set<Exclude<OverlayModal, null>>(['link-account', 'tg-drive', 'move', 'copy']);

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseAppLocation(
  pathname: string = window.location.pathname,
  searchStr: string = window.location.search
): AppRouteState {
  const segments = pathname.split('/').filter(Boolean).map(safeDecode);
  const params = new URLSearchParams(searchStr);

  const rawModal = params.get('modal');
  const modal: OverlayModal =
    rawModal && VALID_MODALS.has(rawModal as Exclude<OverlayModal, null>)
      ? (rawModal as OverlayModal)
      : null;

  const state: AppRouteState = {
    authMode: null,
    page: 'drive',
    accountId: params.get('account') || null,
    folderId: null,
    tempRoomCode: null,
    trash: false,
    settingsTab: 'general',
    adminTab: 'overview',
    adminUserId: null,
    search: params.get('q') || '',
    previewFileId: params.get('preview') || null,
    galleryFileId: params.get('gallery') || null,
    shareFileId: params.get('share') || null,
    infoFileId: params.get('info') || null,
    modal,
  };

  if (segments[0] === 'login') {
    state.authMode = 'login';
    return state;
  }
  if (segments[0] === 'register') {
    state.authMode = 'register';
    return state;
  }

  if (segments[0] === 'drive' && segments[1]) {
    state.page = 'drive';
    state.accountId = segments[1];
    if (segments[2] === 'trash') {
      state.trash = true;
    } else if (segments[2] === 'folder' && segments[3]) {
      state.folderId = segments[3];
    }
    return state;
  }

  if (segments[0] === 'settings') {
    state.page = 'settings';
    const tab = segments[1] as SettingsTab | undefined;
    state.settingsTab = tab && VALID_SETTINGS_TABS.has(tab) ? tab : 'general';
    return state;
  }

  if (segments[0] === 'jobs' || segments[0] === 'transfers') {
    state.page = 'jobs';
    return state;
  }

  if (segments[0] === 'drop') {
    state.page = 'temp';
    state.tempRoomCode = segments[1] ? segments[1] : null;
    return state;
  }

  if (segments[0] === 'admin') {
    state.page = 'admin';
    if (segments[1] === 'users' && segments[2]) {
      state.adminTab = 'overview';
      state.adminUserId = segments[2];
    } else {
      const tab = segments[1] as AdminTab | undefined;
      state.adminTab = tab && VALID_ADMIN_TABS.has(tab) ? tab : 'overview';
    }
    return state;
  }

  return state;
}

export function buildAppUrl(route: Partial<AppRouteState>): string {
  let pathname = '/';
  const params = new URLSearchParams();

  if (route.authMode === 'login') {
    pathname = '/login';
    return pathname;
  }
  if (route.authMode === 'register') {
    pathname = '/register';
    return pathname;
  }

  const page = route.page || 'drive';
  if (page === 'settings') {
    const tab = route.settingsTab || 'general';
    pathname = `/settings/${tab}`;
    if (route.accountId) params.set('account', route.accountId);
  } else if (page === 'jobs') {
    pathname = '/transfers';
    if (route.accountId) params.set('account', route.accountId);
  } else if (page === 'temp') {
    pathname = route.tempRoomCode ? `/drop/${encodeURIComponent(route.tempRoomCode)}` : '/drop';
  } else if (page === 'admin') {
    if (route.adminUserId) {
      pathname = `/admin/users/${encodeURIComponent(route.adminUserId)}`;
    } else {
      const tab = route.adminTab || 'overview';
      pathname = `/admin/${tab}`;
    }
    if (route.accountId) params.set('account', route.accountId);
  } else {
    if (route.accountId) {
      pathname = `/drive/${encodeURIComponent(route.accountId)}`;
      if (route.trash) {
        pathname += '/trash';
      } else if (route.folderId) {
        pathname += `/folder/${encodeURIComponent(route.folderId)}`;
      }
    } else {
      pathname = '/';
    }
  }

  if (route.search?.trim()) params.set('q', route.search.trim());
  if (route.previewFileId) params.set('preview', route.previewFileId);
  if (route.galleryFileId) params.set('gallery', route.galleryFileId);
  if (route.shareFileId) params.set('share', route.shareFileId);
  if (route.infoFileId) params.set('info', route.infoFileId);
  if (route.modal) params.set('modal', route.modal);

  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
