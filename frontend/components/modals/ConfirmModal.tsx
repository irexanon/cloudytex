import React from 'react';
import { motion, AnimatePresence } from 'motion/react';

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
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onCancel} className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <motion.div initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 10 }} transition={{ duration: 0.15 }} className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl relative w-full max-w-sm space-y-6 border border-slate-200 dark:border-slate-700">
            <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">{title}</h2>
            <p className="text-slate-600 dark:text-slate-300 font-medium">{message}</p>
            <div className="flex gap-3">
              <button onClick={onCancel} className="flex-1 py-4 text-slate-500 font-bold hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-2xl transition-all">Cancel</button>
              <button onClick={onConfirm} className="flex-1 bg-red-600 text-white font-bold py-4 rounded-2xl hover:bg-red-700 shadow-xl shadow-red-500/20 transition-all active:scale-95">Confirm</button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
