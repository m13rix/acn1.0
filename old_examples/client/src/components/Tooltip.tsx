import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  delay?: number;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export const Tooltip: React.FC<TooltipProps> = ({ 
  content, 
  children, 
  delay = 400,
  position = 'top'
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<any>(null);

  const handleMouseEnter = () => {
    timerRef.current = setTimeout(() => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setCoords({
          x: rect.left + rect.width / 2,
          y: position === 'bottom' ? rect.bottom : rect.top
        });
        setIsVisible(true);
      }
    }, delay);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const getAnimationProps = () => {
    const offset = 8; // Отступ от элемента
    switch (position) {
      case 'bottom':
        return {
          initial: { opacity: 0, y: -4, x: '-50%', scale: 0.95 },
          animate: { opacity: 1, y: offset, x: '-50%', scale: 1 },
          exit: { opacity: 0, y: -4, x: '-50%', scale: 0.95 },
          style: { top: coords.y + offset, left: coords.x }
        };
      case 'top':
      default:
        return {
          initial: { opacity: 0, y: 4, x: '-50%', scale: 0.95 },
          animate: { opacity: 1, y: `calc(-100% - ${offset}px)`, x: '-50%', scale: 1 },
          exit: { opacity: 0, y: 4, x: '-50%', scale: 0.95 },
          style: { top: coords.y, left: coords.x }
        };
    }
  };

  return (
    <div 
      ref={triggerRef} 
      className="inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isVisible && createPortal(
        <AnimatePresence>
          <motion.div
            {...getAnimationProps()}
            className="fixed z-[9999] px-3 py-1.5 bg-zinc-900 text-white text-[12px] font-medium rounded-lg border border-white/10 shadow-2xl pointer-events-none max-w-[240px] text-center leading-tight whitespace-normal backdrop-blur-md"
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {content}
            {/* Arrow */}
            <div 
              className={`absolute left-1/2 -translate-x-1/2 w-2 h-2 bg-zinc-900 border-r border-b border-white/10 rotate-45 ${
                position === 'bottom' ? '-top-1 border-l border-t border-r-0 border-b-0' : '-bottom-1'
              }`}
            />
          </motion.div>
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
};

