/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#050505", // Slightly off-black for depth
        foreground: "#ffffff",
        muted: "#111111",
        "muted-foreground": "#888888",
        accent: "#ffffff",
        "accent-foreground": "#000000",
        border: "#222222",
        primary: "#ffffff",
        secondary: "#333333",
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        'glow': '0 0 20px rgba(255, 255, 255, 0.15)',
        'subtle': '0 1px 2px 0 rgba(255, 255, 255, 0.05)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 2s infinite',
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      typography: {
        DEFAULT: {
          css: {
            '--tw-prose-body': '#d4d4d8',
            '--tw-prose-headings': '#ffffff',
            '--tw-prose-links': '#60a5fa',
            '--tw-prose-bold': '#ffffff',
            '--tw-prose-code': '#e879f9',
            '--tw-prose-pre-bg': '#0a0a0a',
            '--tw-prose-quotes': '#a1a1aa',
            '--tw-prose-quote-borders': '#3f3f46',
          },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}

