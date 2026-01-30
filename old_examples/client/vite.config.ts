import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, // Vite dev server порт
    proxy: {
      '/api': {
        target: 'http://localhost:1314', // Backend API порт
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:1314', // Backend WebSocket порт
        ws: true,
      }
    }
  }
})
