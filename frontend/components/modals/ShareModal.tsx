import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Share2, Copy, Check, X, Lock, Clock, Download, AlertCircle } from 'lucide-react';

export interface ShareModalProps {
  isOpen: boolean;
  file: any | null;
  accountId: string | null;
  getAuthHeaders: () => Record<string, string>;
  onClose: () => void;
  onToast: (msg: string, type?: 'success' | 'error') => void;
}

export default function ShareModal({
  isOpen,
  file,
  accountId,
  getAuthHeaders,
  onClose,
  onToast,
}: ShareModalProps) {
  const [expiresInHours, setExpiresInHours] = useState<string>('');
  const [maxDownloads, setMaxDownloads] = useState<string>('');
  const [pin, setPin] = useState<string>('');
  const [allowDownload, setAllowDownload] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdShare, setCreatedShare] = useState<{
    shareId: string;
    shareUrl: string;
    expiresAt: string | null;
    maxDownloads: number | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setExpiresInHours('');
      setMaxDownloads('');
      setPin('');
      setAllowDownload(true);
      setError(null);
      setCreatedShare(null);
      setCopied(false);
    }
  }, [isOpen, file?.id]);

  const handleCreateShare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !accountId) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, any> = {
        accountId,
        fileId: file.id,
        allowDownload,
      };
      if (expiresInHours.trim()) {
        const hrs = Number(expiresInHours);
        if (Number.isFinite(hrs) && hrs > 0) payload.expiresInHours = hrs;
      }
      if (maxDownloads.trim()) {
        const cap = Number(maxDownloads);
        if (Number.isFinite(cap) && cap > 0) payload.maxDownloads = Math.floor(cap);
      }
      if (pin.trim()) payload.pin = pin.trim();

      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.shareUrl) {
        throw new Error(data.error || 'Failed to create share link');
      }
      setCreatedShare({
        shareId: data.shareId,
        shareUrl: data.shareUrl,
        expiresAt: data.expiresAt || null,
        maxDownloads: data.maxDownloads ?? null,
      });
      await navigator.clipboard.writeText(data.shareUrl).catch(() => {});
      setCopied(true);
      onToast('Share link created and copied to clipboard');
    } catch (err: any) {
      setError(err.message || 'Share failed');
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = async () => {
    if (!createdShare?.shareUrl) return;
    await navigator.clipboard.writeText(createdShare.shareUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    onToast('Share link copied');
  };

  return (
    <AnimatePresence>
      {isOpen && file && (
        <div className="fixed inset-0 z-[170] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="relative z-10 bg-[var(--sf)] text-[var(--tx)] border border-[var(--bd)] rounded-[28px] shadow-2xl w-full max-w-md overflow-hidden"
          >
            <div className="px-6 pt-6 pb-4 border-b border-[var(--bd)] flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-[var(--pi)] text-[var(--pit)] flex items-center justify-center shrink-0">
                  <Share2 size={18} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-extrabold text-[var(--tx)] tracking-tight">Share File</h2>
                  <p className="text-xs text-[var(--sub)] truncate mt-0.5 tabular-nums">
                    {file.name} · {file.size}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-2 rounded-full text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6">
              {file.isEncrypted ? (
                <div className="p-4 rounded-2xl bg-amber-500/12 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-sm flex items-start gap-3">
                  <AlertCircle size={18} className="shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-bold">Encrypted files cannot be publicly shared</p>
                    <p className="text-xs opacity-90 mt-1 leading-relaxed">
                      Zero-knowledge CYTE1 files require client-side keys and cannot be served via unauthenticated public share links.
                    </p>
                  </div>
                </div>
              ) : createdShare ? (
                <div className="space-y-4">
                  <div className="p-4 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] space-y-2">
                    <label className="text-xs font-semibold text-[var(--sub)]">Public Share URL</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={createdShare.shareUrl}
                        className="flex-1 h-10 bg-[var(--sf)] border border-[var(--bd)] rounded-xl px-3.5 text-xs font-mono text-[var(--tx)] outline-none"
                      />
                      <button
                        type="button"
                        onClick={copyLink}
                        className="px-4 h-10 rounded-full bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all active:scale-[0.97]"
                      >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        <span>{copied ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[var(--sub)] tabular-nums">
                    <span>
                      ID: <strong className="font-mono text-[var(--tx)]">{createdShare.shareId}</strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{createdShare.expiresAt ? `Expires ${new Date(createdShare.expiresAt).toLocaleString()}` : 'No expiry'}</span>
                    <span aria-hidden="true">·</span>
                    <span>{createdShare.maxDownloads ? `Max ${createdShare.maxDownloads} downloads` : 'Unlimited downloads'}</span>
                    {pin.trim() && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>PIN protected</span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-2.5 pt-2">
                    <button
                      type="button"
                      onClick={() => setCreatedShare(null)}
                      className="px-4 h-10 rounded-full border border-[var(--bd)] text-xs font-semibold text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                    >
                      Update Options
                    </button>
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-5 h-10 rounded-full bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold transition-all active:scale-[0.97]"
                    >
                      Done
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleCreateShare} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-[var(--sub)] flex items-center gap-1.5">
                        <Clock size={12} />
                        <span>Expiration</span>
                      </label>
                      <select
                        value={expiresInHours}
                        onChange={(e) => setExpiresInHours(e.target.value)}
                        className="w-full h-10 px-3.5 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-xs font-semibold text-[var(--tx)] outline-none focus:border-[#2563EB]"
                      >
                        <option value="">Never expires</option>
                        <option value="1">1 hour</option>
                        <option value="24">24 hours</option>
                        <option value="168">7 days</option>
                        <option value="720">30 days</option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-[var(--sub)] flex items-center gap-1.5">
                        <Download size={12} />
                        <span>Max Downloads</span>
                      </label>
                      <input
                        type="number"
                        min={1}
                        placeholder="Unlimited"
                        value={maxDownloads}
                        onChange={(e) => setMaxDownloads(e.target.value)}
                        className="w-full h-10 px-3.5 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-xs font-semibold text-[var(--tx)] outline-none focus:border-[#2563EB] tabular-nums"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-[var(--sub)] flex items-center gap-1.5">
                      <Lock size={12} />
                      <span>Optional PIN Code</span>
                    </label>
                    <input
                      type="text"
                      maxLength={32}
                      placeholder="Leave blank for open access"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      className="w-full h-10 px-3.5 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] text-xs font-semibold text-[var(--tx)] outline-none focus:border-[#2563EB]"
                    />
                  </div>

                  <label className="flex items-center justify-between p-3.5 rounded-2xl bg-[var(--bg)] border border-[var(--bd)] cursor-pointer">
                    <div>
                      <p className="text-xs font-semibold text-[var(--tx)]">Allow direct file downloads</p>
                      <p className="text-[11px] text-[var(--sub)]">Turn off to restrict to landing page metadata only</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={allowDownload}
                      onChange={(e) => setAllowDownload(e.target.checked)}
                      className="w-4 h-4 rounded border-[var(--bd)] text-[#2563EB] focus:ring-[#2563EB]"
                    />
                  </label>

                  {error && (
                    <p className="text-xs font-semibold text-rose-500">{error}</p>
                  )}

                  <div className="flex items-center justify-end gap-2.5 pt-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-5 h-10 rounded-full text-xs font-semibold text-[var(--sub)] hover:text-[var(--tx)] hover:bg-[var(--bg)] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="px-6 h-10 rounded-full bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold transition-all active:scale-[0.97] disabled:opacity-50"
                    >
                      {submitting ? 'Generating...' : 'Create & Copy Link'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
