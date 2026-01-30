import React from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import type { Agent } from '../types';
import { Bot, Sparkles, X } from 'lucide-react';
import { useMobile } from '../hooks/useMobile';
import { BottomSheet } from './BottomSheet';

interface AgentSelectorProps {
  agents: Agent[];
  onSelect: (agentId: string) => void;
  onClose: () => void;
}

export const AgentSelector: React.FC<AgentSelectorProps> = ({ agents, onSelect, onClose }) => {
  const { t } = useTranslation();
  const isMobile = useMobile();

  const selectorContent = (
    <div className={clsx("grid gap-4", isMobile ? "mt-4" : "max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar")}>
      {agents.map((agent) => (
        <motion.button
          key={agent.id}
          whileHover={{ scale: 1.01, backgroundColor: 'rgba(255,255,255,0.03)' }}
          whileTap={{ scale: 0.99 }}
          onClick={() => onSelect(agent.id)}
          className="flex items-start gap-4 p-4 rounded-lg border border-border/50 hover:border-white/20 transition-colors text-left group"
        >
          <div className="p-3 rounded-md bg-white/5 group-hover:bg-white/10 transition-colors">
            <Bot className="w-6 h-6 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-white group-hover:text-blue-400 transition-colors">
              {agent.name}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {agent.description}
            </p>
          </div>
        </motion.button>
      ))}
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet isOpen={true} onClose={onClose}>
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/5 mb-3 border border-white/10">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-xl font-bold text-white mb-1 tracking-tight">{t('agentSelector.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('agentSelector.subtitle')}</p>
        </div>
        {selectorContent}
      </BottomSheet>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-2xl bg-background border border-border rounded-xl shadow-2xl overflow-hidden p-8 relative"
      >
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-zinc-500 hover:text-white transition-colors"
        >
          <X size={24} />
        </button>
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-white/5 mb-4 border border-white/10">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-3xl font-bold text-white mb-2 tracking-tight">{t('agentSelector.title')}</h2>
          <p className="text-muted-foreground">{t('agentSelector.subtitle')}</p>
        </div>

        {selectorContent}
      </motion.div>
    </div>
  );
};

