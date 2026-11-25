import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, RefreshCw, RotateCcw, CheckCircle2, XCircle, ArrowLeftRight, ShieldCheck, ArchiveRestore, ArrowLeft } from 'lucide-react';

export interface JobsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  getAuthHeaders: () => Record<string, string>;
  onToast: (msg: string, type?: 'success' | 'error') => void;
  onJobsChanged?: () => void;
  initialJobs?: any[] | null;
  onJobsSynced?: (jobs: any[]) => void;
  variant?: 'page' | 'drawer';
}

function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes || 0);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatJobTypeLabel(rawType: string | undefined, isMove?: boolean): string {
  switch (rawType) {
    case 'drive_transfer':
      return isMove ? 'Drive move' : 'Drive copy';
    case 'cross_account_move':
    case 'cross_drive_move':
      return 'Cross-drive move';
    case 'cross_account_copy':
    case 'cross_drive_copy':
      return 'Cross-drive copy';
    case 'cross_account_transfer':
      return isMove ? 'Cross-drive move' : 'Cross-drive copy';
    case 'batch_backup':
      return 'Batch backup';
    case 'batch_restore':
    case 'backup_restore':
      return 'Backup restore';
    default:
      return String(rawType || 'File transfer')
        .replace(/_/g, ' ')
        .replace(/^\w/, (c) => c.toUpperCase());
  }
}

function formatStatusLabel(status: string | undefined, stage?: string): string {
  if (status === 'completed') return 'Completed';
  if (status === 'completed_with_errors') return 'Completed with warnings';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'queued') return 'Queued';
  if (stage && stage !== 'running') {
    return stage.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
  return 'In progress';
}

