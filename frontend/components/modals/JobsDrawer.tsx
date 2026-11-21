import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, RefreshCw, RotateCcw, CheckCircle2, XCircle, ArrowLeftRight, ShieldCheck, ArchiveRestore, ArrowLeft } from 'lucide-react';

export interface JobsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  getAuthHeaders: () => Record<string, string>;
  onToast: (msg: string, type?: 'success' | 'error') => void;
  onJobsChanged?: () => void;
  variant?: 'page' | 'drawer';
}

function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes || 0);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function JobsDrawer({
  isOpen,
  onClose,
  getAuthHeaders,
  onToast,
  onJobsChanged,
  variant = 'drawer',
}: JobsDrawerProps) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const [jobsRes, healthRes] = await Promise.all([
        fetch('/api/jobs', { headers: getAuthHeaders() }),
        fetch('/api/jobs/health', { headers: getAuthHeaders() }),
      ]);
      if (jobsRes.ok) setJobs(await jobsRes.json());
      if (healthRes.ok) setHealth(await healthRes.json());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [getAuthHeaders]);

  useEffect(() => {
    if (!isOpen) return;
    loadJobs();
    const timer = setInterval(loadJobs, 4000);
    return () => clearInterval(timer);
  }, [isOpen, loadJobs]);

  const handleCancelJob = async (jobId: string) => {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error('Cancel failed');
      onToast('Transfer cancelled');
      loadJobs();
      onJobsChanged?.();
    } catch (err: any) {
      onToast(err.message || 'Cancel failed', 'error');
    }
  };

  const handleRetryJob = async (jobId: string) => {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error('Retry failed');
      onToast('Transfer re-queued');
      loadJobs();
    } catch (err: any) {
      onToast(err.message || 'Retry failed', 'error');
    }
  };

  const handleVerifyBackup = async (jobId: string) => {
    setVerifyingId(jobId);
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(jobId)}/verify`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      onToast(
        data.verified
          ? `Backup verified (${data.verifiedCount}/${data.totalItems} files intact)`
          : `Verified ${data.verifiedCount}/${data.totalItems}; ${data.failedVerifications?.length || 0} issue(s)`,
        data.verified ? 'success' : 'error'
      );
    } catch (err: any) {
      onToast(err.message || 'Verification failed', 'error');
    } finally {
      setVerifyingId(null);
    }
  };

  const handleRestoreBackup = async (jobId: string) => {
    setRestoringId(jobId);
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(jobId)}/restore`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ conflictStrategy: 'rename' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Restore enqueue failed');
      onToast('Conflict-safe restore transfer queued');
      loadJobs();
    } catch (err: any) {
      onToast(err.message || 'Restore failed', 'error');
    } finally {
      setRestoringId(null);
    }
  };

  const jobsListContent = (
    <>
      {health && (
        <div className="px-5 py-3.5 rounded-[20px] bg-[var(--sf)] border border-[var(--bd)] flex flex-wrap items-center justify-between gap-3 text-xs font-bold text-[var(--sub)] tabular-nums">
          <span>Workers: {health.activeWorkers}/{health.maxConcurrentWorkers}</span>
          <span>Queued: {health.totals?.queued || 0}</span>
          <span>Running: {health.totals?.running || 0}</span>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="py-20 text-center space-y-3 bg-[var(--sf)] border border-[var(--bd)] rounded-[24px]">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-[var(--pi)] text-[var(--pit)] flex items-center justify-center">
            <ArrowLeftRight size={24} />
          </div>
          <p className="text-base font-bold text-[var(--tx)]">No transfers yet</p>
          <p className="text-xs text-[var(--sub)] max-w-sm mx-auto">
            Cross-drive moves, copies, and batch backups appear here with live progress.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const pct = Number(job.progressPct ?? job.progress ?? 0);
            const isRunning = job.status === 'running' || job.status === 'queued';
            const isCompleted = job.status === 'completed' || job.status === 'completed_with_errors';
            const isFailed = job.status === 'failed' || job.status === 'cancelled';

            return (
              <div
                key={job.id || job.jobId}
                className="p-4 sm:p-5 rounded-[24px] border border-[var(--bd)] bg-[var(--sf)] space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-black text-[var(--tx)] uppercase tracking-wide">
                      {isCompleted && <CheckCircle2 size={15} className="text-emerald-500 shrink-0" />}
                      {isFailed && <XCircle size={15} className="text-red-500 shrink-0" />}
                      {isRunning && <RefreshCw size={15} className="text-blue-500 animate-spin shrink-0" />}
                      <span className="truncate">{String(job.type || 'transfer').replace(/_/g, ' ')}</span>
                    </div>
                    <p className="text-xs text-[var(--sub)] mt-1 tabular-nums">
                      {job.status} · {job.stage || 'queued'}
                      {job.totalBytes > 0 ? ` · ${formatBytes(job.bytesProcessed)} / ${formatBytes(job.totalBytes)}` : ''}
                      {job.retryCount > 0 ? ` · Retry #${job.retryCount}` : ''}
                    </p>
                  </div>
                  <span className="text-xs font-black text-blue-600 dark:text-blue-400 shrink-0 tabular-nums">{pct}%</span>
                </div>

                <div className="h-2 bg-[var(--tr)] rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      isFailed ? 'bg-red-500' : isCompleted ? 'bg-emerald-500' : 'bg-blue-600'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                  />
                </div>

                {job.error && (
                  <p className="text-xs text-red-500 font-medium break-words">{job.error}</p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] text-[var(--sub)]">
                    {job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}
                    {job.sourceDeleteApproved ? ' · Verified Move' : ''}
                  </span>
                  <div className="flex items-center gap-2">
                    {isRunning && (
                      <button
                        type="button"
                        onClick={() => handleCancelJob(job.id)}
                        className="px-3.5 py-1.5 rounded-xl bg-red-500/10 text-red-500 text-xs font-bold hover:bg-red-500/20 transition-colors"
                      >
                        Cancel
                      </button>
                    )}
                    {isFailed && (
                      <button
                        type="button"
                        onClick={() => handleRetryJob(job.id)}
                        className="px-3.5 py-1.5 rounded-xl bg-[var(--pi)] text-[var(--pit)] text-xs font-bold flex items-center gap-1.5 hover:opacity-90 transition-opacity"
                      >
                        <RotateCcw size={12} /> Retry
                      </button>
                    )}
                    {job.type === 'batch_backup' && isCompleted && (
                      <>
                        <button
                          type="button"
                          disabled={verifyingId === job.id}
                          onClick={() => handleVerifyBackup(job.id)}
                          className="px-3.5 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-500 text-xs font-bold flex items-center gap-1.5 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
                        >
                          <ShieldCheck size={12} /> {verifyingId === job.id ? 'Verifying...' : 'Verify'}
                        </button>
                        <button
                          type="button"
                          disabled={restoringId === job.id}
                          onClick={() => handleRestoreBackup(job.id)}
                          className="px-3.5 py-1.5 rounded-xl bg-indigo-500/15 text-indigo-400 text-xs font-bold flex items-center gap-1.5 hover:bg-indigo-500/25 disabled:opacity-50 transition-colors"
                        >
                          <ArchiveRestore size={12} /> {restoringId === job.id ? 'Restoring...' : 'Restore'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  if (variant === 'page') {
    if (!isOpen) return null;
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="w-10 h-10 rounded-[20px] bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)] flex items-center justify-center transition-colors shrink-0"
              title="Back to Drive"
              aria-label="Back to Drive"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="w-11 h-11 rounded-2xl bg-[var(--pi)] text-[var(--pit)] flex items-center justify-center shrink-0">
              <ArrowLeftRight size={20} />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-[var(--tx)] tracking-tight">Transfers</h1>
              <p className="text-xs sm:text-sm text-[var(--sub)] font-medium">
                Active transfers, batch backups &amp; recovery queue
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={loadJobs}
            className="h-10 px-4 rounded-[20px] bg-[var(--sf)] border border-[var(--bd)] text-xs font-bold text-[var(--tx)] hover:border-[var(--sub)]/40 flex items-center gap-2 transition-colors"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>

        <div className="space-y-4">{jobsListContent}</div>
      </div>
    );
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex justify-end">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 360 }}
            className="relative z-10 w-full max-w-lg bg-white dark:bg-[#0D1424] border-l border-slate-200 dark:border-[#1B253B] shadow-2xl flex flex-col h-full"
          >
            <div className="px-6 py-5 border-b border-slate-100 dark:border-[#182238] flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-[#162344] text-blue-600 dark:text-blue-400 flex items-center justify-center">
                  <ArrowLeftRight size={20} />
                </div>
                <div>
                  <h2 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Transfers</h2>
                  <p className="text-[11px] text-slate-500 font-medium">Active transfers, batch backups &amp; recovery queue</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={loadJobs}
                  className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-[#172136] text-slate-500"
                  title="Refresh"
                >
                  <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-[#172136] text-slate-400"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4 no-scrollbar">
              {jobsListContent}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
