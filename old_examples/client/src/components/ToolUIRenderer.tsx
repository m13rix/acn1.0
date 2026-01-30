import React, { useRef, useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Clock, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { ToolUIState } from '../types';

interface ToolUIRendererProps {
  content: string;          // Main label (collapsed state)
  isFinished: boolean;
  duration?: number;
  uis: ToolUIState[];
  currentUIIndex: number;
  onNavigate?: (index: number) => void;
  onMessage?: (uiId: string, message: any) => void;
  isTrailing?: boolean;
}

export const ToolUIRenderer: React.FC<ToolUIRendererProps> = ({
  content,
  isFinished,
  duration,
  uis,
  currentUIIndex,
  onNavigate,
  onMessage,
  isTrailing = false
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentUI = uis[currentUIIndex];
  const hasMultipleUIs = uis.length > 1;
  
  // Auto-expand when UI content arrives (while not finished)
  useEffect(() => {
    if (currentUI && !isFinished) {
      setIsExpanded(true);
    }
  }, [currentUI, isFinished]);

  // Auto-collapse when finished
  useEffect(() => {
    if (isFinished && currentUI) {
      const timer = setTimeout(() => {
        setIsExpanded(false);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isFinished, currentUI]);

  // Listen for messages from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Security check - verify message origin
      if (event.data?.type === 'toolUI:message' && event.data?.uiId && onMessage) {
        onMessage(event.data.uiId, event.data.payload);
      }
      // Ready event listener (optional for now)
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onMessage, currentUI?.id]);

  // Send data updates to iframe
  useEffect(() => {
    if (iframeRef.current?.contentWindow && currentUI) {
       // Always send update when data changes
       // Even if iframe isn't fully "ready", postMessage is usually queued or handled if window exists
      iframeRef.current.contentWindow.postMessage({
        type: 'toolUI:update',
        uiId: currentUI.id,
        data: currentUI.data,
        isFinished
      }, '*');
    }
  }, [currentUI, isFinished]); // Re-run when currentUI (and its data) changes due to immutable update

  const handlePrev = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentUIIndex > 0 && onNavigate) {
      onNavigate(currentUIIndex - 1);
    }
  }, [currentUIIndex, onNavigate]);

  const handleNext = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentUIIndex < uis.length - 1 && onNavigate) {
      onNavigate(currentUIIndex + 1);
    }
  }, [currentUIIndex, uis.length, onNavigate]);

  const getDisplayLabel = () => {
    if (isFinished && isTrailing) return '';
    if (!currentUI) return content;
    return isFinished && currentUI.labelFinished 
      ? currentUI.labelFinished 
      : currentUI.label;
  };

  // Generate sandboxed iframe HTML
  // Memoized to prevent reloading when data changes
  const iframeContent = React.useMemo(() => {
    if (!currentUI) return '';
    
    // Inject base styles and message handler
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: transparent;
      color: #d4d4d8;
      overflow: hidden;
    }
    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(113, 113, 122, 0.3); border-radius: 2px; }
  </style>
</head>
<body>
  ${currentUI.html}
  <script>
    // Communication bridge with parent
    const toolUI = {
      id: '${currentUI.id}',
      // Initial data injection (only for first render)
      data: ${JSON.stringify(currentUI.data || {})},
      isFinished: ${isFinished},
      
      // Send message to parent (tool handler)
      send: function(payload) {
        window.parent.postMessage({
          type: 'toolUI:message',
          uiId: this.id,
          payload: payload
        }, '*');
      },
      
      // Update handler - called when parent sends data updates
      onUpdate: null
    };

    // Listen for updates from parent
    window.addEventListener('message', function(event) {
      if (event.data?.type === 'toolUI:update' && event.data.uiId === toolUI.id) {
        console.log('[ToolUI] Update received', event.data);
        toolUI.data = event.data.data || {};
        toolUI.isFinished = event.data.isFinished;
        if (typeof toolUI.onUpdate === 'function') {
          toolUI.onUpdate(toolUI.data, toolUI.isFinished);
        }
      }
    });

    // Expose to custom HTML
    window.toolUI = toolUI;

    // Notify parent that we are ready
    window.parent.postMessage({ type: 'toolUI:ready', uiId: toolUI.id }, '*');

    // Try to run onUpdate immediately with initial data if defined
    // Use setTimeout to let the script inside body define onUpdate first
    setTimeout(function() {
        if (typeof toolUI.onUpdate === 'function') {
            toolUI.onUpdate(toolUI.data, toolUI.isFinished);
        }
    }, 0);
  </script>