export default function JobsDrawer({
  isOpen,
  onClose,
  getAuthHeaders,
  onToast,
  onJobsChanged,
  initialJobs = null,
  onJobsSynced,
  variant = 'drawer',
}: JobsDrawerProps) {
  const [jobs, setJobs] = useState<any[]>(() => (Array.isArray(initialJobs) ? initialJobs : []));
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => Array.isArray(initialJobs));
  const [health, setHealth] = useState<any>(null);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    if (!hasLoaded && Array.isArray(initialJobs)) {
      setJobs(initialJobs);
      setHasLoaded(true);
    }
  }, [initialJobs, hasLoaded]);

  const loadJobs = useCallback(async (manual = false) => {
    if (manual) setIsManualRefreshing(true);
    try {
      const [jobsRes, healthRes] = await Promise.all([
        fetch('/api/jobs', { headers: getAuthHeaders() }),
        fetch('/api/jobs/health', { headers: getAuthHeaders() }),
      ]);
      if (jobsRes.ok) {
        const list = await jobsRes.json();
        if (Array.isArray(list)) {
          setJobs(list);
          onJobsSynced?.(list);
        }
        setHasLoaded(true);
      }
      if (healthRes.ok) setHealth(await healthRes.json());
    } catch {
      /* ignore */
    } finally {
      if (manual) setIsManualRefreshing(false);
    }
  }, [getAuthHeaders, onJobsSynced]);

  useEffect(() => {
    if (!isOpen) return;
    loadJobs(false);
    const timer = setInterval(() => loadJobs(false), 4000);
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

  const activeCount = Number(health?.totals?.running || 0);
  const queuedCount = Number(health?.totals?.queued || 0);

  const jobsListContent = (
    <>
      {!hasLoaded ? (
        <div className="bg-[var(--sf)] border border-[var(--bd)] rounded-[22px] divide-y divide-[var(--bd)]/75 overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div key={i} className="p-4 sm:px-5 sm:py-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-[var(--bg)] animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-44 max-w-[60%] rounded-md bg-[var(--bg)] animate-pulse" />
                  <div className="h-3 w-28 rounded-md bg-[var(--bg)] animate-pulse" />
                </div>
                <div className="h-3.5 w-8 rounded-md bg-[var(--bg)] animate-pulse shrink-0" />
              </div>
              <div className="h-1.5 w-full rounded-full bg-[var(--bg)] animate-pulse" />
            </div>
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <div className="py-20 px-6 text-center space-y-3 bg-[var(--sf)] border border-[var(--bd)] rounded-[24px]">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-[var(--pi)] text-[var(--pit)] flex items-center justify-center">
            <ArrowLeftRight size={22} />
          </div>
          <p className="text-base font-semibold text-[var(--tx)]">No transfers yet</p>
          <p className="text-sm text-[var(--sub)] max-w-sm mx-auto">
            Cross-drive moves, copies, and batch backups appear here with live progress.
          </p>
        </div>
      ) : (
        <div className="bg-[var(--sf)] border border-[var(--bd)] rounded-[22px] divide-y divide-[var(--bd)]/75 overflow-hidden">
          {jobs.map((job, idx) => {
            const pct = Math.min(100, Math.max(0, Number(job.progressPct ?? job.progress ?? 0)));
            const isRunning = job.status === 'running' || job.status === 'queued';
            const isCompleted = job.status === 'completed' || job.status === 'completed_with_errors';
            const isFailed = job.status === 'failed' || job.status === 'cancelled';

            const clipId = `job-wave-${String(job.id || job.jobId || idx).replace(/[^a-zA-Z0-9_-]/g, '')}`;
            const waveWidth = 260;
            const activeEnd = pct <= 0 ? 0 : Math.min(waveWidth - 2, Math.max(8, (pct / 100) * (waveWidth - 4) + 2));
            const trackStart = pct <= 0 ? 2 : Math.min(waveWidth - 4, activeEnd + 6);
            const strokeColor = isFailed ? 'var(--error)' : isCompleted ? 'var(--success)' : 'var(--primary)';
            const primaryName = job.fileName || job.payload?.fileName || formatJobTypeLabel(job.type, job.isMove);
            const showTypeSubtitle = Boolean(job.fileName || job.payload?.fileName);
            const showItemProgress = job.type === 'drive_transfer' || Number(job.totalItems || 0) > 1;

            return (
              <div key={job.id || job.jobId || idx} className="p-4 sm:px-5 sm:py-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <span
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                        isCompleted
                          ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                          : isFailed
                          ? 'bg-rose-500/12 text-rose-600 dark:text-rose-400'
                          : 'bg-[var(--pi)] text-[var(--pit)]'
                      }`}
                    >
                      {isCompleted ? (
                        <CheckCircle2 size={17} />
                      ) : isFailed ? (
                        <XCircle size={17} />
                      ) : (
                        <RefreshCw size={16} className="animate-spin" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--tx)] truncate">{primaryName}</p>
                      <p className="text-xs text-[var(--sub)] mt-0.5 tabular-nums flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        {showTypeSubtitle && (
                          <>
                            <span>{formatJobTypeLabel(job.type, job.isMove)}</span>
                            <span aria-hidden="true">·</span>
                          </>
                        )}
                        <span>{formatStatusLabel(job.status, job.stage)}</span>
                        {showItemProgress && Number(job.totalItems || 0) > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              {Number(job.itemsProcessed || 0)} / {Number(job.totalItems || 0)} files
                            </span>
                          </>
                        )}
                        {job.totalBytes > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              {formatBytes(job.bytesProcessed)} / {formatBytes(job.totalBytes)}
                            </span>
                          </>
                        )}
                        {Number(job.failedCount || 0) > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-600 dark:text-amber-400 font-semibold">
                              {job.failedCount} failed
                            </span>
                          </>
                        )}
                        {job.retryCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>Attempt {job.retryCount + 1}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-mono font-semibold text-[var(--tx)] shrink-0 tabular-nums pt-0.5">
                    {pct}%
                  </span>
                </div>

                {/* M3 Expressive Wavy Progress Line */}
                <svg viewBox="0 0 260 10" className="w-full h-[9px] block overflow-visible" aria-hidden="true">
                  <defs>
                    <clipPath id={clipId}>
                      <rect x="0" y="0" width={activeEnd} height="10" />
                    </clipPath>
                  </defs>
                  {trackStart < 256 && (
                    <line
                      x1={trackStart}
                      y1="5"
                      x2="256"
                      y2="5"
                      stroke="var(--tr)"
                      strokeWidth="2.8"
                      strokeLinecap="round"
                    />
                  )}
                  {pct > 0 && (
                    <path
                      d="M2 5 Q5 1.8 8 5 T14 5 T20 5 T26 5 T32 5 T38 5 T44 5 T50 5 T56 5 T62 5 T68 5 T74 5 T80 5 T86 5 T92 5 T98 5 T104 5 T110 5 T116 5 T122 5 T128 5 T134 5 T140 5 T146 5 T152 5 T158 5 T164 5 T170 5 T176 5 T182 5 T188 5 T194 5 T200 5 T206 5 T212 5 T218 5 T224 5 T230 5 T236 5 T242 5 T248 5 T254 5"
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth="2.8"
                      strokeLinecap="round"
                      clipPath={`url(#${clipId})`}
                    />
                  )}
                </svg>

                {job.error && (
                  <p className="text-xs text-rose-600 dark:text-rose-400 font-medium break-words">{job.error}</p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                  <span className="text-xs text-[var(--sub)] tabular-nums">
                    {job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}
                    {job.sourceDeleteApproved ? ' · Verified move' : ''}
                  </span>
                  <div className="flex items-center gap-2">
                    {isRunning && (
                      <button
                        type="button"
                        onClick={() => handleCancelJob(job.id)}
                        className="h-8 px-3 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400 text-xs font-semibold hover:bg-rose-500/20 transition-colors"
                      >
                        Cancel
                      </button>
                    )}
                    {isFailed && (
                      <button
                        type="button"
                        onClick={() => handleRetryJob(job.id)}
                        className="h-8 px-3 rounded-xl bg-[var(--pi)] text-[var(--pit)] text-xs font-semibold flex items-center gap-1.5 hover:opacity-90 transition-opacity"
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
                          className="h-8 px-3 rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 text-xs font-semibold flex items-center gap-1.5 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
                        >
                          <ShieldCheck size={13} /> {verifyingId === job.id ? 'Verifying...' : 'Verify'}
                        </button>
                        <button
                          type="button"
                          disabled={restoringId === job.id}
                          onClick={() => handleRestoreBackup(job.id)}
                          className="h-8 px-3 rounded-xl bg-[var(--pi)] text-[var(--pit)] text-xs font-semibold flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50 transition-colors"
                        >
                          <ArchiveRestore size={13} /> {restoringId === job.id ? 'Restoring...' : 'Restore'}
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
      <div className="max-w-4xl mx-auto space-y-5 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="w-9 h-9 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-[var(--sub)] hover:text-[var(--tx)] flex items-center justify-center transition-colors shrink-0"
              title="Back to Files"
              aria-label="Back to Files"
            >
              <ArrowLeft size={17} />
            </button>
            <div>
              <h1 className="text-xl font-bold text-[var(--tx)] tracking-tight">Transfers</h1>
              <p className="text-xs text-[var(--sub)] mt-0.5 tabular-nums">
                {activeCount > 0 || queuedCount > 0
                  ? `${activeCount} active · ${queuedCount} queued`
                  : 'Cross-drive moves, copies, and batch backups'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => loadJobs(true)}
            className="h-9 px-3.5 rounded-full bg-[var(--sf)] border border-[var(--bd)] text-xs font-semibold text-[var(--tx)] hover:bg-[var(--hover)] flex items-center gap-2 transition-colors"
          >
            <RefreshCw size={14} className={isManualRefreshing ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>

        <div>{jobsListContent}</div>
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
            className="relative z-10 w-full max-w-lg bg-[var(--sf)] border-l border-[var(--bd)] shadow-2xl flex flex-col h-full text-[var(--tx)]"
          >
            <div className="px-6 py-4 border-b border-[var(--bd)] flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-[var(--tx)] tracking-tight">Transfers</h2>
                <p className="text-xs text-[var(--sub)] mt-0.5 tabular-nums">
                  {activeCount > 0 || queuedCount > 0
                    ? `${activeCount} active · ${queuedCount} queued`
                    : 'Cross-drive moves, copies, and batch backups'}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => loadJobs(true)}
                  className="w-8 h-8 rounded-full hover:bg-[var(--hover)] text-[var(--sub)] hover:text-[var(--tx)] flex items-center justify-center transition-colors"
                  title="Refresh"
                >
                  <RefreshCw size={15} className={isManualRefreshing ? 'animate-spin' : ''} />
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="w-8 h-8 rounded-full hover:bg-[var(--hover)] text-[var(--sub)] hover:text-[var(--tx)] flex items-center justify-center transition-colors"
                  aria-label="Close"
                >
                  <X size={17} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4 no-scrollbar">
              {jobsListContent}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
