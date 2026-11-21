import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';

export interface PromptModalProps {
  isOpen: boolean;
  title: string;
  value: string;
  onChange: (val: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function PromptModal({ isOpen, title, value, onChange, onConfirm, onCancel }: PromptModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-6">
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
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-extrabold text-[var(--tx)] tracking-tight">{title}</h2>
              <button
                type="button"
                onClick={onCancel}
                className="p-2 hover:bg-[var(--bg)] rounded-full text-[var(--sub)] hover:text-[var(--tx)] transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <input
              autoFocus
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onConfirm();
              }}
              className="w-full px-4 py-3.5 bg-[var(--bg)] border border-[var(--bd)] focus:border-[#2563EB] rounded-2xl outline-none transition-colors font-bold text-sm text-[var(--tx)]"
            />
            <div className="flex gap-2.5">
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
                className="flex-1 py-3 bg-[#2563EB] text-white text-sm font-bold rounded-[18px] hover:bg-blue-700 shadow-lg shadow-blue-600/20 transition-all active:scale-95"
              >
                Save
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
