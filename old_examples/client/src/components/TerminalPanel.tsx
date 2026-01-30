import React, { useEffect, useRef } from 'react';
import type { LogEntry } from '../types';
import { Terminal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

interface TerminalPanelProps {
  logs: LogEntry[];
  isOpen: boolean;
  onClose: () => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ logs, isOpen, onClose }) => {
  const { t } = useTranslation();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 h-72 bg-[#0a0a0a] border-t border-white/10 shadow-2xl z-40 flex flex-col font-mono text-sm">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-white/5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Terminal className="w-4 h-4" />
          <span className="font-medium text-xs uppercase tracking-wider">{t('paymentResult.systemLogs')}</span>
        </div>
        <button 
          onClick={onClose}
          className="p-1 hover:bg-white/10 rounded-md transition-colors text-muted-foreground hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-1 custom-scrollbar">
        {logs.map((log, i) => (
          <div key={i} className={clsx("break-all", {
            "text-blue-400": log.type === 'system',
            "text-yellow-400": log.type === 'warning',
            "text-red-400": log.type === 'error',
            "text-green-400": log.type === 'executor',
            "text-gray-400": log.type === 'info',
          })}>
            <span className="opacity-50 text-[10px] mr-2">
              {new Date(log.timestamp).toLocaleTimeString()}
            </span>
            {log.message}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
};

