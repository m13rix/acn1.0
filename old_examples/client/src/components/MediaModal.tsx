import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useMobile } from '../hooks/useMobile';

interface MediaModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: {
    url: string;
    type: string;
    name: string;
  } | null;
}

export const MediaModal: React.FC<MediaModalProps> = ({ isOpen, onClose, file }) => {
  const { t } = useTranslation();
  const isMobile = useMobile();
  if (!file) return null;

  const isImage = file.type.startsWith('image/');
  const isPDF = file.type === 'application/pdf';

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          />

          {/* Modal Content */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", duration: 0.5, bounce: 0.3 }}
            className={clsx(
                "relative z-10 w-full flex flex-col bg-zinc-900 overflow-hidden shadow-2xl border border-white/10",
                isMobile ? "h-full rounded-none" : "max-w-5xl max-h-[90vh] rounded-2xl"
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-zinc-900/50">
              <h3 className="text-sm font-medium text-zinc-200 truncate max-w-[70%]">
                {file.name}
              </h3>
              <div className="flex items-center gap-2">
                <a 
                  href={file.url} 
                  download={file.name}
                  className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                  title={t('mediaModal.download')}
                >
                  <Download size={18} />
                </a>
                <button
                  onClick={onClose}
                  className="p-2 text-zinc-400 hover:text-white hover:bg-red-500/20 hover:text-red-500 rounded-full transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-hidden flex items-center justify-center bg-black/50 p-1 pb-safe">
              {isImage && (
                <img 
                  src={file.url} 
                  alt={file.name} 
                  className={clsx(
                      "max-w-full max-h-[80vh] object-contain rounded",
                      isMobile && "max-h-full"
                  )}
                />
              )}
              
              {isPDF && (
                <iframe 
                  src={file.url} 
                  className="w-full h-[80vh] rounded bg-white" 
                  title={file.name}
                />
              )}

              {!isImage && !isPDF && (
                <div className="text-center py-20">
                  <div className="mb-4 text-zinc-500">{t('mediaModal.previewNotAvailable')}</div>
                  <a 
                    href={file.url} 
                    target="_blank" 
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white text-black rounded-lg hover:bg-zinc-200 transition-colors"
                  >
                    <ExternalLink size={16} />
                    {t('mediaModal.openInNewTab')}
                  </a>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

