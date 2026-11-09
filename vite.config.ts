import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// SHA corto del commit desplegado (Vercel lo expone al hacer build). En local: "dev".
const build = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __LUMON_BUILD__: JSON.stringify(build) },
})
