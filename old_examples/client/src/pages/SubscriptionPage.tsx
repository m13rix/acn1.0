import { useCallback, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Crown, Sparkles, Zap, Shield } from 'lucide-react'
import { useAuth } from '@clerk/clerk-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useMobile } from '../hooks/useMobile'

type PeriodOption = { key: string; label: string; days: number }
type PlanType = 'trial' | 'standard' | 'custom'

export function SubscriptionPage() {
  const { t } = useTranslation()
  const isMobile = useMobile()
  const { getToken } = useAuth()
  
  // State
  const [selectedPlan, setSelectedPlan] = useState<PlanType>('standard')
  const [customPrice, setCustomPrice] = useState(300)
  const [customPeriodKey, setCustomPeriodKey] = useState<string>('month')
  const [isPaying, setIsPaying] = useState(false)

  // Navigation helper (preserved from original)
  const navigate = useCallback((to: string) => {
    try {
      window.history.pushState({}, '', to)
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch {
      window.location.href = to
    }
  }, [])

  // Auth helper
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

  const PERIODS: PeriodOption[] = useMemo(() => [
    { key: 'day', label: t('subscription.day'), days: 1 },
    { key: 'week', label: t('subscription.week'), days: 7 },
    { key: 'month', label: t('subscription.month'), days: 30 },
    { key: 'halfYear', label: t('subscription.halfYear'), days: 180 },
    { key: 'year', label: t('subscription.year'), days: 365 }
  ], [t])

  const customPeriod = useMemo(
    () => PERIODS.find(p => p.key === customPeriodKey) || PERIODS[2],
    [customPeriodKey, PERIODS]
  )

  const safeCustomPrice = Math.max(100, Math.floor(Number(customPrice) || 0))

  const handlePayment = async () => {
    let planData: { planType: 'standard' | 'trial' | 'custom'; priceRub: number; periodDays: number }

    if (selectedPlan === 'trial') {
      planData = { planType: 'trial', priceRub: 100, periodDays: 7 }
    } else if (selectedPlan === 'standard') {
      planData = { planType: 'standard', priceRub: 500, periodDays: 30 }
    } else {
      planData = {
        planType: 'custom',
        priceRub: safeCustomPrice,
        periodDays: customPeriod.days
      }
    }

    try {
      setIsPaying(true)
      const res = await authedFetch('/api/payments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'subscription', ...planData })
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || t('common.error'))

      const paymentId = json?.paymentId
      const token = json?.confirmationToken
      if (!paymentId || !token) throw new Error(t('common.error'))

      navigate(`/payment?kind=subscription&paymentId=${encodeURIComponent(paymentId)}&token=${encodeURIComponent(token)}`)
    } catch (e) {
      console.error(e)
      // Optional: Show error toast here
    } finally {
      setIsPaying(false)
    }
  }

  const getPriceDisplay = () => {
    if (selectedPlan === 'trial') return '100 ₽'
    if (selectedPlan === 'standard') return '500 ₽'
    return `${safeCustomPrice} ₽`
  }

  const getPeriodDisplay = () => {
    if (selectedPlan === 'trial') return t('subscription.perWeek') // " / week"
    if (selectedPlan === 'standard') return t('subscription.perMonth') // " / month"
    return ` / ${customPeriod.label.toLowerCase()}`
  }

  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-white/20 selection:text-white">
      {/* Subtle Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-violet-900/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/10 blur-[120px] rounded-full" />
      </div>

      <div className={clsx("relative max-w-6xl mx-auto px-6 py-8 flex flex-col items-center justify-center min-h-screen", isMobile ? "pt-12 pb-24" : "lg:py-12")}>
        
        {/* Header */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className={clsx("text-center max-w-2xl", isMobile ? "mb-8" : "mb-16")}
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-sm text-zinc-400 mb-4 backdrop-blur-sm">
            <Sparkles size={14} />
            <span>{t('subscription.subscriptionAndCredits')}</span>
          </div>
          <h1 className={clsx("font-bold tracking-tight mb-3 bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent", isMobile ? "text-2xl" : "text-3xl sm:text-4xl")}>
            {t('subscription.mainTitle')}
          </h1>
          <p className="text-base text-zinc-400 leading-relaxed">
            {t('subscription.mainSubtitle')}
          </p>
        </motion.div>

        {/* Plans Grid */}
        <div className={clsx(
            "w-full grid gap-6 mb-16",
            isMobile ? "grid-cols-1" : "lg:grid-cols-3"
        )}>
          
          {/* Trial Plan */}
          <PlanCard
            title={t('subscription.testTitle')}
            price="100 ₽"
            period={t('subscription.perWeek')}
            description={t('subscription.testSubtitle')}
            isSelected={selectedPlan === 'trial'}
            onClick={() => setSelectedPlan('trial')}
            icon={<Zap className="text-blue-400" />}
          />

          {/* Standard Plan (Recommended) */}
          <PlanCard
            title={t('subscription.standardTitle')}
            price="500 ₽"
            period={t('subscription.perMonth')}
            description={t('subscription.standardSubtitle')}
            isSelected={selectedPlan === 'standard'}
            onClick={() => setSelectedPlan('standard')}
            recommended
            icon={<Crown className="text-amber-400" />}
          />

          {/* Custom Plan */}
          <div 
            className={clsx(
              "relative rounded-3xl p-5 transition-all duration-300 cursor-pointer border backdrop-blur-sm group",
              selectedPlan === 'custom' 
                ? "bg-zinc-900/80 border-white ring-1 ring-white/20 shadow-2xl shadow-purple-500/10 scale-[1.02]" 
                : "bg-zinc-900/40 border-white/10 hover:border-white/20 hover:bg-zinc-900/60"
            )}
            onClick={() => setSelectedPlan('custom')}
          >
            <div className="flex justify-between items-start mb-4">
              <div className="p-2.5 rounded-2xl bg-white/5 border border-white/10">
                <Shield className="text-violet-400" size={20} />
              </div>
              <div className={clsx(
                "w-5 h-5 rounded-full border flex items-center justify-center transition-colors",
                selectedPlan === 'custom' ? "bg-white border-white" : "border-white/20 bg-transparent"
              )}>
                {selectedPlan === 'custom' && <Check size={12} className="text-black" />}
              </div>
            </div>

            <div className="mb-2">
              <h3 className="text-lg font-semibold text-white">{t('subscription.custom')}</h3>
              <p className="text-xs text-zinc-400 mt-1">{t('subscription.customSub')}</p>
            </div>

            {/* Controls */}
            <div className="mt-6 space-y-4">
              <div>
                <label className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-2 block">
                  {t('subscription.price')}
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min={100}
                    value={customPrice}
                    onChange={e => {
                      setCustomPrice(Number(e.target.value))
                      if (selectedPlan !== 'custom') setSelectedPlan('custom')
                    }}
                    className="w-full bg-zinc-950 border border-white/10 rounded-xl py-3 pl-4 pr-10 text-white focus:outline-none focus:border-violet-500/50 transition-colors placeholder:text-zinc-600"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 font-medium pointer-events-none">₽</div>
                </div>
                <div className="mt-1.5 text-[10px] text-zinc-600">
                  {t('subscription.minimumPrice')}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-2 block">
                  {t('subscription.period')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {PERIODS.slice(0, 3).map(p => (
                    <PeriodButton 
                      key={p.key} 
                      active={p.key === customPeriodKey}
                      onClick={() => {
                        setCustomPeriodKey(p.key)
                        if (selectedPlan !== 'custom') setSelectedPlan('custom')
                      }}
                    >
                      {p.label}
                    </PeriodButton>
                  ))}
                  {/* Expanded periods if needed, or keeping it compact */}
                  <div className="col-span-3 grid grid-cols-2 gap-2 mt-0">
                     {PERIODS.slice(3).map(p => (
                      <PeriodButton 
                        key={p.key} 
                        active={p.key === customPeriodKey}
                        onClick={() => {
                          setCustomPeriodKey(p.key)
                          if (selectedPlan !== 'custom') setSelectedPlan('custom')
                        }}
                      >
                        {p.label}
                      </PeriodButton>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Bottom Action */}
        <motion.div 
          className={clsx("w-full max-w-md", isMobile ? "fixed bottom-0 left-0 right-0 p-4 bg-black/80 backdrop-blur-xl border-t border-white/5 z-20" : "")}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <button
            onClick={handlePayment}
            disabled={isPaying}
            className="w-full relative group overflow-hidden rounded-2xl bg-white text-black py-3 px-6 text-base font-bold shadow-2xl transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-violet-200/50 to-blue-200/50 opacity-0 group-hover:opacity-100 transition-opacity" />
            <span className="relative flex items-center justify-center gap-2">
              {isPaying ? (
                <>
                  <Sparkles className="animate-spin" size={18} />
                  {t('subscription.creatingPayment')}
                </>
              ) : (
                <>
                  {t('subscription.chooseAndPay')}
                  {!isMobile && (
                    <span className="ml-1 opacity-60 font-normal text-sm">
                      {getPriceDisplay()} {selectedPlan === 'custom' ? `/ ${customPeriod.label.toLowerCase()}` : getPeriodDisplay()}
                    </span>
                  )}
                </>
              )}
            </span>
          </button>
          {!isMobile && (
            <p className="text-center text-[10px] text-zinc-600 mt-3">
               {t('subscription.redirectNote')}
            </p>
          )}
        </motion.div>
        
      </div>
    </div>
  )
}

function PlanCard({
  title,
  price,
  period,
  description,
  isSelected,
  onClick,
  recommended,
  icon
}: {
  title: string
  price: string
  period: string
  description: string
  isSelected: boolean
  onClick: () => void
  recommended?: boolean
  icon: React.ReactNode
}) {
  return (
    <div 
      onClick={onClick}
      className={clsx(
        "relative rounded-3xl p-5 transition-all duration-300 cursor-pointer border backdrop-blur-sm flex flex-col h-full",
        isSelected 
          ? "bg-zinc-900/80 border-white ring-1 ring-white/20 shadow-2xl shadow-blue-500/10 scale-[1.02] z-10" 
          : "bg-zinc-900/40 border-white/10 hover:border-white/20 hover:bg-zinc-900/60"
      )}
    >
      {recommended && (
        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 bg-white text-black text-[9px] font-bold uppercase tracking-wider rounded-full shadow-lg shadow-white/10">
          Recommended
        </div>
      )}

      <div className="flex justify-between items-start mb-4">
        <div className="p-2.5 rounded-2xl bg-white/5 border border-white/10">
          {icon}
        </div>
        <div className={clsx(
          "w-5 h-5 rounded-full border flex items-center justify-center transition-colors",
          isSelected ? "bg-white border-white" : "border-white/20 bg-transparent"
        )}>
          {isSelected && <Check size={12} className="text-black" />}
        </div>
      </div>

      <div className="mb-3">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{description}</p>
      </div>

      <div className="mt-auto pt-5 border-t border-white/5">
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold text-white">{price}</span>
          <span className="text-zinc-500 text-xs">{period}</span>
        </div>
      </div>
    </div>
  )
}

function PeriodButton({ children, active, onClick }: { children: React.ReactNode, active: boolean, onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={clsx(
        "py-2 px-3 rounded-lg text-xs font-semibold transition-all border",
        active 
          ? "bg-white text-black border-white shadow-sm" 
          : "bg-transparent text-zinc-400 border-white/10 hover:bg-white/5 hover:border-white/20"
      )}
    >
      {children}
    </button>
  )
}
