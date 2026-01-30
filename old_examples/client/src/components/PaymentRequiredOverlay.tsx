import { motion, AnimatePresence } from 'framer-motion'
import { CreditCard } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function PaymentRequiredOverlay({
  isOpen,
  onGoToSubscription
}: {
  isOpen: boolean
  onGoToSubscription: () => void
}) {
  const { t } = useTranslation()
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-md"
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            className="relative mx-4 w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur-xl"
          >
            <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-cyan-300/40 via-fuchsia-200/40 to-white/30" />
            <div className="flex items-start gap-3">
              <div className="rounded-xl border border-white/10 bg-black/20 p-2 text-white/90">
                <CreditCard size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold text-white">{t('paymentRequired.title')}</div>
                <div className="mt-1 text-sm leading-relaxed text-zinc-300">
                  {t('paymentRequired.body')}
                </div>
                <button
                  onClick={onGoToSubscription}
                  className="mt-5 inline-flex w-full items-center justify-center rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-black shadow-lg transition-all hover:bg-zinc-200 active:scale-[0.99]"
                >
                  {t('paymentRequired.selectPlan')}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}


