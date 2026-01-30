import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { SessionItem, Block, Attachment } from '../types';
import { Send, User, Loader2, Paperclip, X, FileText, Plus, CheckCircle2, Circle, BrainCircuit, Terminal, ArrowRightLeft, Eye, Sparkles, RefreshCcw, GitFork, Edit2, Copy, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useMobile } from '../hooks/useMobile';
import { PlanWidget } from './PlanWidget';
import { StatusIndicator } from './StatusIndicator';
import { MarkdownBlock } from './MarkdownBlock';
import { MediaModal } from './MediaModal';
import { ToolUIRenderer } from './ToolUIRenderer';
import { Tooltip } from './Tooltip';

interface ChatAreaProps {
  items: SessionItem[];
  onSendMessage: (text: string, attachments: Attachment[]) => void;
  isStreaming: boolean;
  planEnabled: boolean;
  onPlanEnabledChange: (enabled: boolean) => void;
  proModeEnabled?: boolean;
  onProModeEnabledChange?: (enabled: boolean) => void;
  inputDisabled?: boolean;
  topBanner?: React.ReactNode;
  onBranch?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string, newContent: string) => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  items,
  onSendMessage,
  isStreaming,
  planEnabled,
  onPlanEnabledChange,
  proModeEnabled = false,
  onProModeEnabledChange,
  inputDisabled = false,
  topBanner = null,
  onBranch,
  onRegenerate,
  onEdit
}) => {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ url: string; type: string; name: string } | null>(null);
  
  // Edit mode state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logic
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, isStreaming, items.length]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSend = () => {
    if (inputDisabled) return;
    if ((!input.trim() && attachments.length === 0) || isStreaming) return;

    onSendMessage(input, attachments);

    setInput('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // --- File Handling ---

  const processFiles = async (files: FileList | File[]) => {
    const newAttachments: Attachment[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();

      await new Promise<void>((resolve) => {
        reader.onload = (e) => {
          if (e.target?.result) {
            const dataUrl = e.target.result as string;
            const base64 = dataUrl.split(',')[1];

            newAttachments.push({
              name: file.name,
              type: file.type,
              dataUrl: dataUrl,
              base64: base64
            });
          }
          resolve();
        };
        reader.readAsDataURL(file);
      });
    }

    setAttachments(prev => [...prev, ...newAttachments]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      processFiles(e.clipboardData.files);
    }
  };

  // --- Drag and Drop ---

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragActive(true);
    } else if (e.type === 'dragleave') {
      setIsDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }, []);

  const handleStartEdit = (messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditText(content);
  };

  const handleSaveEdit = (messageId: string) => {
    if (onEdit && editText.trim()) {
        onEdit(messageId, editText);
    }
    setEditingMessageId(null);
    setEditText('');
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditText('');
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // --- Render Helpers ---

  const renderAttachmentPreview = (att: Attachment, index: number) => {
    const isImage = att.type.startsWith('image/');
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        key={index}
        className="relative group flex-shrink-0"
      >
        <div
          onClick={() => setPreviewFile({ url: att.dataUrl, type: att.type, name: att.name })}
          className="flex items-center gap-3 bg-zinc-800/80 backdrop-blur-sm rounded-xl p-2 pr-8 border border-white/10 cursor-pointer hover:bg-zinc-800 transition-colors"
        >
          {isImage ? (
            <div className="w-10 h-10 rounded-lg overflow-hidden bg-black/50 border border-white/5">
              <img src={att.dataUrl} alt={att.name} className="w-full h-full object-cover" />
            </div>
          ) : (
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-zinc-700/50 text-zinc-400 border border-white/5">
              <FileText size={20} />
            </div>
          )}
          <div className="flex flex-col min-w-[60px] max-w-[120px]">
            <span className="text-xs font-medium text-zinc-200 truncate">{att.name}</span>
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{att.type.split('/')[1] || 'FILE'}</span>
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); removeAttachment(index); }}
          className="absolute -top-2 -right-2 bg-zinc-700 text-zinc-300 rounded-full p-1 hover:bg-red-500 hover:text-white transition-all shadow-lg opacity-0 group-hover:opacity-100 scale-90 hover:scale-100"
        >
          <X size={12} />
        </button>
      </motion.div>
    );
  };

  // Specialized Renderers for the Tree View

  const renderBlockContent = (block: Block, isTrailing: boolean = false) => {
    switch (block.type) {
      case 'plan':
        return <PlanWidget todos={block.todos} />;
      case 'thought':
        return (
          <div className="rounded-xl border-white/5 p-1.5 pl-3">
             <StatusIndicator
                type="thought"
                content={block.content}
                isFinished={'isFinished' in block ? block.isFinished : true}
                duration={'duration' in block ? block.duration : undefined}
                reasoning={'reasoning' in block ? block.reasoning : undefined}
                isTrailing={isTrailing}
             />
          </div>
        );
      case 'action':
        return (
          <div className="rounded-xl border-white/5 p-1.5 pl-3">
            <StatusIndicator
                type="action"
                content={block.content}
                isFinished={'isFinished' in block ? block.isFinished : true}
                duration={'duration' in block ? block.duration : undefined}
                isTrailing={isTrailing}
            />
          </div>
        );
      case 'switch':
        return (
          <div className="rounded-xl border-white/5 p-1.5 pl-3">
             <StatusIndicator
                type="switch"
                content={block.content}
                isFinished={'isFinished' in block ? block.isFinished : true}
                modelName={'modelName' in block ? block.modelName : undefined}
                reason={'reason' in block ? block.reason : undefined}
                isTrailing={isTrailing}
             />
          </div>
        );
      case 'context':
        return (
          <div className="ounded-xl border-white/5 p-1.5 pl-3">
             <StatusIndicator
                type="context"
                content={block.content}
                isFinished={'isFinished' in block ? block.isFinished : true}
                isTrailing={isTrailing}
             />
          </div>
        );
      case 'text':
        return <div className="rounded-xl border-white/5 p-1 pl-3"> <MarkdownBlock
            content={block.content}/> </div>;
      case 'toolUI':
        return (
          <div className="rounded-xl border-white/5 p-1.5 pl-3">
            <ToolUIRenderer
              content={block.content}
              isFinished={'isFinished' in block ? block.isFinished : true}
              duration={'duration' in block ? block.duration : undefined}
              uis={'uis' in block ? block.uis : []}
              currentUIIndex={'currentUIIndex' in block ? block.currentUIIndex : 0}
              isTrailing={isTrailing}
            />
          </div>
        );
      default:
        return null;
    }
  };

  const getBlockIcon = (type: string, isFinished: boolean = true, isTrailing: boolean = false) => {
    if (isFinished && isTrailing && (type === 'action' || type === 'toolUI')) {
        return <CheckCircle2 size={14} />;
    }
    switch(type) {
        case 'plan': return <CheckCircle2 size={14} />;
        case 'thought': return <BrainCircuit size={14} />;
        case 'action': return <Terminal size={14} />;
        case 'switch': return <ArrowRightLeft size={14} />;
        case 'context': return <Eye size={14} />;
        case 'toolUI': return <Sparkles size={14} />;
        case 'text': return <div className="w-2 h-2 rounded-full bg-current" />;
        default: return <Circle size={10} />;
    }
  };

  const getBlockColor = (type: string, isFinished: boolean = true, isTrailing: boolean = false) => {
    if (isFinished && isTrailing && (type === 'action' || type === 'toolUI')) {
        return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
    }
    switch(type) {
        case 'plan': return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
        case 'thought': return 'text-amber-400 border-amber-500/30 bg-amber-500/10';
        case 'action': return 'text-blue-400 border-blue-500/30 bg-blue-500/10';
        case 'switch': return 'text-purple-400 border-purple-500/30 bg-purple-500/10';
        case 'context': return 'text-orange-400 border-orange-500/30 bg-orange-500/10';
        case 'toolUI': return 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10';
        default: return 'text-zinc-400 border-zinc-700 bg-zinc-800';
    }
  };

  return (
    <div
      className="flex flex-col h-full relative overflow-hidden"
      onDragEnter={handleDrag}
    >
      <MediaModal
        isOpen={!!previewFile}
        onClose={() => setPreviewFile(null)}
        file={previewFile}
      />

      {/* Drag Overlay */}
      <AnimatePresence>
        {isDragActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-zinc-950/90 backdrop-blur-md flex flex-col items-center justify-center m-4 rounded-3xl border border-blue-500/30"
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
             <motion.div
               initial={{ scale: 0.9 }}
               animate={{ scale: 1 }}
               className="p-8 bg-blue-500/10 rounded-full mb-6 ring-1 ring-blue-500/20"
             >
               <Plus size={64} className="text-blue-400" />
             </motion.div>
            <h3 className="text-3xl font-medium text-white mb-3">{t('chat.dropFiles')}</h3>
            <p className="text-zinc-400 text-lg">{t('chat.dropFilesSub')}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Messages Container */}
      <div
        ref={containerRef}
        className={clsx(
          "flex-1 overflow-y-auto space-y-8 custom-scrollbar max-w-5xl mx-auto w-full scroll-smooth",
          isMobile ? "px-2 py-4" : "px-4 py-8"
        )}
      >
        {items.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50 select-none">
            <div className="w-24 h-24 bg-zinc-800/30 rounded-3xl flex items-center justify-center mb-6 border border-white/5">
                <Sparkles className="w-12 h-12 text-zinc-500" />
            </div>
            <p className="text-lg font-medium text-zinc-400">{t('chat.startSession')}</p>
          </div>
        )}

        {items.map((item, itemIdx) => (
          <div key={item.id} className="w-full group">
            {item.role === 'user' ? (
              // USER MESSAGE
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-row-reverse gap-4"
              >
                {/* Avatar */}
                {!isMobile && (
                  <div className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center flex-shrink-0 border border-white/10 shadow-lg text-zinc-400">
                      <User size={20} />
                  </div>
                )}

                <div className={clsx("flex flex-col items-end", isMobile ? "max-w-[92%]" : "max-w-[80%]")}>
                  {/* Attachments */}
                  {item.attachments && item.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 justify-end mb-2">
                      {item.attachments.map((att, i) => (
                        <div
                            key={i}
                            onClick={() => setPreviewFile({ url: att.dataUrl, type: att.type, name: att.name })}
                            className="cursor-pointer hover:opacity-80 transition-opacity"
                        >
                            {att.type.startsWith('image/') ? (
                                <div className="relative rounded-xl overflow-hidden border border-white/10 shadow-sm w-32 h-32">
                                    <img src={att.dataUrl} alt={att.name} className="w-full h-full object-cover" />
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 bg-zinc-800/50 rounded-lg p-3 border border-white/10">
                                    <FileText size={20} className="text-zinc-400" />
                                    <span className="text-sm text-zinc-200 truncate max-w-[150px]">{att.name}</span>
                                </div>
                            )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Bubble / Edit Mode */}
                  {editingMessageId === item.id ? (
                     <div className={clsx("bg-zinc-800 rounded-2xl p-3 border border-white/10 w-full", isMobile ? "min-w-[260px]" : "min-w-[300px]")}>
                        <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            className="w-full bg-transparent text-white border-none focus:ring-0 resize-none outline-none custom-scrollbar"
                            rows={3}
                            autoFocus
                        />
                        <div className="flex justify-end gap-2 mt-2">
                            <button
                                onClick={handleCancelEdit}
                                className="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                onClick={() => handleSaveEdit(item.id)}
                                disabled={!editText.trim()}
                                className="px-3 py-1.5 text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 rounded-lg transition-colors"
                            >
                                {t('chat.saveAndRegenerate')}
                            </button>
                        </div>
                     </div>
                  ) : (
                      item.content && (
                        <div className="relative group/bubble">
                            <div className={clsx(
                                "bg-zinc-800 text-white rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed shadow-sm border border-white/5 whitespace-pre-wrap",
                                isMobile ? "rounded-tr-sm" : "rounded-tr-sm px-6 py-3.5"
                            )}>
                              {item.content}
                            </div>
                            
                            {/* Action Buttons (Visible on Hover/Mobile Tap) */}
                            <div className={clsx(
                                "absolute top-full right-0 mt-2 flex items-center gap-1 transition-opacity duration-200 bg-zinc-900/90 backdrop-blur border border-white/10 rounded-xl p-1 shadow-xl z-20",
                                isMobile ? "opacity-100" : "opacity-0 group-hover/bubble:opacity-100"
                            )}>
                                <Tooltip content={t('tooltips.regenerate')} position="bottom">
                                    <button 
                                        onClick={() => onRegenerate?.(item.id)}
                                        className="p-1.5 text-zinc-400 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors"
                                    >
                                        <RefreshCcw size={14} />
                                    </button>
                                </Tooltip>
                                <Tooltip content={t('tooltips.branch')} position="bottom">
                                    <button 
                                        onClick={() => onBranch?.(item.id)}
                                        className="p-1.5 text-zinc-400 hover:text-purple-400 hover:bg-purple-500/10 rounded-lg transition-colors"
                                    >
                                        <GitFork size={14} />
                                    </button>
                                </Tooltip>
                                <Tooltip content={t('tooltips.edit')} position="bottom">
                                    <button 
                                        onClick={() => handleStartEdit(item.id, item.content)}
                                        className="p-1.5 text-zinc-400 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                                    >
                                        <Edit2 size={14} />
                                    </button>
                                </Tooltip>
                                <Tooltip content={t('tooltips.copy')} position="bottom">
                                    <button 
                                        onClick={() => copyToClipboard(item.content)}
                                        className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                    >
                                        <Copy size={14} />
                                    </button>
                                </Tooltip>
                            </div>
                        </div>
                      )
                  )}
                </div>
              </motion.div>
            ) : (
              // ASSISTANT MESSAGE (Timeline Layout)
              <motion.div
                 initial={{ opacity: 0 }}
                 animate={{ opacity: 1 }}
                 className="flex gap-0 relative"
              >
                 {/* Left Rail: Avatar + Vertical Line */}
                 <div className={clsx("flex flex-col items-center flex-shrink-0", isMobile ? "w-10" : "w-16")}>
                    <div className={clsx(
                        "rounded-xl bg-blue-600/10 flex items-center justify-center border border-blue-500/20 text-blue-400 z-10 bg-background",
                        isMobile ? "w-8 h-8" : "w-10 h-10"
                    )}>
                       <Sparkles size={isMobile ? 16 : 20} />
                    </div>
                    {/* The Main Thread Line */}
                    <div className="w-[2px] flex-1 bg-gradient-to-b from-blue-500/20 via-zinc-800 to-transparent my-2 rounded-full" />
                 </div>

                 {/* Content Rail */}
                 <div className={clsx("flex-1 flex flex-col gap-6 pt-2 pb-10 min-w-0", isMobile ? "pl-0" : "")}>
                    {item.blocks?.map((block, idx) => {
                        // Type guard for isFinished
                        const isFinished = 'isFinished' in block ? block.isFinished : true;
                        const isLastBlock = idx === (item.blocks?.length ?? 0) - 1;
                        const isLastItem = itemIdx === items.length - 1;
                        const isTrailing = isLastBlock && (!isStreaming || !isLastItem);

                        // Check if it's a "default" plan that should be hidden
                        if (block.type === 'plan') {
                            const isDefault = block.todos.every(t => 
                                t.task === 'Complete the user request (and call todo.completeCurrent() when over)' ||
                                t.task === 'Complete the user request'
                            );
                            if (isDefault) return null;
                        }

                        return (
                           <motion.div
                              key={block.id}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: idx * 0.05 }}
                              className={clsx("relative", isMobile ? "pl-4" : "pl-8")}
                           >
                              {/* Horizontal Connector Curve */}
                              <div className={clsx("absolute top-3.5 h-6", isMobile ? "left-[-1.5rem] w-6" : "left-[-1.95rem] w-8")}>
                                 <svg width="100%" height="100%" className="overflow-visible">
                                    <path
                                      d={isMobile ? "M 0 0 C 8 0, 8 0, 16 0" : "M 0 0 C 15 0, 15 0, 32 0"}
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      className={clsx("opacity-30", {
                                          "text-emerald-500": isFinished && isTrailing && (block.type === 'action' || block.type === 'toolUI'),
                                          "text-blue-500": !isFinished && block.type !== 'text' && !(isTrailing && (block.type === 'action' || block.type === 'toolUI')),
                                          "text-zinc-700": isFinished && (!isTrailing || (block.type !== 'action' && block.type !== 'toolUI')) || block.type === 'text'
                                      })}
                                    />
                                    <circle cx="0" cy="0" r="3" className="fill-zinc-800 stroke-zinc-700" />
                                 </svg>
                              </div>

                              {/* Block Icon / Node Indicator */}
                              <div className={clsx(
                                "absolute left-0 top-1 rounded-full border flex items-center justify-center bg-background z-10 transition-colors duration-500",
                                isMobile ? "w-5 h-5" : "w-6 h-6",
                                getBlockColor(block.type, isFinished, isTrailing)
                              )}>
                                  {getBlockIcon(block.type, isFinished, isTrailing)}
                              </div>

                              {/* The Actual Content */}
                              <div className={clsx("transition-all duration-300", {
                                  "opacity-100": true,
                                  "opacity-60 hover:opacity-100": block.type !== 'text' && isFinished && !isTrailing,
                                  "text-sm": isMobile && block.type === 'text'
                              })}>
                                  {renderBlockContent(block, isTrailing)}
                              </div>
                           </motion.div>
                        );
                    })}
                 </div>
              </motion.div>
            )}
          </div>
        ))}

        {isStreaming && items[items.length - 1]?.role === 'user' && (
             <div className="flex gap-0 animate-pulse">
               <div className="flex flex-col items-center w-16 flex-shrink-0">
                    <div className="w-10 h-10 rounded-xl bg-zinc-800/50 flex items-center justify-center border border-white/5 text-zinc-500">
                       <Sparkles size={20} />
                    </div>
               </div>
               <div className="flex items-center pt-2 pl-8">
                 <span className="text-sm text-zinc-500 flex items-center gap-2">
                    {t('chat.thinking')} <Loader2 size={14} className="animate-spin" />
                 </span>
               </div>
             </div>
        )}

        {/* Bottom Spacer - larger when banner is shown */}
        <div className={clsx("w-full", topBanner ? "h-56" : "h-32")} ref={endRef} />
      </div>

      {/* Input Area */}
      <div className="absolute bottom-0 left-0 right-0 z-10 pb-safe">
        <div className="absolute bottom-0 left-0 right-0 h-40 bg-gradient-to-t from-background via-background/95 to-transparent pointer-events-none" />

        <div className={clsx("max-w-4xl mx-auto pb-6 relative", isMobile ? "px-2" : "px-4")}>
          {topBanner}
          {/* Controls Row (Plan toggle) */}
          <div className="flex items-center justify-between mb-2 px-2">
            <div className="flex items-center gap-2">
              <Tooltip content={t('tooltips.plan')}>
                <button
                  type="button"
                  onClick={() => onPlanEnabledChange(!planEnabled)}
                  className={clsx(
                    "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-all select-none",
                    "backdrop-blur-md shadow-sm",
                    planEnabled
                      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25 hover:bg-emerald-500/15 hover:border-emerald-500/35"
                      : "bg-zinc-900/60 text-zinc-400 border-white/10 hover:bg-zinc-900/80 hover:border-white/20"
                  )}
                  disabled={inputDisabled}
                >
                  <span
                    className={clsx(
                      "w-2 h-2 rounded-full",
                      planEnabled ? "bg-emerald-400" : "bg-zinc-500"
                    )}
                  />
                  <span>{t('chat.plan')}</span>
                </button>
              </Tooltip>

              <Tooltip content={t('tooltips.proMode')}>
                <button
                  type="button"
                  onClick={() => onProModeEnabledChange?.(!proModeEnabled)}
                  className={clsx(
                    "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all duration-500 select-none relative overflow-hidden group",
                    proModeEnabled
                      ? "bg-indigo-600/20 text-indigo-300 border-indigo-500/40 shadow-[0_0_15px_-3px_rgba(99,102,241,0.3)]"
                      : "bg-zinc-900/60 text-zinc-500 border-white/5 hover:border-white/10"
                  )}
                  disabled={inputDisabled}
                >
                  {proModeEnabled && (
                    <span className="absolute inset-0 bg-gradient-to-r from-indigo-600/0 via-white/5 to-indigo-600/0 translate-x-[-100%] group-hover:animate-[shimmer_2s_infinite] pointer-events-none" />
                  )}
                  <Zap 
                    size={13} 
                    className={clsx("transition-transform duration-500", {
                      "fill-indigo-400 text-indigo-400 scale-110 drop-shadow-[0_0_8px_rgba(129,140,248,0.8)]": proModeEnabled,
                      "text-zinc-600": !proModeEnabled
                    })} 
                  />
                  <span className={clsx(proModeEnabled ? "text-indigo-200" : "text-zinc-500")}>
                    {t('chat.proMode')}
                  </span>
                </button>
              </Tooltip>
            </div>
            {!isMobile && (
              <div className="text-[10px] text-zinc-500 font-mono tracking-widest uppercase opacity-60">
                Ctrl+Alt+S
              </div>
            )}
          </div>

          <AnimatePresence>
            {attachments.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, y: 20, height: 0 }}
                className="flex gap-3 pb-3 overflow-x-auto custom-scrollbar pl-1"
              >
                {attachments.map((att, i) => renderAttachmentPreview(att, i))}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="relative group bg-zinc-900/80 backdrop-blur-xl border border-white/10 rounded-[28px] shadow-2xl transition-all hover:border-white/20 focus-within:border-blue-500/30 focus-within:ring-4 focus-within:ring-blue-500/10 overflow-hidden">
            <div className="flex items-center gap-1 p-1.5">
                <Tooltip content={t('tooltips.attach')} position="bottom">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={clsx(
                        "p-3 text-zinc-400 hover:text-white transition-colors flex-shrink-0",
                        isMobile ? "" : "hover:bg-white/10 rounded-2xl"
                    )}
                    disabled={inputDisabled}
                  >
                    <Paperclip size={20} />
                  </button>
                </Tooltip>
                <input
                  type="file"
                  multiple
                  ref={fileInputRef}
                  className="hidden"
                  onChange={handleFileSelect}
                />

                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={t('chat.placeholder')}
                  rows={1}
                  disabled={inputDisabled}
                  className="flex-1 bg-transparent border-none focus:ring-0 text-white placeholder:text-zinc-500 resize-none max-h-[200px] py-3 px-2 custom-scrollbar leading-relaxed font-medium outline-none"
                />

                <Tooltip 
                  content={
                    isStreaming 
                      ? t('tooltips.sendDisabledStreaming') 
                      : (!input.trim() && attachments.length === 0)
                        ? t('tooltips.sendDisabledEmpty')
                        : t('tooltips.send')
                  }
                >
                  <button
                    onClick={handleSend}
                    disabled={inputDisabled || (!input.trim() && attachments.length === 0) || isStreaming}
                    className={clsx(
                        "p-3 rounded-2xl flex-shrink-0 transition-all duration-300 ease-out",
                        inputDisabled || (!input.trim() && attachments.length === 0) || isStreaming
                          ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                          : "bg-white text-black hover:scale-105 hover:shadow-[0_0_20px_-5px_rgba(255,255,255,0.3)] active:scale-95"
                    )}
                  >
                    <Send size={18} className={clsx({ "ml-0.5": true })} />
                  </button>
                </Tooltip>
            </div>

            {/* Progressive Loading Bar at bottom of input if needed */}
             {isStreaming && (
                 <div className="absolute bottom-0 left-0 h-[2px] bg-blue-500/50 animate-pulse w-full" />
             )}
          </div>

          <div className="text-center mt-3 flex justify-center gap-4 opacity-40 hover:opacity-100 transition-opacity duration-500">
             <p className="text-[10px] text-zinc-500 font-mono tracking-widest uppercase">
                {t('chat.version')}
             </p>
          </div>
        </div>
      </div>
    </div>
  );
};
