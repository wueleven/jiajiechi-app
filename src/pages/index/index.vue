<template>
  <div class="page-container">
    <!-- 顶部品牌区域 -->
    <div class="header-section">
      <div class="header-brand">
        <img class="header-logo" :src="logoImg" alt="佳捷驰" />
        <div class="header-text">
          <div class="header-title">佳捷驰</div>
          <div class="header-desc">轻松同步你的佳明运动数据</div>
        </div>
      </div>
    </div>

    <!-- 账号绑定状态 -->
    <div class="card">
      <div class="section-title">账号绑定状态</div>

      <div class="account-item" @click="goBind" v-for="acc in accounts" :key="acc.key">
        <div class="account-left">
          <div class="account-icon" :class="acc.iconClass">{{ acc.letter }}</div>
          <div class="account-info">
            <div class="account-name">{{ acc.name }}</div>
            <div class="account-status">
              <span v-if="acc.bound" class="tag tag-success">已绑定</span>
              <span v-else class="tag tag-warning">未绑定</span>
              <span v-if="acc.bound" class="account-display">{{ acc.displayName }}</span>
            </div>
          </div>
        </div>
        <div class="arrow">›</div>
      </div>
    </div>

    <!-- 快捷操作 -->
    <div class="card">
      <div class="section-title">快捷操作</div>

      <div class="action-item" @click="goSync">
        <div class="action-icon"><img src="../../assets/icons/tab-sync.png" alt="" /></div>
        <div class="action-text">
          <div class="action-name">开始同步</div>
          <div class="action-desc">手动触发数据同步</div>
        </div>
        <div class="arrow">›</div>
      </div>

      <div class="action-item" @click="goHistory">
        <div class="action-icon"><img src="../../assets/icons/tab-list.png" alt="" /></div>
        <div class="action-text">
          <div class="action-name">同步记录</div>
          <div class="action-desc" v-if="lastSyncTime">上次同步: {{ lastSyncTime }}</div>
          <div class="action-desc" v-else>暂无同步记录</div>
        </div>
        <div class="arrow">›</div>
      </div>
    </div>

    <!-- 支持的同步方向 -->
    <div class="card">
      <div class="section-title">支持的同步方向</div>
      <div class="sync-triangle">
        <svg viewBox="0 0 300 220" class="triangle-svg">
          <defs>
            <marker id="arr-end" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="6" markerHeight="6" orient="auto" fill="#0052B9">
              <path d="M1,1 L9,5 L1,9Z"/>
            </marker>
            <marker id="arr-start" viewBox="0 0 10 10" refX="1" refY="5"
              markerWidth="6" markerHeight="6" orient="auto" fill="#0052B9">
              <path d="M9,1 L1,5 L9,9Z"/>
            </marker>
          </defs>

          <!-- 双向连接线 -->
          <line x1="150" y1="40" x2="70" y2="170"
            stroke="#bbb" stroke-width="1.5"
            marker-start="url(#arr-start)" marker-end="url(#arr-end)"/>
          <line x1="150" y1="40" x2="230" y2="170"
            stroke="#bbb" stroke-width="1.5"
            marker-start="url(#arr-start)" marker-end="url(#arr-end)"/>
          <line x1="70" y1="170" x2="230" y2="170"
            stroke="#bbb" stroke-width="1.5"
            marker-start="url(#arr-start)" marker-end="url(#arr-end)"/>

          <!-- 节点: Garmin 国服 (顶部) -->
          <foreignObject x="95" y="10" width="110" height="36">
            <div xmlns="http://www.w3.org/1999/xhtml" class="triangle-node garmin-cn">Garmin 国服</div>
          </foreignObject>

          <!-- 节点: Garmin 国际服 (左下) -->
          <foreignObject x="15" y="155" width="110" height="36">
            <div xmlns="http://www.w3.org/1999/xhtml" class="triangle-node garmin-global">Garmin 国际服</div>
          </foreignObject>

          <!-- 节点: COROS 高驰 (右下) -->
          <foreignObject x="175" y="155" width="110" height="36">
            <div xmlns="http://www.w3.org/1999/xhtml" class="triangle-node coros">COROS 高驰</div>
          </foreignObject>
        </svg>
      </div>
    </div>

    <!-- 版本号（点击进入关于页） -->
    <div class="version-info" @click="goAbout">关于佳捷驰 · 版本 v{{ appVersion }}</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { getBindInfo } from '../../services/storage.js'
