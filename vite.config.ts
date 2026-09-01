import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { wrapperProofPlugin } from './proof/server/viteWrapperProofPlugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), wrapperProofPlugin()],
})
