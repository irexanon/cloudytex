import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, X } from 'lucide-react';

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({ isOpen, title, message, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onCancel}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
            className="relative z-10 bg-[var(--sf)] text-[var(--tx)] p-7 rounded-[28px] shadow-2xl w-full max-w-sm border border-[var(--bd)] space-y-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-2xl bg-rose-500/15 text-rose-500 flex items-center justify-center shrink-0">
                  <AlertTriangle size={20} />
                </div>
                <h2 className="text-lg font-extrabold text-[var(--tx)] tracking-tight leading-snug">{title}</h2>
              </div>
              <button
                type="button"
                onClick={onCancel}
                className="p-2 hover:bg-[var(--bg)] rounded-full text-[var(--sub)] hover:text-[var(--tx)] transition-colors shrink-0"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-[var(--sub)] font-medium leading-relaxed">{message}</p>
            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                onClick={onCancel}
                className="flex-1 py-3 text-sm text-[var(--sub)] hover:text-[var(--tx)] font-bold hover:bg-[var(--bg)] rounded-[18px] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="flex-1 py-3 bg-rose-600 text-white text-sm font-bold rounded-[18px] hover:bg-rose-700 shadow-lg shadow-rose-600/20 transition-all active:scale-95"
              >
                Confirm
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