import logoImg from '../../assets/logo.jpg'
import pkg from '../../../package.json'

const router = useRouter()

// 版本号：真机读安卓 versionName（与 APK 一致），网页环境回退到 package.json
const appVersion = ref(pkg.version)
async function loadAppVersion() {
  if (!Capacitor.isNativePlatform()) return
  try {
    const info = await App.getInfo()
    if (info?.version) appVersion.value = info.version
  } catch (e) {
    console.warn('读取版本号失败:', e)
  }
}

const bindStatus = ref({
  garminCn: { bound: false, displayName: '' },
  garminCom: { bound: false, displayName: '' },
  coros: { bound: false, displayName: '' },
})
const lastSyncTime = ref('')

const accounts = computed(() => [
  { key: 'garminCn', name: 'Garmin 国服', letter: 'G', iconClass: 'garmin-icon', ...bindStatus.value.garminCn },
  { key: 'garminCom', name: 'Garmin 国际服', letter: 'G', iconClass: 'garmin-global-icon', ...bindStatus.value.garminCom },
  { key: 'coros', name: 'COROS 高驰', letter: 'C', iconClass: 'coros-icon', ...bindStatus.value.coros },
])

function loadBindInfo() {
  const res = getBindInfo()
  if (res.success && res.data) {
    bindStatus.value = res.data
    lastSyncTime.value = res.data.lastSyncTime || ''
  }
}

onMounted(() => { loadBindInfo(); loadAppVersion() })
onActivated(loadBindInfo)

function goBind() { router.push('/bind') }
function goSync() { router.push('/sync') }
function goHistory() { router.push('/history') }
function goAbout() { router.push('/about') }
</script>

<style scoped>
.page-container { padding: 12px 16px; padding-bottom: 70px; }

.header-section {
  background: linear-gradient(135deg, #0052B9, #0073e6);
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 16px;
  color: #fff;
}
.header-brand { display: flex; align-items: center; gap: 14px; }
.header-logo {
  width: 48px; height: 48px; border-radius: 12px;
  object-fit: contain; flex-shrink: 0;
}
.header-title { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
.header-desc { font-size: 13px; opacity: 0.85; }

.account-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 0; border-bottom: 1px solid #f0f0f0; cursor: pointer;
}
.account-item:last-child { border-bottom: none; }
.account-left { display: flex; align-items: center; flex: 1; }
.account-icon {
  width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: bold; color: #fff; margin-right: 14px;
}
.garmin-icon { background: #00a3d9; }
.garmin-global-icon { background: #0052B9; }
.coros-icon { background: #F40000; }
.account-name { font-size: 14px; color: #333; margin-bottom: 4px; }
.account-status { display: flex; align-items: center; gap: 8px; }
.account-display { font-size: 12px; color: #999; }
.arrow { color: #ccc; font-size: 20px; }

.action-item {
  display: flex; align-items: center; padding: 14px 0; border-bottom: 1px solid #f0f0f0; cursor: pointer;
}
.action-item:last-child { border-bottom: none; }
.action-icon {
  width: 40px; height: 40px; background: #f0f5ff; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; margin-right: 14px;
}
.action-icon img {
  width: 22px; height: 22px; object-fit: contain;
  /* 白底变透明，仅保留深蓝线条，融入浅蓝圆角盒 */
  mix-blend-mode: multiply;
}
.action-text { flex: 1; }
.action-name { font-size: 14px; color: #333; font-weight: 500; margin-bottom: 3px; }
.action-desc { font-size: 12px; color: #999; }

.sync-triangle { display: flex; justify-content: center; padding: 8px 0; }
.triangle-svg { width: 100%; max-width: 240px; height: auto; }
.triangle-node {
  display: flex; align-items: center; justify-content: center;
  height: 36px; border-radius: 8px;
  font-size: 12px; font-weight: 500; color: #fff;
  white-space: nowrap;
}
.triangle-node.garmin-cn { background: #00a3d9; }
.triangle-node.garmin-global { background: #0052B9; }
.triangle-node.coros { background: #F40000; }

.version-info {
  text-align: center; font-size: 12px; color: #bbb;
  padding: 12px 0 4px; cursor: pointer;
}
</style>
