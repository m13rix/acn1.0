import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, XCircle, Loader2, ArrowLeft, Sparkles } from 'lucide-react'
import { useAuth } from '@clerk/clerk-react'
import { useTranslation } from 'react-i18next'

type PaymentStatusResponse = {
  paymentId: string
  status?: string
  paid?: boolean
  applied?: boolean
  result?: any
  error?: string
}

function getQuery() {
  try {
    return new URLSearchParams(window.location.search)
  } catch {
    return new URLSearchParams()
  }
}

export function PaymentResultPage({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const { getToken } = useAuth()

  const query = useMemo(() => getQuery(), [])
  const paymentId = query.get('paymentId') || ''

  const [data, setData] = useState<PaymentStatusResponse | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

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

  const refresh = useCallback(async () => {
    try {
      setState('loading')
      setError(null)

      if (!paymentId) {
        setState('error')
        setError(t('paymentResult.noPaymentId'))
        return
      }

      const res = await authedFetch(`/api/payments/${encodeURIComponent(paymentId)}/status`)
      const json = (await res.json()) as PaymentStatusResponse

      if (!res.ok) {
        setState('error')
        setError(json?.error || t('paymentResult.statusError'))
        return
      }

      setData(json)
      // If applied=true, server already activated subscription/topup
      if (json?.applied) {
        setState('done')
      } else if (json?.status === 'succeeded' && json?.paid) {
        // Safety: even if not applied flag, treat as done
        setState('done')
      } else if (json?.status === 'pending') {
        setState('idle')
      } else {
        setState('idle')
      }
    } catch (e: any) {
      setState('error')
      setError(e?.message || t('paymentResult.statusError'))
    }
  }, [authedFetch, paymentId, t])

  // First check + polling while pending
  useEffect(() => {
    let t: number | null = null
    let cancelled = false

    async function run() {
      await refresh()
      if (cancelled) return

      // Poll only while we don't have an applied result
      t = window.setInterval(() => {
        refresh()
      }, 2500)
    }

    run()

    return () => {
      cancelled = true
      if (t) window.clearInterval(t)
    }
  }, [refresh])

  const ui = (() => {
    if (state === 'loading') {
      return {
        icon: <Loader2 className="animate-spin" size={20} />,
        title: t('paymentResult.checkingTitle'),
        body: t('paymentResult.checkingBody')
      }
    }
    if (state === 'done') {
      return {
        icon: <CheckCircle2 size={20} />,
        title: t('paymentResult.successTitle'),
        body: t('paymentResult.successBody')
      }
    }
    if (state === 'error') {
      return {
        icon: <XCircle size={20} />,
        title: t('paymentResult.errorTitle'),
        body: error || t('paymentResult.errorBody')
      }
    }
    if (data?.status === 'canceled') {
      return {
        icon: <XCircle size={20} />,
        title: t('paymentResult.cancelledTitle'),
        body: t('paymentResult.cancelledBody')
      }
    }
    return {
      icon: <Loader2 className="animate-spin" size={20} />,
      title: t('paymentResult.waitingTitle'),
      body: t('paymentResult.waitingBody')
    }
  })()

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-gradient-to-br from-white/10 via-fuchsia-500/10 to-cyan-400/10 blur-3xl" />
        <div className="absolute -bottom-32 -left-32 h-[520px] w-[520px] rounded-full bg-gradient-to-tr from-cyan-400/10 via-violet-500/10 to-white/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(255,255,255,0.10),transparent_60%)]" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          className="mx-auto w-full"
        >
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-zinc-200 backdrop-blur-md">
            <Sparkles size={14} className="opacity-80" />
            <span className="tracking-wide">{t('paymentResult.resultTitle')}</span>
          </div>

          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur-xl">
            <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-cyan-300/40 via-fuchsia-200/40 to-white/30" />

            <div className="flex items-start gap-3">
              <div className="rounded-xl border border-white/10 bg-black/20 p-2 text-white/90">
                {ui.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold text-white">{ui.title}</div>
                <div className="mt-1 text-sm leading-relaxed text-zinc-300">{ui.body}</div>

                {!!paymentId && (
                  <div className="mt-4 text-xs text-zinc-500">
                    Payment ID: <span className="font-mono text-zinc-400">{paymentId}</span>
                  </div>
                )}

                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    onClick={onDone}
                    className="inline-flex items-center gap-2 rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-black shadow-lg transition-all hover:bg-zinc-200 active:scale-[0.99]"
                  >
                    <ArrowLeft size={16} />
                    {t('paymentResult.backToApp')}
                  </button>
                  <button
                    onClick={refresh}
                    className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-white backdrop-blur-md transition-all hover:bg-white/10 active:scale-[0.99]"
                  >
                    {t('paymentResult.refreshStatus')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}


