import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { SignIn, SignUp } from '@clerk/clerk-react'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'

type AuthMode = 'sign-in' | 'sign-up'

function getModeFromLocation(): AuthMode {
  try {
    const url = new URL(window.location.href)
    const mode = (url.searchParams.get('mode') || '').toLowerCase()
    return mode === 'sign-up' || mode === 'signup' ? 'sign-up' : 'sign-in'
  } catch {
    return 'sign-in'
  }
}

export function AuthPage() {
  const { t } = useTranslation()
  const mode = useMemo(() => getModeFromLocation(), [])

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(255,255,255,0.08),transparent_60%)]" />
        <div className="absolute -top-24 right-[-120px] h-[520px] w-[520px] rounded-full bg-gradient-to-br from-fuchsia-500/10 via-white/10 to-cyan-400/10 blur-3xl" />
        <div className="absolute -bottom-40 left-[-140px] h-[520px] w-[520px] rounded-full bg-gradient-to-tr from-cyan-400/10 via-violet-500/10 to-white/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-6xl items-center px-6 py-12">
        <div className="grid w-full grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-5">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: 'easeOut' }}
              className="max-w-md"
            >
              <button
                onClick={() => window.history.back()}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 backdrop-blur-md transition-colors hover:bg-white/10"
              >
                <ArrowLeft size={16} />
                {t('common.back')}
              </button>

              <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                {mode === 'sign-up' ? t('auth.createAccount') : t('auth.welcomeBack')}
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-zinc-300">
                {mode === 'sign-up'
                  ? t('auth.signUpSub')
                  : t('auth.signInSub')}
              </p>

              <div className="mt-8 space-y-3 text-sm text-zinc-400">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md">
                  <div className="text-white/90 font-medium">{t('auth.stableIdTitle')}</div>
                  <div className="mt-1">{t('auth.stableIdBody')}</div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md">
                  <div className="text-white/90 font-medium">{t('auth.chatHistoryTitle')}</div>
                  <div className="mt-1">{t('auth.chatHistoryBody')}</div>
                </div>
              </div>
            </motion.div>
          </div>

          <div className="lg:col-span-7">
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.55, ease: 'easeOut', delay: 0.05 }}
              className="mx-auto w-full max-w-xl overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-4 shadow-2xl backdrop-blur-xl"
            >
              <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-cyan-300/40 via-fuchsia-200/40 to-white/30" />

              <div className="flex items-center justify-between px-2 pb-4 pt-2">
                <div className="text-sm font-semibold text-white">
                  {mode === 'sign-up' ? t('auth.signUp') : t('auth.signIn')}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <a
                    href="/auth?mode=sign-in"
                    className={`rounded-lg px-3 py-1.5 transition-colors ${
                      mode === 'sign-in'
                        ? 'bg-white text-black'
                        : 'border border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10'
                    }`}
                  >
                    {t('auth.signIn')}
                  </a>
                  <a
                    href="/auth?mode=sign-up"
                    className={`rounded-lg px-3 py-1.5 transition-colors ${
                      mode === 'sign-up'
                        ? 'bg-white text-black'
                        : 'border border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10'
                    }`}
                  >
                    {t('auth.signUp')}
                  </a>
                </div>
              </div>

              <div className="flex justify-center px-2 pb-4">
                {mode === 'sign-up' ? (
                  <SignUp routing="path" path="/auth" />
                ) : (
                  <SignIn routing="path" path="/auth" />
                )}
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  )
}


