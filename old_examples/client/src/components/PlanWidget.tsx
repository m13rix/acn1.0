import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useMobile } from '../hooks/useMobile';
import type { Todo } from '../types';
import { CheckCircle2, Circle, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

interface PlanWidgetProps {
  todos: Todo[];
}

export const PlanWidget: React.FC<PlanWidgetProps> = ({ todos }) => {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [isExpanded, setIsExpanded] = React.useState(!isMobile);
  const completedCount = todos.filter(t => t.completed).length;
  const progress = (completedCount / todos.length) * 100;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={clsx(
          "bg-zinc-900/60 border border-white/10 rounded-xl overflow-hidden backdrop-blur-md shadow-sm",
          isMobile ? "w-full" : "max-w-md"
      )}
    >
      <div 
        className="px-4 py-2 bg-white/5 border-b border-white/5 flex items-center justify-between cursor-pointer"
        onClick={() => isMobile && setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300 uppercase tracking-wider">
          <span>{t('chat.executionPlan')}</span>
          {isMobile && (
            <motion.div
              animate={{ rotate: isExpanded ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronDown size={14} className="text-zinc-500" />
            </motion.div>
          )}
        </div>
        <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-zinc-500">
                {Math.round(progress)}%
            </span>
            <div className="w-16 h-1 bg-zinc-800 rounded-full overflow-hidden">
                <motion.div 
                className="h-full bg-emerald-500" 
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.5 }}
                />
            </div>
        </div>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div 
            initial={isMobile ? { height: 0, opacity: 0 } : false}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="p-2 flex flex-col gap-1 overflow-hidden"
          >
            {todos.map((todo, i) => (
              <div 
                key={i} 
                className={clsx("flex items-start gap-3 p-2 rounded-lg transition-all text-sm", {
                  "opacity-40": todo.completed,
                  "bg-white/5": !todo.completed && i === completedCount // Highlight current
                })}
              >
                <div className={clsx("mt-0.5 flex-shrink-0", {
                  "text-emerald-500": todo.completed,
                  "text-zinc-600": !todo.completed
                })}>
                  {todo.completed ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                </div>
                <span className={clsx("leading-tight", {
                  "line-through text-zinc-500": todo.completed,
                  "text-zinc-200": !todo.completed
                })}>
                  {todo.task}
                </span>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
