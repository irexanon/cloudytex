import React, { useState, useEffect, useCallback } from 'react';
import { Shield, Key, Share2, Trash2, Copy, Check, RefreshCw, Plus, Monitor, Lock, BookOpen, ChevronDown, ChevronUp, Terminal } from 'lucide-react';

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
  const [showAiGuide, setShowAiGuide] = useState<boolean>(true);
  const [showCliGuide, setShowCliGuide] = useState<boolean>(false);

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

  const originUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const mcpUrl = `${originUrl}/mcp`;
  const openApiUrl = `${originUrl}/api/openapi.json`;

  const buildAiPromptText = (t: { token: string; name?: string; scopes?: string[]; accountId?: string | null; rootFolderId?: string | null }) => {
    const scopeList = Array.isArray(t.scopes) && t.scopes.length > 0 ? t.scopes.join(', ') : 'read, write';
    const matchedAcc = t.accountId ? accounts.find((a) => a.id === t.accountId) : null;
    const driveScopeText = t.accountId
      ? `${matchedAcc?.name || t.accountId} (accountId: ${t.accountId})`
      : 'All connected drives (call GET /api/accounts or list_drives first)';
    const folderScopeText = t.rootFolderId ? `/${t.rootFolderId}` : 'Any folder';

    return [
      `You have access to my Cloudyte cloud storage.`,
      ``,
      `Connection Details:`,
      `- Base URL: ${originUrl}`,
      `- MCP Server URL (Streamable HTTP): ${mcpUrl}`,
      `- OpenAPI Schema URL: ${openApiUrl}`,
      `- Auth Header: Authorization: Bearer ${t.token}`,
      `- Allowed Scopes: ${scopeList}`,
      `- Drive Access: ${driveScopeText}`,
      `- Root Folder Lock: ${folderScopeText}`,
      ``,
      `Key Endpoints (if not using MCP directly):`,
      `- List drives: GET ${originUrl}/api/accounts`,
      `- List/search files: GET ${originUrl}/api/files?accountId=<id>&folderId=root&search=<query>`,
      `- Create folder: POST ${originUrl}/api/folders?accountId=<id>  { "name": "...", "parentId": "root" }`,
      `- Move file: POST ${originUrl}/api/files/move  { "sourceAccountId": "...", "fileId": "...", "targetAccountId": "...", "targetFolderId": "..." }`,
      `- Batch move (up to 50): POST ${originUrl}/api/ai/files/batch-move  { "sourceAccountId": "...", "fileIds": [...], "targetAccountId": "...", "targetFolderId": "..." }`,
      `- Upload text/markdown/json file: POST ${originUrl}/api/ai/upload-text/<accountId>  { "fileName": "...", "content": "...", "folderId": "..." }`,
      `- Upload from public URL: POST ${originUrl}/api/ai/upload-from-url/<accountId>  { "url": "https://...", "fileName": "...", "folderId": "..." }`,
      `- Share link: POST ${originUrl}/api/share  { "accountId": "...", "fileId": "..." }`,
      ``,
      `Terminal CLI (for Claude Code / Gemini CLI / Codex / Bash Agents):`,
      `- Install CLI: curl -fsSL "${originUrl}/api/cli/download" -o cloudyte.mjs`,
      `- Configure: node cloudyte.mjs login --url "${originUrl}" --token "${t.token}"`,
      `- Commands: drives | ls <accountId> [folderId] | mkdir <accountId> <name> | upload <accountId> <file> [--folder <id>] | download <accountId> <fileId> [outPath] | share <accountId> <fileId>`,
      `- Temp Drop (no auth): node cloudyte.mjs temp create|ls|upload|download`,
      ``,
      `Always verify file IDs and folder IDs with list_files or \`node cloudyte.mjs ls\` before moving or renaming.`,
    ].join('\n');
  };

  const buildCliAiPromptText = (tokenValue = '<YOUR_TOKEN>') =>
    [
      `You are working in a terminal with access to my Cloudyte cloud storage via the official zero-dependency Node.js CLI.`,
      ``,
      `Setup (run once if cloudyte.mjs is not already in the current directory):`,
      `curl -fsSL "${originUrl}/api/cli/download" -o cloudyte.mjs`,
      `export CLOUDYTE_URL="${originUrl}"`,
      `export CLOUDYTE_TOKEN="${tokenValue}"`,
      `# Or save permanently to ~/.cloudyte.json:`,
      `# node cloudyte.mjs login --url "${originUrl}" --token "${tokenValue}"`,
      ``,
      `Available Commands:`,
      `- List connected drives & account IDs: node cloudyte.mjs drives`,
      `- List files in folder: node cloudyte.mjs ls <accountId> [folderId] [--search <query>]`,
      `- Create folder: node cloudyte.mjs mkdir <accountId> "<name>" [parentId]`,
      `- Upload file (auto-chunks >8MB): node cloudyte.mjs upload <accountId> <localFilePath> [--folder <folderId>]`,
      `- Download file: node cloudyte.mjs download <accountId> <fileId> [outPath]`,
      `- Create share link: node cloudyte.mjs share <accountId> <fileId>`,
      `- Public Temp Drop (no auth): node cloudyte.mjs temp create | ls <roomCode> | upload <roomCode> <file> | download <roomCode> <fileId|all>`,
      ``,
      `Rules:`,
      `- Run \`node cloudyte.mjs drives\` first to discover valid accountIds.`,
      `- Always verify destination folder IDs with \`node cloudyte.mjs ls\` before uploading.`,
      `- Keep CLOUDYTE_TOKEN secret and never commit it to git.`,
    ].join('\n');

  const buildMcpJson = (tokenValue: string) =>
    JSON.stringify(
      {
        mcpServers: {
          cloudyte: {
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${tokenValue}`,
            },
          },
        },
      },
      null,
      2
    );

  if (activeTab === 'tokens') {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-base font-bold text-[var(--tx)] flex items-center gap-2">
            <Key size={18} className="text-[var(--primary)]" />
            <span>AI Assistant &amp; API Access</span>
          </h3>
          <p className="text-xs text-[var(--sub)] mt-0.5">
            Connect any AI assistant (ChatGPT, Claude, Cursor, custom agents) using MCP or OpenAPI with a scoped token
          </p>
        </div>

        {/* Ready-to-Use AI Connector Endpoints */}
        <div className="p-4 sm:p-5 rounded-3xl bg-[var(--sf)] border border-[var(--bd)] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold text-[var(--tx)]">AI Connector Endpoints</p>
              <p className="text-[11px] text-[var(--sub)]">
                Give your AI either link below along with a Bearer token created here.
              </p>
            </div>
            <span className="px-2.5 py-1 rounded-full bg-[var(--pi)] text-[var(--pit)] text-[10px] font-bold uppercase tracking-wider">
              MCP + OpenAPI Ready
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--sub)]">MCP Server URL (Claude / Cursor / Agents)</p>
                <p className="text-xs font-mono text-[var(--tx)] truncate mt-0.5">{mcpUrl}</p>
              </div>
              <button
                type="button"
                onClick={() => copyValue('mcp_url', mcpUrl)}
                className="px-3 h-8 rounded-xl bg-[var(--pi)] text-[var(--pit)] text-[11px] font-bold flex items-center gap-1 shrink-0 hover:opacity-90 transition-opacity"
              >
                {copiedId === 'mcp_url' ? <Check size={13} /> : <Copy size={13} />}
                <span>Copy</span>
              </button>
            </div>

            <div className="p-3 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--sub)]">OpenAPI Spec URL (ChatGPT Actions / n8n)</p>
                <p className="text-xs font-mono text-[var(--tx)] truncate mt-0.5">{openApiUrl}</p>
              </div>
              <button
                type="button"
                onClick={() => copyValue('openapi_url', openApiUrl)}
                className="px-3 h-8 rounded-xl bg-[var(--pi)] text-[var(--pit)] text-[11px] font-bold flex items-center gap-1 shrink-0 hover:opacity-90 transition-opacity"
              >
                {copiedId === 'openapi_url' ? <Check size={13} /> : <Copy size={13} />}
                <span>Copy</span>
              </button>
            </div>
          </div>

          {/* Step-by-Step User Guide */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowAiGuide((prev) => !prev)}
              className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-left hover:border-[var(--primary)]/50 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <BookOpen size={14} className="text-[var(--primary)] shrink-0" />
                <span className="text-xs font-bold text-[var(--tx)]">How to Connect Your AI (Quick Guide)</span>
              </div>
              {showAiGuide ? (
                <ChevronUp size={15} className="text-[var(--sub)] shrink-0" />
              ) : (
                <ChevronDown size={15} className="text-[var(--sub)] shrink-0" />
              )}
            </button>

            {showAiGuide && (
              <div className="mt-2.5 p-4 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] space-y-3.5 text-xs">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="p-3 rounded-xl bg-[var(--sf)] border border-[var(--bd)] space-y-1">
                    <p className="font-bold text-[var(--tx)]">1. Create a Safe Token</p>
                    <p className="text-[11px] text-[var(--sub)] leading-relaxed">
                      Click <span className="font-semibold text-[var(--tx)]">Preset: AI Organizer (No Delete)</span> below. Optionally lock the token to a single Drive or Root Folder, then create it.
                    </p>
                  </div>

                  <div className="p-3 rounded-xl bg-[var(--sf)] border border-[var(--bd)] space-y-1">
                    <p className="font-bold text-[var(--tx)]">2. Connect to Your AI</p>
                    <p className="text-[11px] text-[var(--sub)] leading-relaxed">
                      <span className="font-semibold text-[var(--tx)]">Claude / Cursor / Agents:</span> Click <span className="font-semibold text-[var(--tx)]">MCP JSON</span>.<br />
                      <span className="font-semibold text-[var(--tx)]">ChatGPT Actions:</span> Import the OpenAPI URL + Bearer token.<br />
                      <span className="font-semibold text-[var(--tx)]">Any AI Chat:</span> Click <span className="font-semibold text-[var(--tx)]">AI Prompt</span> and paste.
                    </p>
                  </div>

                  <div className="p-3 rounded-xl bg-[var(--sf)] border border-[var(--bd)] space-y-1">
                    <p className="font-bold text-[var(--tx)]">3. Ask AI to Manage Files</p>
                    <p className="text-[11px] text-[var(--sub)] leading-relaxed">
                      &ldquo;List my drives, create a folder named Invoices, move all PDFs into it, or upload this URL to my TG Drive.&rdquo;
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--sub)] pt-1 border-t border-[var(--bd)]">
                  <span><strong className="text-[var(--tx)]">read:</strong> list &amp; search files</span>
                  <span><strong className="text-[var(--tx)]">write:</strong> upload, create folder, move, copy, rename</span>
                  <span><strong className="text-[var(--tx)]">share:</strong> create share links</span>
                  <span><strong className="text-[var(--tx)]">delete:</strong> move files to Trash (off by default in AI preset)</span>
                </div>
              </div>
            )}
          </div>

          {/* Terminal / CLI Upload & Download Guide */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowCliGuide((prev) => !prev)}
              className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-left hover:border-[var(--primary)]/50 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Terminal size={14} className="text-[var(--primary)] shrink-0" />
                <span className="text-xs font-bold text-[var(--tx)]">Terminal &amp; CLI Upload / Download (Node CLI + curl)</span>
              </div>
              {showCliGuide ? (
                <ChevronUp size={15} className="text-[var(--sub)] shrink-0" />
              ) : (
                <ChevronDown size={15} className="text-[var(--sub)] shrink-0" />
              )}
            </button>

            {showCliGuide && (
              <div className="mt-2.5 p-4 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-[var(--sf)] border border-[var(--bd)]">
                  <div>
                    <p className="font-bold text-[var(--tx)]">AI Terminal Prompt (Claude Code / Gemini CLI / Codex / Cursor)</p>
                    <p className="text-[11px] text-[var(--sub)]">Paste this prompt into any terminal AI agent so it can upload &amp; download via CLI automatically.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyValue('cli_ai_prompt_guide', buildCliAiPromptText(newlyCreatedToken || '<YOUR_TOKEN>'))}
                    className="px-3 h-8 rounded-xl bg-[var(--pi)] text-[var(--pit)] text-[11px] font-bold inline-flex items-center gap-1.5 shrink-0 hover:opacity-90 transition-opacity"
                  >
                    {copiedId === 'cli_ai_prompt_guide' ? <Check size={12} /> : <Copy size={12} />}
                    <span>Copy CLI AI Prompt</span>
                  </button>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-[var(--tx)]">1. Download standalone CLI (requires Node 18+)</span>
                    <button
                      type="button"
                      onClick={() =>
                        copyValue('cli_dl', `curl -fsSL "${originUrl}/api/cli/download" -o cloudyte.mjs && chmod +x cloudyte.mjs`)
                      }
                      className="text-[11px] font-semibold text-[var(--primary)] hover:underline inline-flex items-center gap-1"
                    >
                      {copiedId === 'cli_dl' ? <Check size={12} /> : <Copy size={12} />}
                      <span>Copy</span>
                    </button>
                  </div>
                  <pre className="p-2.5 rounded-xl bg-[var(--sf)] border border-[var(--bd)] font-mono text-[11px] text-[var(--tx)] overflow-x-auto">{`curl -fsSL "${originUrl}/api/cli/download" -o cloudyte.mjs && chmod +x cloudyte.mjs`}</pre>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-[var(--tx)]">2. Login once with a token &amp; run Drive commands</span>
                    <button
                      type="button"
                      onClick={() =>
                        copyValue(
                          'cli_cmds',
                          [
                            `node cloudyte.mjs login --url "${originUrl}" --token "<YOUR_TOKEN>"`,
                            `node cloudyte.mjs drives`,
                            `node cloudyte.mjs ls <accountId>`,
                            `node cloudyte.mjs upload <accountId> ./file.zip`,
                            `node cloudyte.mjs download <accountId> <fileId>`,
                          ].join('\n')
                        )
                      }
                      className="text-[11px] font-semibold text-[var(--primary)] hover:underline inline-flex items-center gap-1"
                    >
                      {copiedId === 'cli_cmds' ? <Check size={12} /> : <Copy size={12} />}
                      <span>Copy</span>
                    </button>
                  </div>
                  <pre className="p-2.5 rounded-xl bg-[var(--sf)] border border-[var(--bd)] font-mono text-[11px] text-[var(--tx)] overflow-x-auto">{`node cloudyte.mjs login --url "${originUrl}" --token "<YOUR_TOKEN>"
node cloudyte.mjs drives
node cloudyte.mjs ls <accountId>
node cloudyte.mjs upload <accountId> ./file.zip --folder root
node cloudyte.mjs download <accountId> <fileId>`}</pre>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-[var(--tx)]">Or raw curl (no Node needed)</span>
                    <button
                      type="button"
                      onClick={() =>
                        copyValue(
                          'cli_curl',
                          [
                            `curl -H "Authorization: Bearer <TOKEN>" -F "file=@./file.zip" "${originUrl}/api/upload/<accountId>?folderId=root"`,
                            `curl -L -H "Authorization: Bearer <TOKEN>" -O -J "${originUrl}/api/download/<accountId>/<fileId>"`,
                          ].join('\n')
                        )
                      }
                      className="text-[11px] font-semibold text-[var(--primary)] hover:underline inline-flex items-center gap-1"
                    >
                      {copiedId === 'cli_curl' ? <Check size={12} /> : <Copy size={12} />}
                      <span>Copy</span>
                    </button>
                  </div>
                  <pre className="p-2.5 rounded-xl bg-[var(--sf)] border border-[var(--bd)] font-mono text-[11px] text-[var(--tx)] overflow-x-auto">{`curl -H "Authorization: Bearer <TOKEN>" -F "file=@./file.zip" "${originUrl}/api/upload/<accountId>?folderId=root"
curl -L -H "Authorization: Bearer <TOKEN>" -O -J "${originUrl}/api/download/<accountId>/<fileId>"`}</pre>
                </div>
              </div>
            )}
          </div>
        </div>

        <form onSubmit={handleCreatePat} className="p-5 rounded-3xl bg-[var(--sf)] border border-[var(--bd)] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-[var(--tx)]">Create Scoped Token</span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setPatName('AI Organizer (Safe)');
                  setPatScopes(['read', 'write']);
                }}
                className="px-3 py-1 rounded-xl bg-[var(--pi)] text-[var(--pit)] text-[11px] font-bold hover:opacity-90 transition-opacity"
              >
                Preset: AI Organizer (No Delete)
              </button>
              <button
                type="button"
                onClick={() => {
                  setPatName('AI Reader');
                  setPatScopes(['read']);
                }}
                className="px-3 py-1 rounded-xl bg-[var(--bg)] border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)] text-[11px] font-semibold transition-colors"
              >
                Preset: Read-Only
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Token name (e.g. ChatGPT Organizer)"
              value={patName}
              onChange={(e) => setPatName(e.target.value)}
              className="h-10 px-4 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-xs font-semibold text-[var(--tx)] outline-none focus:border-[var(--primary)]"
            />
            <select
              value={patExpiresDays}
              onChange={(e) => setPatExpiresDays(e.target.value)}
              className="h-10 px-4 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-xs font-semibold text-[var(--tx)] outline-none focus:border-[var(--primary)]"
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
              className="h-10 px-4 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-xs font-semibold text-[var(--tx)] outline-none focus:border-[var(--primary)]"
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
              placeholder="Optional root folder lock (e.g. Inbox)"
              value={patRootFolderId}
              onChange={(e) => setPatRootFolderId(e.target.value)}
              className="h-10 px-4 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-xs font-semibold text-[var(--tx)] outline-none focus:border-[var(--primary)]"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold text-[var(--sub)]">Scopes:</span>
              {ALL_SCOPES.map((sc) => (
                <label key={sc} className="flex items-center gap-1.5 text-xs font-medium text-[var(--tx)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={patScopes.includes(sc)}
                    onChange={() => toggleScope(sc)}
                    className="w-4 h-4 rounded border-[var(--bd)] accent-[var(--primary)]"
                  />
                  <span>{sc}</span>
                </label>
              ))}
            </div>
            <button
              type="submit"
              disabled={creatingPat}
              className="px-5 h-9 rounded-full bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50 transition-all active:scale-[0.97]"
            >
              <Plus size={14} />
              <span>{creatingPat ? 'Creating...' : 'Create AI Token'}</span>
            </button>
          </div>
        </form>

        {newlyCreatedToken && (
          <div className="p-4 rounded-3xl bg-emerald-500/10 border border-emerald-500/30 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-bold text-emerald-500">New Token Ready — Paste Setup Into Your AI</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    copyValue(
                      'new_pat_prompt',
                      buildAiPromptText({
                        token: newlyCreatedToken,
                        scopes: patScopes,
                        accountId: patAccountId || null,
                        rootFolderId: patRootFolderId.trim() || null,
                      })
                    )
                  }
                  className="px-3.5 h-8 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold flex items-center gap-1.5 transition-colors"
                >
                  {copiedId === 'new_pat_prompt' ? <Check size={13} /> : <Copy size={13} />}
                  <span>Copy AI Prompt</span>
                </button>
                <button
                  type="button"
                  onClick={() => copyValue('new_pat_mcp', buildMcpJson(newlyCreatedToken))}
                  className="px-3.5 h-8 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-[var(--tx)] hover:border-[var(--primary)] text-[11px] font-bold flex items-center gap-1.5 transition-colors"
                >
                  {copiedId === 'new_pat_mcp' ? <Check size={13} /> : <Copy size={13} />}
                  <span>Copy MCP JSON</span>
                </button>
                <button
                  type="button"
                  onClick={() => copyValue('new_pat_cli_prompt', buildCliAiPromptText(newlyCreatedToken))}
                  className="px-3.5 h-8 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-[var(--tx)] hover:border-[var(--primary)] text-[11px] font-bold flex items-center gap-1.5 transition-colors"
                >
                  {copiedId === 'new_pat_cli_prompt' ? <Check size={13} /> : <Copy size={13} />}
                  <span>CLI AI Prompt</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    copyValue(
                      'new_pat_cli',
                      `node cloudyte.mjs login --url "${originUrl}" --token "${newlyCreatedToken}"`
                    )
                  }
                  className="px-3.5 h-8 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-[var(--tx)] hover:border-[var(--primary)] text-[11px] font-bold flex items-center gap-1.5 transition-colors"
                >
                  {copiedId === 'new_pat_cli' ? <Check size={13} /> : <Copy size={13} />}
                  <span>CLI Login</span>
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-[var(--sf)] px-3.5 py-2 rounded-2xl border border-[var(--bd)] text-[var(--tx)] truncate">
                {newlyCreatedToken}
              </code>
              <button
                type="button"
                onClick={() => copyValue('new_pat', newlyCreatedToken)}
                className="px-4 h-9 rounded-full bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-colors"
              >
                {copiedId === 'new_pat' ? <Check size={14} /> : <Copy size={14} />}
                <span>Copy Token</span>
              </button>
            </div>
          </div>
        )}

        <div className="divide-y divide-[var(--bd)] border border-[var(--bd)] rounded-3xl overflow-hidden bg-[var(--sf)]">
          {tokens.length === 0 ? (
            <div className="py-10 text-center text-xs text-[var(--sub)]">
              {loading ? 'Loading tokens...' : 'No active Personal Access Tokens yet.'}
            </div>
          ) : (
            tokens.map((t) => (
              <div key={t.tokenId} className="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[var(--tx)]">
                    <span className="truncate">{t.name}</span>
                    <span className="text-xs font-mono font-normal text-[var(--sub)]">· {(t.scopes || []).join(', ')}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--sub)] tabular-nums">
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
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {t.token && (
                    <>
                      <button
                        type="button"
                        onClick={() => copyValue(`prompt_${t.tokenId}`, buildAiPromptText(t))}
                        className="px-3 h-8 rounded-full bg-[var(--pi)] text-[var(--pit)] text-[11px] font-bold flex items-center gap-1 hover:opacity-90 transition-opacity"
                        title="Copy ready-to-paste AI setup prompt with URL, endpoints, and token"
                      >
                        {copiedId === `prompt_${t.tokenId}` ? <Check size={12} /> : <Copy size={12} />}
                        <span>AI Prompt</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => copyValue(`cli_prompt_${t.tokenId}`, buildCliAiPromptText(t.token))}
                        className="px-3 h-8 rounded-full border border-[var(--bd)] text-[var(--tx)] hover:border-[var(--primary)] text-[11px] font-semibold flex items-center gap-1 transition-colors"
                        title="Copy Terminal AI Agent prompt for Claude Code, Gemini CLI, Codex, or Cursor"
                      >
                        {copiedId === `cli_prompt_${t.tokenId}` ? <Check size={12} /> : <Copy size={12} />}
                        <span>CLI AI Prompt</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => copyValue(`mcp_${t.tokenId}`, buildMcpJson(t.token))}
                        className="px-3 h-8 rounded-full border border-[var(--bd)] text-[var(--tx)] hover:border-[var(--primary)] text-[11px] font-semibold flex items-center gap-1 transition-colors"
                        title="Copy MCP Server JSON config"
                      >
                        {copiedId === `mcp_${t.tokenId}` ? <Check size={12} /> : <Copy size={12} />}
                        <span>MCP JSON</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => copyValue(t.tokenId, t.token)}
                        className="w-8 h-8 rounded-full border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--primary)] flex items-center justify-center transition-colors"
                        title="Copy Raw Token"
                      >
                        {copiedId === t.tokenId ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRevokePat(t.tokenId)}
                    className="w-8 h-8 rounded-full border border-[var(--bd)] text-[var(--sub)] hover:text-rose-500 hover:border-rose-500/40 flex items-center justify-center transition-colors"
                    title="Revoke Token"
                  >
                    <Trash2 size={13} />
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
