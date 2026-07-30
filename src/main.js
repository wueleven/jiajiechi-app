import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import './assets/global.css'

import IndexPage from './pages/index/index.vue'
import BindPage from './pages/bind/bind.vue'
import SyncPage from './pages/sync/sync.vue'
import HistoryPage from './pages/history/history.vue'

const routes = [
  { path: '/', redirect: '/index' },
  { path: '/index', component: IndexPage, meta: { title: '首页', isTab: true } },
  { path: '/sync', component: SyncPage, meta: { title: '同步', isTab: true } },
  { path: '/history', component: HistoryPage, meta: { title: '记录', isTab: true } },
  { path: '/bind', component: BindPage, meta: { title: '账号绑定' } },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

const app = createApp(App)
app.use(router)
app.mount('#app')
