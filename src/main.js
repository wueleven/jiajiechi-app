import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { SplashScreen } from '@capacitor/splash-screen'
import App from './App.vue'
import './assets/global.css'
import { setupKeyboardHandler } from './utils/keyboard.js'

import IndexPage from './pages/index/index.vue'
import BindPage from './pages/bind/bind.vue'
import SyncPage from './pages/sync/sync.vue'
import HistoryPage from './pages/history/history.vue'
import AboutPage from './pages/about/about.vue'
import PbPage from './pages/pb/pb.vue'

const routes = [
  { path: '/', redirect: '/index' },
  { path: '/index', component: IndexPage, meta: { title: '首页', isTab: true } },
  { path: '/sync', component: SyncPage, meta: { title: '同步', isTab: true } },
  { path: '/history', component: HistoryPage, meta: { title: '记录', isTab: true } },
  { path: '/bind', component: BindPage, meta: { title: '账号绑定' } },
  { path: '/about', component: AboutPage, meta: { title: '关于佳捷驰' } },
  // 隐藏彩蛋页：仅通过关于页连点作者名进入，不暴露任何入口
  { path: '/pb', component: PbPage, meta: { title: '隐藏成就' } },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

const app = createApp(App)
app.use(router)

// 全局键盘适配：键盘弹出时调整 fixed 弹窗布局（依赖 Manifest 的 adjustResize）
setupKeyboardHandler()

// 首页渲染完成后再隐藏原生启动屏，避免启动时白屏
// （launchAutoHide 已设为 false，由这里手动关闭；web 端调用无副作用）
router.isReady().then(() => {
  app.mount('#app')
  requestAnimationFrame(() => {
    SplashScreen.hide({ fadeOutDuration: 200 }).catch(() => {})
  })
})
