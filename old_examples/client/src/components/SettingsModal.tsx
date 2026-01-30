import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, User, CreditCard, Save, Plus, Globe } from 'lucide-react'
import { useUser } from '@clerk/clerk-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { UsageLimitsResponse } from '../types'
import { useMobile } from '../hooks/useMobile'
import { BottomSheet } from './BottomSheet'

export function SettingsModal({
  isOpen,
  onClose,
  usageLimits,
  onOpenTopUp,
}: {
  isOpen: boolean
  onClose: () => void
  usageLimits: UsageLimitsResponse | null
  onOpenTopUp: () => void
}) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobile()
  const { user } = useUser()
  const [userName, setUserName] = useState('')
  const [isSaved, setIsSaved] = useState(false)

  const handleLanguageChange = (lang: string) => {
    if (lang === 'auto') {
      i18n.changeLanguage(window.navigator.language.split('-')[0]);
      localStorage.removeItem('i18nextLng');
    } else {
      i18n.changeLanguage(lang);
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem('user.aiName')
    if (saved) {
      setUserName(saved)
    } else if (user?.firstName) {
      setUserName(user.firstName)
    }
  }, [user, isOpen])

  const handleSave = () => {
    localStorage.setItem('user.aiName', userName)
    setIsSaved(true)
    setTimeout(() => setIsSaved(false), 2000)
    window.dispatchEvent(new Event('settings-updated'))
  }

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  const dailyPct = usageLimits?.dailyPct ?? 0
  const totalLeftPct = usageLimits?.totalPctLeft ?? 0

  const settingsContent = (
    <div className={clsx("flex flex-col space-y-12", isMobile ? "pt-4" : "max-h-[70vh] overflow-y-auto px-8 py-8 custom-scrollbar")}>
      {/* 1. Usage & Credits Section */}
      <section className="space-y-6">
        <div className="flex items-center gap-2 text-white opacity-40">
          <CreditCard size={14} />
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">{t('settings.usage')}</h3>
        </div>

        <div className={clsx("flex items-center justify-between gap-8", isMobile && "flex-col items-stretch")}>
          {/* Left: Stacked Limits */}
          <div className="flex-1 space-y-5">
            <div className="space-y-2">
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-500">{t('settings.dailyUsage')}</span>
                <span className={`font-mono font-medium ${dailyPct >= 100 ? 'text-rose-500' : 'text-white'}`}>
                  {Math.round(dailyPct)}%
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/5">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, dailyPct)}%` }}
                  className={`h-full rounded-full transition-colors ${dailyPct >= 100 ? 'bg-rose-500' : 'bg-white'}`}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-500">{t('settings.totalRemaining')}</span>
                <span className="text-white font-mono font-medium">{Math.round(totalLeftPct)}%</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/5">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${totalLeftPct}%` }}
                  className="h-full rounded-full bg-white"
                />
              </div>
            </div>
          </div>

          {/* Right: Top Up Button */}
          <button
            onClick={() => {
              onClose()
              onOpenTopUp()
            }}
            className="flex shrink-0 items-center gap-2 justify-center rounded-xl bg-white px-4 py-2.5 text-xs font-bold text-black transition-all hover:bg-zinc-200 active:scale-95"
          >
            <Plus size={14} strokeWidth={3} />
            <span>{t('settings.topUp')}</span>
          </button>
        </div>
      </section>

      {/* 2. Identity Section */}
      <section className="space-y-6">
        <div className="flex items-center gap-2 text-white opacity-40">
          <User size={14} />
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">{t('settings.identity')}</h3>
        </div>

        <div className="space-y-3">
          <label className="block text-[11px] text-zinc-500 ml-1">
            {t('settings.addressLabel')}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder={t('settings.namePlaceholder')}
              className="flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-white placeholder-zinc-700 focus:border-white/20 focus:outline-none transition-all"
            />
            <button
              onClick={handleSave}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition-all active:scale-95 ${
                isSaved 
                  ? 'bg-emerald-500/10 text-emerald-500' 
                  : 'border border-white/10 text-white hover:bg-white/5'
              }`}
            >
              {isSaved ? t('common.saved') : <Save size={14} />}
            </button>
          </div>
        </div>
      </section>

      {/* 3. Language Section */}
      <section className="space-y-6">
        <div className="flex items-center gap-2 text-white opacity-40">
          <Globe size={14} />
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">{t('settings.language')}</h3>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {[
            { id: 'en', label: t('settings.en') },
            { id: 'ru', label: t('settings.ru') }
          ].map((lang) => (
            <button
              key={lang.id}
              onClick={() => handleLanguageChange(lang.id)}
              className={clsx(
                "flex items-center justify-center gap-2 rounded-xl py-3 text-xs font-medium transition-all border",
                i18n.language.startsWith(lang.id)
                  ? "bg-white/10 border-white/20 text-white"
                  : "bg-white/[0.02] border-white/5 text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
              )}
            >
              {lang.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => handleLanguageChange('auto')}
          className={clsx(
            "w-full flex items-center justify-center gap-2 rounded-xl py-3 text-[10px] font-bold uppercase tracking-wider transition-all border",
            !localStorage.getItem('i18nextLng')
              ? "bg-white/10 border-white/20 text-white"
              : "bg-white/[0.02] border-white/5 text-zinc-400 hover:bg-white/5 hover:text-zinc-300"
          )}
        >
          {t('settings.autoLanguage')}
        </button>
      </section>
    </div>
  )

  if (isMobile) {
    return (
      <BottomSheet isOpen={isOpen} onClose={onClose}>
        <div className="mb-6">
          <h2 className="text-xl font-bold tracking-tight text-white">{t('settings.title')}</h2>
          <p className="text-sm text-zinc-500">{t('settings.subtitle')}</p>
        </div>
        {settingsContent}
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
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onMouseDown={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            onMouseDown={(e) => e.stopPropagation()}
            className="relative mx-4 w-full max-w-lg overflow-hidden rounded-[2rem] border border-white/10 bg-zinc-950 shadow-2xl"
          >
            {/* Header */}
            <div className="relative flex items-center justify-between border-b border-white/5 px-8 py-6">
              <div>
                <h2 className="text-lg font-medium tracking-tight text-white">{t('settings.title')}</h2>
                <p className="text-xs text-zinc-500">{t('settings.subtitle')}</p>
              </div>
              <button
                onClick={onClose}
                className="rounded-full p-2 text-zinc-500 transition-colors hover:text-white"
              >
                <X size={20} />
              </button>
            </div>

            {settingsContent}

            <div className="border-t border-white/5 bg-black/50 px-8 py-4 text-center">
              <p className="text-[9px] uppercase tracking-widest text-zinc-600 font-medium">
                {t('settings.internalConfig')}
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
