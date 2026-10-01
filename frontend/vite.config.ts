import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 启用 Vue 单文件组件编译，并导出 Vite 开发与生产构建配置。
export default defineConfig({
  plugins: [vue()],
})
