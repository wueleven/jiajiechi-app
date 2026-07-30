<template>
  <div class="app-container">
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
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
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
  padding-bottom: 60px;
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
</style>
