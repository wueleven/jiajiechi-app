<template>
  <div class="version-info" @click="goAbout">关于佳捷驰 · 版本 {{ appVersion }}</div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import pkg from '../../package.json'

const router = useRouter()

// 版本号：真机读安卓 versionName（已含 v 前缀，与 APK 一致），网页环境回退到 package.json 并补 v
const appVersion = ref(`v${pkg.version}`)
async function loadAppVersion() {
  if (!Capacitor.isNativePlatform()) return
  try {
    const info = await App.getInfo()
    if (info?.version) appVersion.value = info.version
  } catch (e) {
    console.warn('读取版本号失败:', e)
  }
}

onMounted(loadAppVersion)

function goAbout() { router.push('/about') }
</script>

<style scoped>
.version-info {
  text-align: center; font-size: 12px; color: #bbb;
  padding: 8px 0 2px; cursor: pointer;
}
</style>