</body>
</html>`;
  }, [currentUI?.id, currentUI?.html]); // Dependencies: ONLY id and html. Data changes won't trigger regen.

  const canExpand = !!currentUI;

  return (
    <div className="flex flex-col gap-1">
      {/* Main Status Line */}
      <div
        className={clsx("flex items-center gap-2 group", {
          "cursor-pointer": canExpand
        })}
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
      >
        {!isFinished && (
          <Loader2 size={14} className="animate-spin text-cyan-400" />
        )}

        <span className={clsx("text-sm font-medium transition-colors", {
          "text-zinc-300": isFinished && !isTrailing,
          "text-emerald-400 font-semibold": isFinished && isTrailing,
          "text-cyan-200 animate-pulse": !isFinished
        })}>
          {getDisplayLabel()}
        </span>

        {/* Navigation indicator */}
        {hasMultipleUIs && (
          <span className="text-xs text-zinc-500 ml-1">
            ({currentUIIndex + 1}/{uis.length})
          </span>
        )}

        {/* Expand/Collapse button */}
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

        {isFinished && duration && (
          <div className="flex items-center gap-1 ml-auto pl-2 text-xs text-zinc-600 font-mono bg-black/20 px-1.5 py-0.5 rounded">
            <Clock size={10} />
            {(duration / 1000).toFixed(2)}s
          </div>
        )}
      </div>

      {/* Expandable UI Panel */}
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
              <div 
                ref={containerRef}
                className="relative rounded-lg overflow-hidden bg-zinc-900/30 border border-white/5"
              >
                {/* Navigation Arrows for Multiple UIs */}
                {hasMultipleUIs && isExpanded && (
                  <>
                    {/* Left Arrow */}
                    <button
                      onClick={handlePrev}
                      disabled={currentUIIndex === 0}
                      className={clsx(
                        "absolute left-2 top-1/2 -translate-y-1/2 z-20",
                        "w-8 h-8 rounded-full flex items-center justify-center",
                        "bg-zinc-800/80 backdrop-blur border border-white/10",
                        "transition-all duration-200",
                        currentUIIndex === 0
                          ? "opacity-30 cursor-not-allowed"
                          : "opacity-70 hover:opacity-100 hover:bg-zinc-700/80 hover:border-white/20"
                      )}
                    >
                      <ChevronLeft size={16} className="text-white" />
                    </button>

                    {/* Right Arrow */}
                    <button
                      onClick={handleNext}
                      disabled={currentUIIndex === uis.length - 1}
                      className={clsx(
                        "absolute right-2 top-1/2 -translate-y-1/2 z-20",
                        "w-8 h-8 rounded-full flex items-center justify-center",
                        "bg-zinc-800/80 backdrop-blur border border-white/10",
                        "transition-all duration-200",
                        currentUIIndex === uis.length - 1
                          ? "opacity-30 cursor-not-allowed"
                          : "opacity-70 hover:opacity-100 hover:bg-zinc-700/80 hover:border-white/20"
                      )}
                    >
                      <ChevronRight size={16} className="text-white" />
                    </button>

                    {/* Dot indicators */}
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex gap-1.5">
                      {uis.map((_, idx) => (
                        <button
                          key={idx}
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigate?.(idx);
                          }}
                          className={clsx(
                            "w-1.5 h-1.5 rounded-full transition-all duration-200",
                            idx === currentUIIndex
                              ? "bg-cyan-400 w-4"
                              : "bg-zinc-600 hover:bg-zinc-500"
                          )}
                        />
                      ))}
                    </div>
                  </>
                )}

                {/* iframe Content */}
                <iframe
                  ref={iframeRef}
                  srcDoc={iframeContent}
                  className="w-full border-0 bg-transparent"
                  style={{ 
                    height: currentUI?.height ? `${currentUI.height}px` : '200px',
                    minHeight: '100px'
                  }}
                  sandbox="allow-scripts"
                  title="Tool UI"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

