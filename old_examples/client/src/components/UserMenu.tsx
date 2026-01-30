import { SignedIn, SignedOut, UserButton, useAuth, useUser } from '@clerk/clerk-react'
import { Settings, User, Zap, Wallet } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useMobile } from '../hooks/useMobile'
import type { UsageLimitsResponse } from '../types'

export function UserMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation()
  const isMobile = useMobile()
  const { user } = useUser()
  const { getToken, isSignedIn } = useAuth()
  const [limits, setLimits] = useState<UsageLimitsResponse | null>(null)

  useEffect(() => {
    let mounted = true
    const run = async () => {
      if (!isSignedIn) return
      try {
        const token = await getToken()
        if (!token) return
        const res = await fetch('/api/usage', {
          headers: { Authorization: `Bearer ${token}` }
        })
        const json = (await res.json()) as UsageLimitsResponse
        if (mounted) setLimits(json)
      } catch {
        // ignore
      }
    }
    run()
    const t = window.setInterval(run, 15_000)
    return () => {
      mounted = false
      window.clearInterval(t)
    }
  }, [getToken, isSignedIn])

  const dailyPct = useMemo(() => {
    const v = limits?.dailyPct
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    return Math.round(v)
  }, [limits?.dailyPct])

  const totalLeftPct = useMemo(() => {
    const v = limits?.totalPctLeft
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    return Math.max(0, Math.min(100, Math.round(v)))
  }, [limits?.totalPctLeft])

  return (
    <div className="relative">
      <SignedOut>
        <div className="flex flex-col gap-3 p-3 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center border border-white/5">
              <User size={20} className="text-zinc-500" />
            </div>
            <div className="text-xs font-medium text-zinc-400">{t('userMenu.notSignedIn')}</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <a
              href="/auth?mode=sign-in"
              className="flex items-center justify-center rounded-xl border border-white/10 bg-white/5 py-2 text-xs font-semibold text-zinc-200 transition-all hover:bg-white/10 active:scale-95"
            >
              {t('auth.signIn')}
            </a>
            <a
              href="/auth?mode=sign-up"
              className="flex items-center justify-center rounded-xl bg-white py-2 text-xs font-semibold text-black transition-all hover:bg-zinc-200 active:scale-95 shadow-[0_0_20px_rgba(255,255,255,0.1)]"
            >
              {t('auth.signUp')}
            </a>
          </div>
        </div>
      </SignedOut>

      <SignedIn>
        <div className={clsx(
            "group flex items-center gap-3 p-1.5 rounded-2xl border border-white/10 bg-zinc-900/40 backdrop-blur-xl shadow-2xl transition-all duration-300",
            isMobile ? "pl-2 pr-2" : "pl-2 hover:bg-zinc-900/60 hover:border-white/20"
        )}>
          <div className="relative flex-shrink-0">
            <UserButton 
              appearance={{
                elements: {
                  rootBox: "flex items-center justify-center",
                  userButtonTrigger: "rounded-xl overflow-hidden focus:ring-0 focus:outline-none focus:shadow-none transition-transform hover:scale-105",
                  userButtonAvatarBox: isMobile ? "w-8 h-8" : "w-9 h-9",
                }
              }}
            />
          </div>
          
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className={clsx("font-bold text-zinc-100 truncate", isMobile ? "text-[12px]" : "text-[13px]")}>
                {user?.fullName || user?.username || t('userMenu.account')}
              </span>
            </div>
            
            {!isMobile && (
              <div className="flex items-center gap-2 mt-0.5">
                <div className="flex-1 flex flex-col gap-1">
                  {/* Progress bars container */}
                  <div className="flex gap-1 items-center h-1">
                    <div 
                      className="h-full bg-indigo-500 rounded-full transition-all duration-700 ease-out shadow-[0_0_8px_rgba(99,102,241,0.4)]" 
                      style={{ width: `${dailyPct ?? 0}%` }}
                      title={dailyPct !== null ? t('userMenu.usageToday', { pct: dailyPct }) : t('userMenu.usageLoading')}
                    />
                    <div className="flex-1 h-full bg-white/5 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-emerald-500 rounded-full transition-all duration-700 ease-out shadow-[0_0_8px_rgba(16,185,129,0.4)]" 
                        style={{ width: `${totalLeftPct ?? 0}%` }}
                        title={totalLeftPct !== null ? t('userMenu.leftUntilPayment', { pct: totalLeftPct }) : t('userMenu.leftLoading')}
                      />
                    </div>
                  </div>
                  
                  {/* Text labels (very brief) */}
                  <div className="flex items-center justify-between text-[9px] font-medium tracking-tight uppercase">
                    <span className="text-zinc-500 flex items-center gap-0.5">
                      <Zap size={8} className="text-indigo-400" />
                      {dailyPct ?? '..'}%
                    </span>
                    <span className="text-zinc-500 flex items-center gap-0.5">
                      {totalLeftPct ?? '..'}%
                      <Wallet size={8} className="text-emerald-400" />
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <button 
            onClick={onOpenSettings}
            className={clsx(
                "rounded-xl text-zinc-500 hover:text-white transition-all duration-200 active:scale-90",
                isMobile ? "p-2" : "p-2.5 hover:bg-white/10"
            )}
            title={t('common.settings')}
          >
            <Settings size={isMobile ? 16 : 18} />
          </button>
        </div>
      </SignedIn>
    </div>
  )
}


