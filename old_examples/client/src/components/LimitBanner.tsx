import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, CreditCard, Shield } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function LimitBanner({
  isOpen,
  title,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  variant = 'limit'
}: {
  isOpen: boolean
  title: string
  body: string
  primaryLabel: string
  onPrimary: () => void
  secondaryLabel?: string
  onSecondary?: () => void
  variant?: 'limit' | 'payment'
}) {
  const { t } = useTranslation()
  const Icon = variant === 'payment' ? CreditCard : AlertTriangle
  const Accent = variant === 'payment' ? Shield : AlertTriangle

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          className="mb-3 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-xl shadow-2xl"
        >
          <div className="flex items-start gap-3">
            <div className="rounded-xl border border-white/10 bg-black/20 p-2 text-white/90">
              <Icon size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div className="truncate text-sm font-semibold text-white">{title}</div>
                <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-200">
                  <span className="inline-flex items-center gap-1">
                    <Accent size={12} className="opacity-80" />
                    {variant === 'payment' ? t('limitBanner.payment') : t('limitBanner.limit')}
                  </span>
                </div>
              </div>
              <div className="mt-1 text-sm leading-relaxed text-zinc-300">{body}</div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={onPrimary}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-2 text-xs font-semibold text-black shadow-lg transition-all hover:bg-zinc-200 active:scale-[0.99]"
                >
                  {primaryLabel}
                </button>
                {secondaryLabel && onSecondary && (
                  <button
                    onClick={onSecondary}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white backdrop-blur-md transition-all hover:bg-white/10 active:scale-[0.99]"
                  >
                    {secondaryLabel}
                  </button>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}


