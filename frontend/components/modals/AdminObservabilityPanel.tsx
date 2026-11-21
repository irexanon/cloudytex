import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';

export interface AdminObservabilityPanelProps {
  mode: 'metrics' | 'audit';
  getAuthHeaders: () => Record<string, string>;
}

function fmtBytes(n: number | null | undefined): string {
  const val = Number(n || 0);
  if (!val) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(val) / Math.log(1024)));
  return `${(val / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function AdminObservabilityPanel({
  mode,
  getAuthHeaders,
}: AdminObservabilityPanelProps) {
  const [metrics, setMetrics] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (mode === 'metrics') {
        const res = await fetch('/api/admin/metrics', { headers: getAuthHeaders() });
        if (res.ok) setMetrics(await res.json());
      } else {
        const params = new URLSearchParams({ limit: '100' });
        if (actionFilter.trim()) params.set('action', actionFilter.trim());
        const res = await fetch(`/api/admin/audit-logs?${params.toString()}`, { headers: getAuthHeaders() });
        if (res.ok) {
          const data = await res.json();
          setLogs(Array.isArray(data.logs) ? data.logs : []);
        }
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [mode, actionFilter, getAuthHeaders]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (mode === 'metrics') {
    if (!metrics) {
      return (
        <div className="py-16 text-center text-sm text-slate-400">
          {loading ? 'Loading system telemetry...' : 'Telemetry unavailable.'}
        </div>
      );
    }
    const driveHits = Number(metrics.cache?.driveCacheHits || 0);
    const driveMisses = Number(metrics.cache?.driveCacheMisses || 0);
    const hitRate = driveHits + driveMisses > 0 ? Math.round((driveHits / (driveHits + driveMisses)) * 100) : 0;

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-white">System &amp; Provider Telemetry</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums font-mono mt-0.5">
              Uptime: {metrics.uptimeSeconds}s · Event loop lag: {Number(metrics.eventLoopLagMs || 0).toFixed(1)} ms · Open FDs: {metrics.openFileDescriptors ?? '-'}
            </p>
          </div>
          <button
            type="button"
            onClick={loadData}
            className="px-4 h-9 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 transition-colors shrink-0"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>

        {Array.isArray(metrics.alerts) && metrics.alerts.length > 0 && (
          <div className="space-y-2">
            {metrics.alerts.map((al: any, idx: number) => (
              <div
                key={idx}
                className="p-3.5 rounded-2xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 text-xs flex items-center gap-2.5"
              >
                <AlertTriangle size={15} className="shrink-0" />
                <span className="font-bold">{al.code}:</span>
                <span>{al.message}</span>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 tabular-nums">
          <div className="p-5 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Memory RSS / Heap</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1.5 font-mono">
              {fmtBytes(metrics.memoryUsage?.rssBytes)}
            </p>
            <p className="text-xs text-slate-400 mt-1 font-mono">Heap: {fmtBytes(metrics.memoryUsage?.heapUsedBytes)}</p>
          </div>
          <div className="p-5 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Upload / Download Bytes</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1.5 font-mono">
              {fmtBytes(metrics.uploads?.uploadBytesTotal)}
            </p>
            <p className="text-xs text-slate-400 mt-1 font-mono">DL: {fmtBytes(metrics.uploads?.downloadBytesTotal)}</p>
          </div>
          <div className="p-5 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Cache Hit Rate</p>
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1.5 font-mono">{hitRate}%</p>
            <p className="text-xs text-slate-400 mt-1 font-mono">
              {driveHits} hits / {driveMisses} misses
            </p>
          </div>
          <div className="p-5 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Worker &amp; Queue</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1.5 font-mono">
              {metrics.jobs?.running || 0} run · {metrics.jobs?.queued || 0} q
            </p>
            <p className="text-xs text-slate-400 mt-1 font-mono">
              DLQ: {metrics.jobs?.deadLettered || 0} · OAuth fail: {metrics.oauthRefreshFailures || 0}
            </p>
          </div>
        </div>

        <div className="border border-slate-200 dark:border-slate-800 rounded-3xl overflow-hidden bg-white dark:bg-slate-900">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-5 py-3.5 font-semibold">Provider</th>
                <th className="px-5 py-3.5 font-semibold text-right">Calls</th>
                <th className="px-5 py-3.5 font-semibold text-right">Errors</th>
                <th className="px-5 py-3.5 font-semibold text-right">Avg Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {Object.entries(metrics.metrics?.providerCalls || {}).map(([name, bucket]: [string, any]) => {
                const calls = Number(bucket?.total || 0);
                const avgMs = calls > 0 ? Math.round(Number(bucket?.totalDurationMs || 0) / calls) : 0;
                return (
                  <tr key={name} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors">
                    <td className="px-5 py-3.5 font-semibold text-slate-800 dark:text-slate-200 capitalize">{name}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-slate-700 dark:text-slate-300">{calls}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-slate-700 dark:text-slate-300">{bucket?.errors || 0}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-slate-700 dark:text-slate-300">{avgMs} ms</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Security &amp; Operational Audit Logs</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            90-day retained event stream with credential redaction
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Filter action (e.g. login_failed)"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="h-9 px-4 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-500/15"
          />
          <button
            type="button"
            onClick={loadData}
            className="px-4 h-9 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>Reload</span>
          </button>
        </div>
      </div>

      <div className="border border-slate-200 dark:border-slate-800 rounded-3xl overflow-x-auto bg-white dark:bg-slate-900 scrollbar-thin">
        <table className="w-full text-left text-xs tabular-nums min-w-[640px]">
          <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800 sticky top-0">
            <tr>
              <th className="px-5 py-3.5 font-semibold">Timestamp</th>
              <th className="px-5 py-3.5 font-semibold">Action</th>
              <th className="px-5 py-3.5 font-semibold">User</th>
              <th className="px-5 py-3.5 font-semibold">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-5 py-12 text-center text-slate-400">
                  {loading ? 'Loading audit logs...' : 'No matching audit events found.'}
                </td>
              </tr>
            ) : (
              logs.map((log: any, idx: number) => {
                const { _id, action, userId, createdAt, timestamp, ...rest } = log;
                return (
                  <tr key={String(_id || idx)} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors">
                    <td className="px-5 py-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                      {new Date(createdAt || timestamp).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 font-mono font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                      {action}
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {userId || '-'}
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-slate-500 truncate max-w-sm">
                      {JSON.stringify(rest)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
