import { useCallback, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Sparkles } from 'lucide-react'
import { useAuth } from '@clerk/clerk-react'
import { useTranslation } from 'react-i18next'
import { useMobile } from '../hooks/useMobile'
import { BottomSheet } from './BottomSheet'

export function TopUpModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const isMobile = useMobile()
  const { getToken } = useAuth()
  const [amount, setAmount] = useState(200)
  const safeAmount = useMemo(() => Math.max(10, Math.floor(Number(amount) || 0)), [amount])
  const [isPaying, setIsPaying] = useState(false)

  const navigate = useCallback((to: string) => {
    try {
      window.history.pushState({}, '', to)
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch {
      window.location.href = to
    }
  }, [])

  const authedFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const token = await getToken()
      if (!token) throw new Error('Not authenticated')
      const headers = new Headers(init.headers || {})
      headers.set('Authorization', `Bearer ${token}`)
      return fetch(input, { ...init, headers })
    },
    [getToken]
  )

  const startTopUpPayment = useCallback(async () => {
    try {
      setIsPaying(true)
      const res = await authedFetch('/api/payments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'topup', amountRub: safeAmount })
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || t('common.error'))

      const paymentId = json?.paymentId
      const token = json?.confirmationToken
      if (!paymentId || !token) throw new Error(t('common.error'))

      onClose()
      navigate(`/payment?kind=topup&paymentId=${encodeURIComponent(paymentId)}&token=${encodeURIComponent(token)}`)
    } finally {
      setIsPaying(false)
    }
  }, [authedFetch, navigate, onClose, safeAmount, t])

  const topUpContent = (
    <div className="space-y-5">
      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
        <div className="text-xs font-medium uppercase tracking-widest text-zinc-400">{t('topUp.amountLabel')}</div>
        <div className="mt-2 flex items-center gap-3">
          <input
            type="number"
            min={10}
            value={amount}
            onChange={e => setAmount(Number(e.target.value))}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/40 focus:ring-4 focus:ring-cyan-500/10"
          />
          <div className="shrink-0 text-sm font-semibold text-white">₽</div>
        </div>
        <div className="mt-2 text-[11px] text-zinc-500">{t('topUp.minimumLabel')}</div>
      </div>

      <div className="flex gap-2 justify-end">
        <button
          onClick={onClose}
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white hover:bg-white/10"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={startTopUpPayment}
          disabled={isPaying}
          className="rounded-xl bg-white px-4 py-2 text-xs font-semibold text-black hover:bg-zinc-200 disabled:opacity-60 disabled:cursor-not-allowed flex-1 sm:flex-none"
        >
          {isPaying ? t('topUp.paying') : t('topUp.pay')}
        </button>
      </div>
    </div>
  )

  if (isMobile) {
    return (
      <BottomSheet isOpen={isOpen} onClose={onClose}>
        <div className="mb-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 backdrop-blur-md">
            <Sparkles size={14} className="opacity-80" />
            {t('topUp.title')}
          </div>
          <div className="mt-3 text-lg font-semibold text-white">{t('topUp.subtitle')}</div>
          <div className="mt-1 text-sm text-zinc-400">
            {t('topUp.description')}
          </div>
        </div>
        {topUpContent}
      </BottomSheet>
    )
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[24px]"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 10 }}
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-5 shadow-2xl backdrop-blur-xl"
          >
            <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-cyan-300/40 via-fuchsia-200/40 to-white/30" />

            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 backdrop-blur-md">
                  <Sparkles size={14} className="opacity-80" />
                  {t('topUp.title')}
                </div>
                <div className="mt-3 text-lg font-semibold text-white">{t('topUp.subtitle')}</div>
                <div className="mt-1 text-sm text-zinc-400">
                  {t('topUp.description')}
                </div>
              </div>
              <button
                onClick={onClose}
                className="rounded-xl border border-white/10 bg-white/5 p-2 text-zinc-300 hover:bg-white/10"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-5">
              {topUpContent}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}


