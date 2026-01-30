import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { SignInButton, SignUpButton } from '@clerk/clerk-react'
import { ArrowRight, Shield, User, Zap, Sparkles, Layout, BrainCircuit } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'

import feature1 from '../assets/feature1.png'
import feature2 from '../assets/feature2.png'
import feature3 from '../assets/feature3.png'
import feature4 from '../assets/feature4.png'
import { useMobile } from '../hooks/useMobile'

const FEATURES = [
  { 
    id: 1, 
    image: feature1, 
    icon: Sparkles,
    labelKey: 'feature1Title',
  },
  { 
    id: 2, 
    image: feature2, 
    icon: Layout,
    labelKey: 'feature2Title',
  },
  { 
    id: 3, 
    image: feature3, 
    icon: BrainCircuit,
    labelKey: 'feature3Title',
  },
  { 
    id: 4, 
    image: feature4, 
    icon: Zap,
    labelKey: 'feature4Title',
  },
]

export function LandingPage() {
  const { t, i18n } = useTranslation()
  const isMobile = useMobile()
  const [activeFeature, setActiveFeature] = useState(0)

  // Auto-rotate features
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveFeature((prev) => (prev + 1) % FEATURES.length)
    }, 6000)
    return () => clearInterval(interval)
  }, [])

  const renderTitle = () => {
    const title = t('landing.title')
    const highlightPatterns = {
      en: /(the rest of us)/i,
      ru: /(для каждого)/i
    }
    
    const pattern = i18n.language.startsWith('ru') ? highlightPatterns.ru : highlightPatterns.en
    const match = title.match(pattern)
    
    if (match) {
      const parts = title.split(pattern)
      return (
        <>
          {parts.map((part, index) => {
            if (part.toLowerCase() === match[0].toLowerCase()) {
              return (
                <span
                  key={index}
                  className="animate-gradient bg-gradient-to-r from-white via-violet-400 to-cyan-400 bg-clip-text text-transparent inline-block"
                  style={{
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundImage: 'linear-gradient(90deg, #fff, #a78bfa, #22d3ee, #a78bfa, #fff)',
                    backgroundSize: '200% auto'
                  }}
                >
                  {part}
                </span>
              )
            }
            return <span key={index}>{part}</span>
          })}
        </>
      )
    }
    
    return title
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 selection:bg-white/20">
      {/* Background Grid Pattern */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]">
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-transparent" />
      </div>

      {/* Header / Nav Placeholder (Optional, for structure) */}
      <header className={clsx("relative z-10 mx-auto flex max-w-7xl items-center justify-between py-6", isMobile ? "px-4" : "px-6")}>
        <div className="flex items-center gap-2 font-medium tracking-tight">
          <Sparkles size={isMobile ? 20 : 24} className="text-white" />
          <span className={clsx(isMobile && "text-sm")}>Telos Spark</span>
        </div>
        <div className="flex gap-2 sm:gap-4 text-sm font-medium">
          <SignInButton mode="modal">
            <button className="text-zinc-400 hover:text-white transition-colors px-2 py-2">
              {t('landing.signIn')}
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button className="rounded-md bg-white px-3 py-2 sm:px-4 text-black hover:bg-zinc-200 transition-colors text-xs sm:text-sm">
              {t('landing.createAccount')}
            </button>
          </SignUpButton>
        </div>
      </header>

      <main className={clsx("relative z-10 mx-auto max-w-7xl pb-24 pt-16 sm:pt-24", isMobile ? "px-4" : "px-6")}>
        {/* Hero Section */}
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
             <h1 className={clsx("font-semibold tracking-tight text-white text-balance", isMobile ? "text-3xl" : "text-4xl sm:text-6xl")}>
               {renderTitle()}
             </h1>
            <p className={clsx("mt-6 leading-8 text-zinc-400 text-pretty", isMobile ? "text-base" : "text-lg")}>
              {t('landing.subtitle')}
            </p>

            <div className="mt-10 flex items-center justify-center gap-x-6">
              <SignInButton mode="modal">
                <button className="group relative inline-flex items-center gap-2 overflow-hidden rounded-lg bg-white px-8 py-3 font-semibold text-zinc-950 transition-all hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 focus:ring-offset-zinc-950">
                  {t('landing.signIn')}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </button>
              </SignInButton>
            </div>
          </motion.div>
        </div>

        {/* Feature Showcase (The "Monitor" View) */}
        <div className="mt-24 space-y-8">
          {/* Feature Tabs */}
          <div className={clsx(
              "flex items-center gap-2 sm:gap-4 no-scrollbar",
              isMobile ? "overflow-x-auto pb-4 -mx-4 px-4 justify-start" : "flex-wrap justify-center"
          )}>
            {FEATURES.map((feature, index) => {
              const isActive = activeFeature === index
              const Icon = feature.icon
              return (
                <button
                  key={feature.id}
                  onClick={() => setActiveFeature(index)}
                  className={`group flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-all flex-shrink-0 ${
                    isActive
                      ? 'border-white/20 bg-white/10 text-white shadow-sm'
                      : 'border-transparent text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
                  }`}
                >
                  <Icon size={16} className={isActive ? 'text-white' : 'text-zinc-500'} />
                  <span className="whitespace-nowrap">{t(`landing.${feature.labelKey}`)}</span>
                </button>
              )
            })}
          </div>

          {/* Browser Window Container */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            className={clsx(
                "relative mx-auto w-full max-w-5xl overflow-hidden border border-white/10 bg-zinc-900 shadow-2xl",
                isMobile ? "aspect-[4/5] rounded-xl" : "aspect-[16/10] rounded-xl sm:rounded-2xl"
            )}
          >
            {/* Window Header */}
            <div className="absolute inset-x-0 top-0 z-20 flex h-10 items-center border-b border-white/5 bg-zinc-900/90 px-4 backdrop-blur-sm">
              <div className="flex gap-2">
                <div className="h-3 w-3 rounded-full bg-red-500/20" />
                <div className="h-3 w-3 rounded-full bg-yellow-500/20" />
                <div className="h-3 w-3 rounded-full bg-green-500/20" />
              </div>
              <div className="mx-auto text-xs font-medium text-zinc-500 opacity-50">
                Telos Spark Intelligence
              </div>
            </div>

            {/* Image Area */}
            <div className="relative h-full w-full pt-10">
              <AnimatePresence mode="popLayout">
                <motion.div
                  key={activeFeature}
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.02 }}
                  transition={{ duration: 0.4 }}
                  className="absolute inset-0 top-10 h-[calc(100%-2.5rem)] w-full"
                >
                  {/* Using object-cover with object-top ensures we see the header/main UI and crop bottom if needed, 
                      but never crop sides horizontally unless extreme aspect ratio */}
                  <img
                    src={FEATURES[activeFeature].image}
                    alt="Feature Preview"
                    className="h-full w-full bg-zinc-950 object-cover object-top"
                  />
                  {/* Subtle fade at bottom to blend if image is long */}
                  <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-zinc-900 via-zinc-900/20 to-transparent" />
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>

          {/* Feature Description Text (Dynamic) */}
          <div className="mx-auto max-w-2xl text-center">
             <AnimatePresence mode="wait">
                <motion.p
                  key={activeFeature}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className={clsx("text-zinc-400", isMobile ? "text-base" : "text-lg")}
                >
                  {t(`landing.${FEATURES[activeFeature].labelKey.replace('Title', 'Body')}`)}
                </motion.p>
             </AnimatePresence>
          </div>
        </div>

        {/* Info Grid */}
        <div className="mx-auto mt-32 max-w-5xl">
          <div className={clsx("grid gap-8 lg:gap-16", isMobile ? "grid-cols-1" : "grid-cols-2")}>
            <div className="flex flex-col gap-4 rounded-2xl border border-white/5 bg-white/[0.02] p-8 transition-colors hover:bg-white/[0.04]">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800 text-white">
                <Shield size={20} />
              </div>
              <h3 className="text-xl font-semibold text-white">{t('landing.privateTitle')}</h3>
              <p className="text-base leading-relaxed text-zinc-400">
                {t('landing.privateBody')}
              </p>
            </div>
            <div className="flex flex-col gap-4 rounded-2xl border border-white/5 bg-white/[0.02] p-8 transition-colors hover:bg-white/[0.04]">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800 text-white">
                <User size={20} />
              </div>
              <h3 className="text-xl font-semibold text-white">{t('landing.profileTitle')}</h3>
              <p className="text-base leading-relaxed text-zinc-400">
                {t('landing.profileBody')}
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Simple Footer */}
      <footer className="border-t border-white/5 bg-zinc-950 py-12">
        <div className="mx-auto max-w-7xl px-6 text-center text-sm text-zinc-600">
          <p>&copy; {new Date().getFullYear()} Telos Spark. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}
