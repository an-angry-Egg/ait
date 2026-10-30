import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mockApi } from './server/mock-api'
import ait from '@ait/vite-plugin'

// ait() 用于本地直接 `pnpm dev` 时也能看到 data-ait 注入。
// 通过 `npx ait` 启动时由本地桥追加同名插件，插件内部会去重，不会注入两次。
export default defineConfig({
  plugins: [vue(), mockApi(), ait()],
  server: {
    port: 5173,
    strictPort: false
  }
})
