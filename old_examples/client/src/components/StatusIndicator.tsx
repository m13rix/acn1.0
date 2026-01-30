import React, { useRef, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Clock, ChevronDown, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import { useMobile } from '../hooks/useMobile';

interface StatusIndicatorProps {
  type: 'thought' | 'action' | 'switch' | 'context';
  content: string;
  isFinished: boolean;
  duration?: number;
  modelName?: string;
  reason?: string;
  reasoning?: string;
  isTrailing?: boolean;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  type,
  content,
  isFinished,
  duration,
  modelName,
  reason,
  reasoning,
  isTrailing = false
}) => {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [isExpanded, setIsExpanded] = useState(false);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const hasReasoning = reasoning && reasoning.trim().length > 0;

  // Auto-expand when reasoning starts coming in (while thinking)
  useEffect(() => {
    if (hasReasoning && !isFinished) {
      setIsExpanded(true);
    }
  }, [hasReasoning, isFinished]);

  // Auto-collapse when finished
  useEffect(() => {
    if (isFinished && hasReasoning) {
      // Small delay before collapsing for smoother UX
      const timer = setTimeout(() => {
        setIsExpanded(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isFinished, hasReasoning]);

  // Auto-scroll reasoning to bottom during streaming
  useEffect(() => {
    if (reasoningRef.current && !isFinished && isExpanded) {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight;
    }
  }, [reasoning, isFinished, isExpanded]);

  // Format model name: Remove "Company: " prefix if present
  const formatModelName = (name?: string) => {
    if (!name) return '';
    return name.replace(/^.*:\s*/, '');
  };

  const getDisplayText = () => {
    if (type === 'switch' && isFinished) return t('status.switchedTo', { model: formatModelName(modelName) });
    if (type === 'thought' && isFinished) return content;
    if (type === 'action' && isFinished && isTrailing) return '';
    return content;
  };

  const canExpand = type === 'thought' && hasReasoning;

  return (
    <div className="flex flex-col gap-1">
      {/* Main Status Line */}
      <div
        className={clsx("flex items-center gap-2 group", {
          "cursor-pointer": canExpand
        })}
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
      >
        {!isFinished && type !== 'context' && (
          <Loader2 size={14} className="animate-spin text-blue-400" />
        )}

        <span className={clsx("text-sm font-medium transition-colors", {
          "text-zinc-300": isFinished && !isTrailing,
          "text-emerald-400 font-semibold": isFinished && isTrailing && type === 'action',
          "text-blue-200 animate-pulse": !isFinished && type !== 'context',
          "text-purple-300": type === 'switch',
          "text-orange-300": type === 'context'
        })}>
          {getDisplayText()}
        </span>

        {/* Reasoning indicator */}
        {canExpand && (
          <motion.button
            initial={false}
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className={clsx(
              "p-0.5 rounded transition-colors ml-1",
              isExpanded
                ? "text-zinc-400"
                : "text-zinc-600 hover:text-zinc-400"
            )}
          >
            <ChevronDown size={14} />
          </motion.button>
        )}

        {/* Sparkle icon for reasoning */}
        {hasReasoning && !isExpanded && isFinished && (
          <Sparkles size={12} className="text-blue-400/40 ml-1" />
        )}

        {isFinished && duration && !isMobile && (
          <div className="flex items-center gap-1 ml-auto pl-2 text-xs text-zinc-600 font-mono bg-black/20 px-1.5 py-0.5 rounded">
            <Clock size={10} />
            {(duration / 1000).toFixed(2)}s
          </div>
        )}
      </div>

      {/* Reason / Description for Switch */}
      {type === 'switch' && reason && (
        <div className="text-xs text-zinc-500 font-mono mt-0.5 ml-1 border-l-2 border-purple-500/20 pl-2">
          {t('status.request')}: <span className="text-zinc-400 italic">"{reason}"</span>
        </div>
      )}

      {/* Action Detail */}
      {type === 'action' && isFinished && !isTrailing && (
        <div className="text-xs text-zinc-500 font-mono mt-1 truncate max-w-full opacity-60">
          {t('status.actionCompleted')}
        </div>
      )}

      {/* Chain-of-Thought Reasoning Panel */}
      <AnimatePresence initial={false}>
        {canExpand && (
          <motion.div
            initial={false}
            animate={{
              height: isExpanded ? 'auto' : 0,
              opacity: isExpanded ? 1 : 0
            }}
            transition={{
              height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
              opacity: { duration: 0.2, delay: isExpanded ? 0.1 : 0 }
            }}
            className="overflow-hidden"
          >
            <div className="pt-2 pb-1 pl-0">
              {/* 3D Drum Effect Container - Minimalist */}
              <div
                className={clsx(
                  "relative rounded-lg overflow-hidden",
                  // Removed background and borders for "integrated" feel
                  "bg-transparent",
                  // Removed amber border
                  // Removed shadow
                )}
              >
                {/* Scrollable Reasoning Content */}
                <div
                  ref={reasoningRef}
                  className={clsx(
                    "px-2 py-1 pl-0", // Reduced padding
                    "max-h-48 overflow-y-auto",
                    "custom-scrollbar",
                    "reasoning-drum-scroll"
                  )}
                  style={{
                    // Strong fade masks for 3D depth effect
                    maskImage: 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
                    WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)'
                  }}
                >
                  {/* Reasoning Text - Cooler colors, thinner font */}
                  <div className="reasoning-content text-xs text-zinc-500 leading-relaxed font-sans">
                    <ReactMarkdown
                      components={{
                        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                        strong: ({ children }) => <strong className="text-zinc-400 font-medium">{children}</strong>,
                        em: ({ children }) => <em className="text-zinc-500 italic">{children}</em>,
                        code: ({ children }) => (
                          <code className="bg-zinc-800/30 px-1 py-0.5 rounded text-zinc-400 text-[11px]">
                            {children}
                          </code>
                        ),
                        pre: ({ children }) => (
                          <pre className="bg-zinc-900/50 rounded-lg p-2 my-2 overflow-x-auto text-[11px] border border-white/5">
                            {children}
                          </pre>
                        ),
                        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
                        li: ({ children }) => <li className="text-zinc-500">{children}</li>,
                        h1: ({ children }) => <h1 className="text-sm font-medium text-zinc-400 mb-2">{children}</h1>,
                        h2: ({ children }) => <h2 className="text-sm font-medium text-zinc-400 mb-2">{children}</h2>,
                        h3: ({ children }) => <h3 className="text-xs font-medium text-zinc-400 mb-1">{children}</h3>,
                        blockquote: ({ children }) => (
                          <blockquote className="border-l-2 border-zinc-700 pl-3 my-2 text-zinc-600 italic">
                            {children}
                          </blockquote>
                        ),
                      }}
                    >
                      {reasoning}
                    </ReactMarkdown>

                    {/* Streaming cursor - Blue/Cool tone */}
                    {!isFinished && (
                      <span className="inline-block w-1.5 h-3 bg-blue-400/40 animate-pulse ml-0.5 align-middle rounded-sm" />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
