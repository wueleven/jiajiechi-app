<template>
  <div class="app-container">
    <!-- 启动自动同步状态条 -->
    <div class="auto-sync-bar" v-if="autoSyncRunning">
      <span class="auto-sync-spinner"></span>
      <span>自动同步中…</span>
    </div>
    <div class="page-content">
      <router-view />
    </div>
    <nav class="tab-bar" v-if="showTabBar">
      <div
        v-for="tab in tabs"
        :key="tab.path"
        class="tab-item"
        :class="{ active: currentTab === tab.path }"
        @click="switchTab(tab.path)"
      >
        <span class="tab-icon"><img :src="tab.icon" alt="" /></span>
        <span class="tab-label">{{ tab.label }}</span>
      </div>
    </nav>
    <!-- 全局 Toast（自动同步结果提示） -->
    <div class="global-toast" v-if="toast.show">{{ toast.message }}</div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { runAutoSyncOnLaunch, setupResumeAutoSync, autoSyncRunning } from './services/autoSync.js'
import { setupBackButtonHandler } from './utils/backButton.js'
import tabHome from './assets/icons/tab-home.png'
import tabList from './assets/icons/tab-list.png'
import tabSync from './assets/icons/tab-sync.png'

const router = useRouter()
const route = useRoute()

const tabs = [
  { path: '/index', label: '首页', icon: tabHome },
  { path: '/sync', label: '同步', icon: tabSync },
  { path: '/history', label: '记录', icon: tabList },
]

const currentTab = computed(() => route.path)
const showTabBar = computed(() => route.meta.isTab !== false && route.path !== '/bind')

function switchTab(path) {
  router.push(path)
}

// ============ 启动自动同步 ============

const toast = ref({ show: false, message: '' })

let toastTimer = null
function showToast(msg) {
  toast.value = { show: true, message: msg }
  // 先取消上一条的关闭定时器，避免新提示被提前关掉
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value.show = false }, 3000)
}

// 自动同步结果提示（冷启动与长后台恢复共用）
function handleAutoSyncResult(res) {
  if (!res) return // 开关未开启或条件不满足，静默跳过

  if (res.success) {
    const d = res.data || {}
    // 有新活动同步成功或存在失败才提示，全部跳过保持静默
    if ((d.success || 0) > 0 || (d.failed || 0) > 0) {
      const failPart = d.failed ? ` · 失败 ${d.failed}` : ''
      showToast(`自动同步完成：成功 ${d.success || 0} · 跳过 ${d.skipped || 0}${failPart}`)
    }
  } else if (res.mfaRequired) {
    showToast('佳明需要验证码，请到同步页手动同步')
  } else if (res.message) {
    showToast(`自动同步失败：${res.message}`)
  }
}

onMounted(async () => {
  // 全局返回键/手势：非首页后退，首页"再按一次退出"（防误退）
  setupBackButtonHandler({
    router,
    onExitHint: () => showToast('再按一次返回键退出应用'),
  })

  // 长后台（超过 1 小时）切回前台时再次自动同步
  setupResumeAutoSync(handleAutoSyncResult)
  // 冷启动自动同步
  handleAutoSyncResult(await runAutoSyncOnLaunch())
})
</script>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: #f6f6f6;
}

.page-content {
  flex: 1;
  overflow-y: auto;
  /* 底部避让 tab 栏的留白由各页面 .page-container 自行负责，这里不再重复留白 */
}

.tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 56px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-around;
  border-top: 1px solid #e0e0e0;
  z-index: 999;
}

.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  color: #999;
  transition: color 0.2s;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.tab-item.active {
  color: #0052B9;
}

.tab-icon {
  font-size: 20px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tab-icon img {
  width: 22px;
  height: 22px;
  object-fit: contain;
  /* 未选中：深蓝线条转为浅灰，弱化显示 */
  filter: grayscale(1) brightness(1.6) opacity(0.55);
  transition: filter 0.2s, transform 0.2s;
}
.tab-item.active .tab-icon img {
  /* 选中：还原深蓝原色并轻微放大 */
  filter: none;
  transform: scale(1.08);
}

.tab-label {
  font-size: 11px;
}

.auto-sync-bar {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 6px;
  background: rgba(0, 82, 185, 0.92); color: #fff;
  padding: 6px 16px; border-radius: 20px; font-size: 12px;
  z-index: 1500; box-shadow: 0 2px 8px rgba(0, 82, 185, 0.3);
}
.auto-sync-spinner {
  width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.35);
  border-top-color: #fff; border-radius: 50%;
  animation: auto-sync-spin 1s linear infinite;
}
@keyframes auto-sync-spin { to { transform: rotate(360deg); } }

.global-toast {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: rgba(0,0,0,0.75); color: #fff; padding: 10px 24px;
  border-radius: 8px; font-size: 14px; z-index: 2000;
  max-width: 80%; text-align: center;
}
</style>
