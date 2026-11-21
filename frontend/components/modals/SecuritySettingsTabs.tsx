import React, { useState, useEffect, useCallback } from 'react';
import { Shield, Key, Share2, Trash2, Copy, Check, RefreshCw, Plus, Monitor, Lock } from 'lucide-react';

export interface SecuritySettingsTabsProps {
  activeTab: 'sessions' | 'tokens' | 'shares';
  accounts: any[];
  getAuthHeaders: () => Record<string, string>;
  onToast: (msg: string, type?: 'success' | 'error') => void;
}

const ALL_SCOPES = ['read', 'write', 'delete', 'share'] as const;

export default function SecuritySettingsTabs({
  activeTab,
  accounts,
  getAuthHeaders,
  onToast,
}: SecuritySettingsTabsProps) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [tokens, setTokens] = useState<any[]>([]);
  const [shares, setShares] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const [patName, setPatName] = useState('');
  const [patScopes, setPatScopes] = useState<string[]>(['read', 'write']);
  const [patAccountId, setPatAccountId] = useState('');
  const [patRootFolderId, setPatRootFolderId] = useState('');
  const [patExpiresDays, setPatExpiresDays] = useState('90');
  const [creatingPat, setCreatingPat] = useState(false);
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (activeTab === 'sessions') {
        const res = await fetch('/api/sessions', { headers: getAuthHeaders() });
        if (res.ok) setSessions(await res.json());
      } else if (activeTab === 'tokens') {
        const res = await fetch('/api/tokens', { headers: getAuthHeaders() });
        if (res.ok) setTokens(await res.json());
      } else if (activeTab === 'shares') {
        const res = await fetch('/api/shares', { headers: getAuthHeaders() });
        if (res.ok) setShares(await res.json());
      }
    } catch {
      onToast('Failed to load security data', 'error');
    } finally {
      setLoading(false);
    }
  }, [activeTab, getAuthHeaders, onToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRevokeSession = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error('Failed to revoke session');
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      onToast('Device session revoked');
    } catch (err: any) {
      onToast(err.message || 'Revoke failed', 'error');
    }
  };

  const handleRevokeOtherSessions = async () => {
    try {
      const res = await fetch('/api/sessions', {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error('Failed to revoke other sessions');
      const data = await res.json();
      setSessions((prev) => prev.filter((s) => s.isCurrent));
      onToast(`Revoked ${data.revokedCount || 0} other session(s)`);
    } catch (err: any) {
      onToast(err.message || 'Revoke failed', 'error');
    }
  };

  const toggleScope = (scope: string) => {
    setPatScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const handleCreatePat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (patScopes.length === 0) {
      onToast('Select at least one scope', 'error');
      return;
    }
    setCreatingPat(true);
    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: patName.trim() || 'API Access Token',
          scopes: patScopes,
          accountId: patAccountId || null,
          rootFolderId: patRootFolderId.trim() || null,
          expiresInDays: Number(patExpiresDays) || 90,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create token');
      setNewlyCreatedToken(data.token);
      setPatName('');
      setPatRootFolderId('');
      await navigator.clipboard.writeText(data.token).catch(() => {});
      onToast('Personal Access Token created and copied');
      loadData();
    } catch (err: any) {
      onToast(err.message || 'Token creation failed', 'error');
    } finally {
      setCreatingPat(false);
    }
  };

  const handleRevokePat = async (tokenId: string) => {
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(tokenId)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error('Failed to revoke token');
      setTokens((prev) => prev.filter((t) => t.tokenId !== tokenId));
      onToast('Access token revoked');
    } catch (err: any) {
      onToast(err.message || 'Revoke failed', 'error');
    }
  };

  const handleRevokeShare = async (shareId: string) => {
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(shareId)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error('Failed to revoke share link');
      setShares((prev) => prev.filter((s) => s.shareId !== shareId));
      onToast('Share link revoked');
    } catch (err: any) {
      onToast(err.message || 'Revoke failed', 'error');
    }
  };

  const copyValue = async (id: string, val: string) => {
    await navigator.clipboard.writeText(val).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    onToast('Copied to clipboard');
  };

  if (activeTab === 'sessions') {
    const otherCount = sessions.filter((s) => !s.isCurrent).length;
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Shield size={18} className="text-blue-600 dark:text-blue-400" />
              <span>Active Device Sessions</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Sliding 30-day sessions with tracked IP history and instant revocation
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {otherCount > 0 && (
              <button
                type="button"
                onClick={handleRevokeOtherSessions}
                className="px-4 h-9 rounded-full bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 text-red-600 dark:text-red-400 text-xs font-semibold hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors whitespace-nowrap"
              >
                Revoke Others ({otherCount})
              </button>
            )}
            <button
              type="button"
              onClick={loadData}
              className="w-9 h-9 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center transition-colors"
              title="Refresh Sessions"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {loading && sessions.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-400">Loading active sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-400 bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800">
            No active sessions found.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-3xl overflow-hidden bg-white dark:bg-slate-900">
            {sessions.map((s) => (
              <div key={s.sessionId} className="p-4 sm:p-5 flex items-start justify-between gap-4">
                <div className="flex items-start gap-3.5 min-w-0">
                  <div className="w-10 h-10 rounded-2xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0 mt-0.5">
                    <Monitor size={18} />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                      <span className="truncate">{s.deviceName || 'Cloudyte Client'}</span>
                      {s.isCurrent && (
                        <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 whitespace-nowrap">
                          · Current Device
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      {s.userAgent || 'Unknown browser'}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums font-mono">
                      <span>IP: {s.ip || 'unknown'}</span>
                      {Array.isArray(s.ipHistory) && s.ipHistory.length > 1 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{s.ipHistory.length} recent IPs</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>Active {new Date(s.lastActiveAt).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
                {!s.isCurrent && (
                  <button
                    type="button"
                    onClick={() => handleRevokeSession(s.sessionId)}
                    className="px-4 h-9 rounded-full border border-slate-200 dark:border-slate-700 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0 whitespace-nowrap"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (activeTab === 'tokens') {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Key size={18} className="text-blue-600 dark:text-blue-400" />
            <span>Personal Access Tokens</span>
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Issue scoped tokens for scripts or external tools, confined to an optional drive or folder
          </p>
        </div>

        <form onSubmit={handleCreatePat} className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Token name (e.g. Backup CLI)"
              value={patName}
              onChange={(e) => setPatName(e.target.value)}
              className="h-10 px-4 rounded-2xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-100 outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-blue-600 focus:ring-4 focus:ring-blue-500/15"
            />
            <select
              value={patExpiresDays}
              onChange={(e) => setPatExpiresDays(e.target.value)}
              className="h-10 px-4 rounded-2xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-100 outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-blue-600 focus:ring-4 focus:ring-blue-500/15"
            >
              <option value="7">Expires in 7 days</option>
              <option value="30">Expires in 30 days</option>
              <option value="90">Expires in 90 days</option>
              <option value="365">Expires in 1 year</option>
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              value={patAccountId}
              onChange={(e) => setPatAccountId(e.target.value)}
              className="h-10 px-4 rounded-2xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-100 outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-blue-600 focus:ring-4 focus:ring-blue-500/15"
            >
              <option value="">All linked drives (no account limit)</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  Confine to: {acc.name || acc.email || acc.accountType}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Optional root folder confinement (e.g. backups)"
              value={patRootFolderId}
              onChange={(e) => setPatRootFolderId(e.target.value)}
              className="h-10 px-4 rounded-2xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-100 outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-blue-600 focus:ring-4 focus:ring-blue-500/15"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Scopes:</span>
              {ALL_SCOPES.map((sc) => (
                <label key={sc} className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={patScopes.includes(sc)}
                    onChange={() => toggleScope(sc)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span>{sc}</span>
                </label>
              ))}
            </div>
            <button
              type="submit"
              disabled={creatingPat}
              className="px-5 h-9 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50 transition-all active:scale-[0.97]"
            >
              <Plus size={14} />
              <span>{creatingPat ? 'Creating...' : 'Create Token'}</span>
            </button>
          </div>
        </form>

        {newlyCreatedToken && (
          <div className="p-4 rounded-3xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 space-y-2">
            <p className="text-xs font-bold text-emerald-800 dark:text-emerald-200">New Token Ready</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-white dark:bg-slate-900 px-3.5 py-2 rounded-2xl border border-emerald-200 dark:border-emerald-800 text-slate-800 dark:text-slate-100 truncate">
                {newlyCreatedToken}
              </code>
              <button
                type="button"
                onClick={() => copyValue('new_pat', newlyCreatedToken)}
                className="px-4 h-9 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-colors"
              >
                {copiedId === 'new_pat' ? <Check size={14} /> : <Copy size={14} />}
                <span>Copy</span>
              </button>
            </div>
          </div>
        )}

        <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-3xl overflow-hidden bg-white dark:bg-slate-900">
          {tokens.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              {loading ? 'Loading tokens...' : 'No active Personal Access Tokens yet.'}
            </div>
          ) : (
            tokens.map((t) => (
              <div key={t.tokenId} className="p-4 sm:p-5 flex items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                    <span className="truncate">{t.name}</span>
                    <span className="text-xs font-mono font-normal text-slate-400">· {(t.scopes || []).join(', ')}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                    {t.accountId && <span>Account: {t.accountId.slice(-6)}</span>}
                    {t.rootFolderId && (
                      <>
                        {t.accountId && <span aria-hidden="true">·</span>}
                        <span>Folder: /{t.rootFolderId}</span>
                      </>
                    )}
                    {(t.accountId || t.rootFolderId) && <span aria-hidden="true">·</span>}
                    <span>Expires {t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'Never'}</span>
                    {t.lastUsedAt && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Last used {new Date(t.lastUsedAt).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {t.token && (
                    <button
                      type="button"
                      onClick={() => copyValue(t.tokenId, t.token)}
                      className="w-9 h-9 rounded-full border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center justify-center transition-colors"
                      title="Copy Token"
                    >
                      {copiedId === t.tokenId ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRevokePat(t.tokenId)}
                    className="w-9 h-9 rounded-full border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center justify-center transition-colors"
                    title="Revoke Token"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Share2 size={18} className="text-blue-600 dark:text-blue-400" />
            <span>Active Public Share Links</span>
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Monitor download limits, PIN protection, and immediately revoke any shared link
          </p>
        </div>
        <button
          type="button"
          onClick={loadData}
          className="w-9 h-9 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center transition-colors shrink-0"
          title="Refresh Shares"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-3xl overflow-hidden bg-white dark:bg-slate-900">
        {shares.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-400">
            {loading ? 'Loading active share links...' : 'No active public shares created yet.'}
          </div>
        ) : (
          shares.map((s) => {
            const shareUrl = `${window.location.origin}/s/${s.shareId}`;
            return (
              <div key={s.shareId} className="p-4 sm:p-5 flex items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                    <span className="font-mono">/s/{s.shareId}</span>
                    {s.hasPin && (
                      <span className="text-xs font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                        <Lock size={12} /> PIN
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                    <span>
                      Downloads: {s.downloadCount ?? 0}
                      {s.maxDownloads ? ` / ${s.maxDownloads}` : ''}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{s.expiresAt ? `Expires ${new Date(s.expiresAt).toLocaleString()}` : 'No expiry'}</span>
                    <span aria-hidden="true">·</span>
                    <span>{s.allowDownload ? 'Downloads enabled' : 'Preview only'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => copyValue(s.shareId, shareUrl)}
                    className="w-9 h-9 rounded-full border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center justify-center transition-colors"
                    title="Copy Share Link"
                  >
                    {copiedId === s.shareId ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRevokeShare(s.shareId)}
                    className="px-4 h-9 rounded-full border border-slate-200 dark:border-slate-700 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors whitespace-nowrap"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
