import React, { useState, useRef, useEffect } from 'react';
import { 
  MessageSquare, 
  Plus, 
  Folder, 
  MoreHorizontal, 
  Pencil, 
  Trash2, 
  Check, 
  X,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { ChatMeta } from '../types';
import { UserMenu } from './UserMenu';

import { useMobile } from '../hooks/useMobile';

interface SidebarProps {
  chats: ChatMeta[];
  currentChatId: string | null;
  onNewChat: () => void;
  onSelectChat: (chatId: string) => void;
  onRenameChat: (chatId: string, newTitle: string) => void;
  onDeleteChat: (chatId: string) => void;
  onOpenSettings: () => void;
  isLoading?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  chats,
  currentChatId,
  onNewChat,
  onSelectChat,
  onRenameChat,
  onDeleteChat,
  onOpenSettings,
  isLoading = false,
  isOpen = false,
  onClose
}) => {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  
  const editInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const startEditing = (chat: ChatMeta) => {
    setEditingId(chat.id);
    setEditValue(chat.title);
    setMenuOpenId(null);
  };

  const saveEdit = () => {
    if (editingId && editValue.trim()) {
      onRenameChat(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  const confirmDelete = (chatId: string) => {
    setDeleteConfirmId(chatId);
    setMenuOpenId(null);
  };

  const executeDelete = () => {
    if (deleteConfirmId) {
      onDeleteChat(deleteConfirmId);
      setDeleteConfirmId(null);
    }
  };

  // Group chats by date
  const groupedChats = groupChatsByDate(chats);

  const sidebarContent = (
    <>
      {/* Header + New Chat Button */}
      <div className="p-4">
        <button 
          onClick={onNewChat}
          className="w-full flex items-center justify-center gap-2 bg-white text-black px-4 py-3 rounded-xl font-semibold hover:bg-zinc-200 transition-all shadow-lg hover:shadow-glow active:scale-[0.98]"
        >
          <Plus size={18} strokeWidth={2.5} />
          <span>{t('sidebar.newChat')}</span>
        </button>
      </div>
      
      {/* Chat List */}
      <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-zinc-500">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : chats.length === 0 ? (
          <div className="text-center py-8 text-zinc-600">
            <MessageSquare size={32} className="mx-auto mb-2 opacity-50" />
            <p className="text-sm">{t('sidebar.noChats')}</p>
          </div>
        ) : (
          Object.entries(groupedChats).map(([group, groupChats]) => (
            <div key={group} className="mb-4">
              <div className="px-3 py-2 text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">
                {t(`sidebar.${group.toLowerCase().replace(' ', '')}`)}
              </div>
              <AnimatePresence mode="popLayout">
                {groupChats.map((chat) => (
                  <motion.div
                    key={chat.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10, height: 0 }}
                    layout
                    className="relative group"
                  >
                    {editingId === chat.id ? (
                      // Edit Mode
                      <div className="flex items-center gap-1 px-2 py-1">
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={handleKeyDown}
                          onBlur={saveEdit}
                          className="flex-1 bg-zinc-800 text-white text-sm px-2 py-1.5 rounded-lg border border-blue-500/50 outline-none focus:border-blue-500"
                        />
                        <button
                          onClick={saveEdit}
                          className="p-1.5 text-emerald-400 hover:bg-emerald-500/20 rounded-lg transition-colors"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="p-1.5 text-zinc-400 hover:bg-zinc-700 rounded-lg transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      // Normal Mode
                      <button
                        onClick={() => onSelectChat(chat.id)}
                        className={clsx(
                          "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all",
                          currentChatId === chat.id
                            ? "bg-white/10 text-white"
                            : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                        )}
                      >
                        <MessageSquare size={16} className="flex-shrink-0 opacity-60" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{chat.title}</p>
                          {chat.preview && (
                            <p className="text-[11px] text-zinc-600 truncate mt-0.5">
                              {chat.preview}
                            </p>
                          )}
                        </div>
                        
                        {/* Menu Trigger */}
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(menuOpenId === chat.id ? null : chat.id);
                          }}
                          className={clsx(
                            "p-1 rounded-lg transition-all",
                            menuOpenId === chat.id 
                              ? "bg-zinc-700 text-white" 
                              : "opacity-0 group-hover:opacity-100 hover:bg-zinc-800 text-zinc-500 hover:text-white"
                          )}
                        >
                          <MoreHorizontal size={14} />
                        </div>
                      </button>
                    )}

                    {/* Dropdown Menu */}
                    <AnimatePresence>
                      {menuOpenId === chat.id && (
                        <motion.div
                          ref={menuRef}
                          initial={{ opacity: 0, scale: 0.95, y: -5 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: -5 }}
                          className="absolute right-2 top-full z-50 mt-1 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden min-w-[140px]"
                        >
                          <button
                            onClick={() => startEditing(chat)}
                            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-zinc-300 hover:bg-white/10 hover:text-white transition-colors"
                          >
                            <Pencil size={14} />
                            <span>{t('common.rename')}</span>
                          </button>
                          <button
                            onClick={() => confirmDelete(chat.id)}
                            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 size={14} />
                            <span>{t('common.delete')}</span>
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-white/5 space-y-3">
        <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-colors">
          <Folder size={18} />
          <span className="text-sm">{t('common.library')}</span>
        </button>
        <UserMenu onOpenSettings={onOpenSettings} />
      </div>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {deleteConfirmId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setDeleteConfirmId(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-zinc-900 border border-white/10 rounded-2xl p-6 max-w-sm mx-4 shadow-2xl"
            >
              <h3 className="text-lg font-semibold text-white mb-2">{t('sidebar.deleteConfirmTitle')}</h3>
              <p className="text-sm text-zinc-400 mb-6">
                {t('sidebar.deleteConfirmBody')}
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-white transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={executeDelete}
                  className="px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
                >
                  {t('common.delete')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlay isOpen={isOpen} onClose={onClose!}>
        {sidebarContent}
      </MobileOverlay>
    );
  }

  return (
    <div className="hidden md:flex w-72 h-full border-r border-white/5 bg-zinc-950 flex-col">
      {sidebarContent}
    </div>
  );
};

// Helper function to group chats by date
function groupChatsByDate(chats: ChatMeta[]): Record<string, ChatMeta[]> {
  const groups: Record<string, ChatMeta[]> = {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (const chat of chats) {
    const chatDate = new Date(chat.updatedAt);
    const chatDay = new Date(chatDate.getFullYear(), chatDate.getMonth(), chatDate.getDate());

    let group: string;
    if (chatDay.getTime() >= today.getTime()) {
      group = 'Today';
    } else if (chatDay.getTime() >= yesterday.getTime()) {
      group = 'Yesterday';
    } else if (chatDay.getTime() >= weekAgo.getTime()) {
      group = 'This Week';
    } else {
      group = 'Older';
    }

    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(chat);
  }

  // Return in order: Today, Yesterday, This Week, Older
  const orderedGroups: Record<string, ChatMeta[]> = {};
  for (const key of ['Today', 'Yesterday', 'This Week', 'Older']) {
    if (groups[key]) {
      orderedGroups[key] = groups[key];
    }
  }
  return orderedGroups;
}

const MobileOverlay: React.FC<{ isOpen: boolean; onClose: () => void; children: React.ReactNode }> = ({ 
  isOpen, 
  onClose, 
  children 
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[40] bg-black/60 backdrop-blur-sm md:hidden"
          />
          {/* Drawer */}
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.1, right: 0.5 }}
            onDragEnd={(_, info) => {
              if (info.offset.x < -100) {
                onClose();
              }
            }}
            className="fixed inset-y-0 left-0 z-[50] w-[280px] bg-zinc-950 border-r border-white/5 shadow-2xl md:hidden flex flex-col overflow-hidden"
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
