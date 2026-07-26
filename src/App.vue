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
        <span class="tab-icon">{{ tab.icon }}</span>
        <span class="tab-label">{{ tab.label }}</span>
      </div>
    </nav>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'

const router = useRouter()
const route = useRoute()

const tabs = [
  { path: '/index', label: '首页', icon: '🏠' },
  { path: '/sync', label: '同步', icon: '↗️' },
  { path: '/history', label: '记录', icon: '📋' },
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
}

.tab-label {
  font-size: 11px;
}
</style>
