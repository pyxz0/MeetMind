import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 启用 Vue 单文件组件编译，并导出 Vite 开发与生产构建配置。
export default defineConfig({
  plugins: [vue()],

  server: {
    watch: {
      /**
       * 忽略工具产生的临时文件与目录。
       *
       * 部分编辑器 / 自动化工具保存文件时会先在同级建一个临时目录再原子替换。
       * Windows 下 chokidar 去 watch 这种刚被删除的临时文件会抛 EBUSY，
       * 而 Vite 对 watcher 的错误是直接退出进程（不会自愈），
       * 表现就是「改一次代码开发服务器就挂」。
       * 这里显式排除，避免开发服务器被临时文件打断。
       */
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmpdir/**',
        '**/*.tmp',
      ],
    },
  },
})
