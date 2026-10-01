import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'

// 前端应用入口：注册 UI 组件库和路由，再挂载到 index.html 的 #app 节点。
const app = createApp(App)

// 将 Element Plus 的内置按钮、空状态和日期文案统一设为简体中文。
app.use(ElementPlus, { locale: zhCn })
app.use(router)

app.mount('#app')
