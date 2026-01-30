import React from 'react';
import { Menu, Plus, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface MobileHeaderProps {
  onMenuClick: () => void;
  chatTitle?: string;
  onNewChat: () => void;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({ 
  onMenuClick, 
  chatTitle, 
  onNewChat 
}) => {
  const { t } = useTranslation();

  return (
    <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-white/5 bg-zinc-950/50 backdrop-blur-md sticky top-0 z-30">
      <div className="flex items-center gap-3">
        <button 
          onClick={onMenuClick}
          className="p-2 -ml-2 text-zinc-400 hover:text-white transition-colors"
          aria-label="Menu"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2">
           <Sparkles size={18} className="text-white" />
           <h1 className="text-sm font-semibold text-white truncate max-w-[150px]">
             {chatTitle || t('sidebar.newChatDefaultName')}
           </h1>
        </div>
      </div>
      
      <button 
        onClick={onNewChat}
        className="p-2 -mr-2 text-zinc-400 hover:text-white transition-colors"
        aria-label="New Chat"
      >
        <Plus size={20} />
      </button>
    </header>
  );
};

