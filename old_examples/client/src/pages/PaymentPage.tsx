import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Info, ShieldCheck, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMobile } from '../hooks/useMobile'
import clsx from 'clsx'

declare global {
  interface Window {
    YooMoneyCheckoutWidget?: any
  }
}

function getQuery() {
  try {
    return new URLSearchParams(window.location.search)
  } catch {
    return new URLSearchParams()
  }
}

function loadYooKassaWidgetScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (window.YooMoneyCheckoutWidget) return Promise.resolve()

  const existing = document.querySelector('script[data-yookassa-widget="true"]') as HTMLScriptElement | null
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Failed to load YooKassa widget script')), { once: true })
    })
  }

  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://yookassa.ru/checkout-widget/v1/checkout-widget.js'
    s.async = true
    s.dataset.yookassaWidget = 'true'
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load YooKassa widget script'))
    document.head.appendChild(s)
  })
}

export function PaymentPage() {
  const { t } = useTranslation()
  const isMobile = useMobile()
  const query = useMemo(() => getQuery(), [])
  const confirmationToken = query.get('token') || ''
  const paymentId = query.get('paymentId') || ''
  const kind = (query.get('kind') || '').toLowerCase()

  const returnUrl = useMemo(() => {
    try {
      const url = new URL('/payment/result', window.location.origin)
      if (paymentId) url.searchParams.set('paymentId', paymentId)
      return url.toString()
    } catch {
      return '/payment/result'
    }
  }, [paymentId])

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let checkout: any = null
    let cancelled = false

    async function init() {
      try {
        setStatus('loading')
        setError(null)

        if (!confirmationToken) {
          setStatus('error')
          setError(t('payment.noTokenError'))
          return
        }

        await loadYooKassaWidgetScript()
        if (cancelled) return

        if (!window.YooMoneyCheckoutWidget) {
          setStatus('error')
          setError(t('payment.widgetError'))
          return
        }

        checkout = new window.YooMoneyCheckoutWidget({
          confirmation_token: confirmationToken,
          return_url: returnUrl,
          customization: {
            colors: {
              control_primary: '#a78bfa',
              background: '#0a0a12'
            }
          },
          error_callback: function (e: any) {
            // Widget errors are often non-fatal; show them explicitly just in case
            console.error('[yookassa-widget]', e)
          }
        })

        await checkout.render('payment-form')
        if (cancelled) return

        setStatus('ready')
      } catch (e: any) {
        if (cancelled) return
        setStatus('error')
        setError(e?.message || t('payment.initError'))
      }
    }

    init()

    return () => {
      cancelled = true
      try {
        if (checkout?.destroy) checkout.destroy()
      } catch {
        // ignore
      }
    }
  }, [confirmationToken, returnUrl])

  const title =
    kind === 'topup' ? t('payment.titleTopup') : kind === 'subscription' ? t('payment.titleSubscription') : t('payment.titleDefault')

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-gradient-to-br from-white/10 via-fuchsia-500/10 to-cyan-400/10 blur-3xl" />
        <div className="absolute -bottom-32 -left-32 h-[520px] w-[520px] rounded-full bg-gradient-to-tr from-cyan-400/10 via-violet-500/10 to-white/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(255,255,255,0.10),transparent_60%)]" />
      </div>

      <div className={clsx("relative mx-auto flex min-h-screen max-w-6xl flex-col justify-center py-16", isMobile ? "px-4" : "px-6")}>
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          className="mx-auto w-full"
        >
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-zinc-200 backdrop-blur-md">
            <Sparkles size={14} className="opacity-80" />
            <span className="tracking-wide">Checkout</span>
          </div>

          <div className={clsx("grid gap-10 lg:gap-12", isMobile ? "grid-cols-1" : "grid-cols-12")}>
            <div className={isMobile ? "" : "lg:col-span-5"}>
              <h1 className={clsx("text-balance font-semibold leading-tight tracking-tight text-white", isMobile ? "text-3xl" : "text-4xl sm:text-5xl")}>
                {title}
              </h1>
              <p className="mt-5 max-w-xl text-pretty text-sm leading-relaxed text-zinc-300 sm:text-base">
                {t('payment.description')}
              </p>

              <div className="mt-8 space-y-3">
                <InfoRow
                  icon={<ShieldCheck size={16} />}
                  label={t('payment.securityLabel')}
                  value={t('payment.securityValue')}
                />
                <InfoRow
                  icon={<Info size={16} />}
                  label={t('payment.feeLabel')}
                  value={t('payment.feeValue')}
                />
              </div>

              {!!paymentId && (
                <div className="mt-6 text-xs text-zinc-500">
                  Payment ID: <span className="font-mono text-zinc-400">{paymentId}</span>
                </div>
              )}
            </div>

            <div className={isMobile ? "" : "lg:col-span-7"}>
              <div className={clsx(
                  "relative overflow-hidden border border-white/10 bg-white/5 shadow-2xl backdrop-blur-xl",
                  isMobile ? "rounded-2xl p-4" : "rounded-3xl p-6"
              )}>
                <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-cyan-300/40 via-fuchsia-200/40 to-white/30" />

                {status !== 'ready' && (
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-300">
                    {status === 'loading' ? t('payment.loadingForm') : null}
                    {status === 'error' ? (
                      <div className="text-red-300">
                        {error || t('payment.loadError')}
                      </div>
                    ) : null}
                  </div>
                )}

                {/* Container required by YooKassa widget */}
                <div id="payment-form" className="mt-4" />
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}

function InfoRow({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
      <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-widest text-zinc-400">
        <span className="rounded-xl border border-white/10 bg-white/5 p-2 text-white/90">{icon}</span>
        {label}
      </div>
      <div className="text-sm font-semibold text-white">{value}</div>
    </div>
  )
}


