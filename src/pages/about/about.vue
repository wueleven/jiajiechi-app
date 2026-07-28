<template>
  <div class="page-container">
    <!-- 页面顶部：返回按钮 + 标题 -->
    <div class="page-header">
      <span class="back-btn" @click="goBack">‹</span>
      <span class="page-title">关于佳捷驰</span>
    </div>

    <!-- 应用信息 -->
    <div class="app-info">
      <img class="app-logo" :src="logoImg" alt="佳捷驰" />
      <div class="app-name">佳捷驰</div>
      <div class="app-version">版本 v{{ appVersion }}</div>
      <div class="app-author">作者：宵十一狼</div>
    </div>

    <!-- 应用简介 -->
    <div class="card">
      <div class="section-title">应用简介</div>
      <p class="text">
        佳捷驰是一款运动数据同步工具，帮助你在 Garmin（佳明）国服、Garmin 国际服与 COROS（高驰）三个平台之间自由互传运动记录，告别手动导出导入，随时随地保持多平台数据一致。
      </p>
    </div>

    <!-- 功能说明 -->
    <div class="card">
      <div class="section-title">功能说明</div>
      <ul class="feature-list">
        <li><span class="dot"></span>三平台全互联：佳明国服、佳明国际服、高驰之间任意方向双向同步</li>
        <li><span class="dot"></span>原始数据同步：以 FIT 原始文件传输，完整保留心率、轨迹、功率等运动细节</li>
        <li><span class="dot"></span>智能去重：自动识别目标平台已存在的活动并跳过，不产生重复记录</li>
        <li><span class="dot"></span>灵活同步：可选择同步方向与数量，并记住你的上次选择</li>
        <li><span class="dot"></span>同步记录：每条活动的同步结果（成功 / 跳过 / 失败）均可随时查看</li>
      </ul>
    </div>

    <!-- 数据与隐私 -->
    <div class="card">
      <div class="section-title">数据与隐私</div>
      <ul class="feature-list">
        <li><span class="dot"></span>本应用不设任何中间服务器，不收集、不上传你的任何个人信息</li>
        <li><span class="dot"></span>平台账号、密码及登录凭证仅加密保存在本机，用于登录各平台官方服务器及凭证过期后自动续期</li>
        <li><span class="dot"></span>运动数据仅在你的手机与各平台官方服务器之间直接传输</li>
        <li><span class="dot"></span>解除绑定、清除应用数据或卸载应用后，本机保存的账号信息即被彻底删除</li>
      </ul>
    </div>

    <!-- 免责声明 -->
    <div class="card">
      <div class="section-title">免责声明</div>
      <ol class="legal-list">
        <li>本应用为第三方独立开发的个人工具，与 Garmin（佳明）、COROS（高驰）及其关联公司无任何隶属、合作或授权关系。Garmin、COROS 等商标归其各自权利人所有。</li>
        <li>本应用依赖各平台的网络接口实现同步。若平台调整接口、风控策略或服务条款，相关功能可能失效或受限，恕无法保证服务的持续可用性。</li>
        <li>账号密码保存于你的手机本地，请自行妥善保管设备并设置锁屏密码。因设备丢失、被他人使用或自行泄露凭证造成的损失，本应用不承担责任。</li>
        <li>请在遵守各平台服务条款的前提下使用本应用。因使用本应用导致的账号限制、数据异常等风险由用户自行承担。</li>
        <li>同步结果请以各平台实际显示为准，建议定期核对。对因同步产生的数据丢失、重复或错误，本应用不承担任何直接或间接责任。</li>
        <li>继续使用本应用即表示你已阅读、理解并同意上述条款。</li>
      </ol>
    </div>

    <div class="copyright">© {{ year }} 宵十一狼 · 佳捷驰 · 仅供个人学习与运动数据管理使用</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import logoImg from '../../assets/logo.jpg'
import pkg from '../../../package.json'

const router = useRouter()
const year = new Date().getFullYear()

// 版本号：真机读安卓 versionName（与 APK 一致），网页环境回退到 package.json
const appVersion = ref(pkg.version)
onMounted(async () => {
  if (!Capacitor.isNativePlatform()) return
  try {
    const info = await App.getInfo()
    if (info?.version) appVersion.value = info.version
  } catch (e) {
    console.warn('读取版本号失败:', e)
  }
})

function goBack() { router.back() }
</script>

<style scoped>
.page-container { padding: 16px; padding-bottom: 70px; }
.page-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.back-btn { font-size: 28px; color: #0052B9; cursor: pointer; line-height: 1; }
.page-title { font-size: 20px; font-weight: 600; color: #333; }

.app-info { text-align: center; padding: 20px 0 16px; }
.app-logo {
  width: 72px; height: 72px; border-radius: 18px;
  object-fit: contain; margin-bottom: 10px;
}
.app-name { font-size: 20px; font-weight: 600; color: #333; margin-bottom: 4px; }
.app-version { font-size: 13px; color: #999; }
.app-author { font-size: 12px; color: #aaa; margin-top: 4px; }

.text { font-size: 13px; color: #555; line-height: 1.8; margin: 0; }

.feature-list { list-style: none; padding: 0; margin: 0; }
.feature-list li {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: 13px; color: #555; line-height: 1.7; margin-bottom: 8px;
}
.feature-list li:last-child { margin-bottom: 0; }
.dot {
  width: 5px; height: 5px; border-radius: 50%; background: #0052B9;
  flex-shrink: 0; margin-top: 8px;
}

.legal-list { padding-left: 18px; margin: 0; }
.legal-list li { font-size: 12px; color: #777; line-height: 1.8; margin-bottom: 8px; }
.legal-list li:last-child { margin-bottom: 0; }

.copyright {
  text-align: center; font-size: 11px; color: #bbb;
  padding: 16px 0 4px; line-height: 1.6;
}
</style>
