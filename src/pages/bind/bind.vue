<template>
  <div class="page-container">
    <div class="page-header">
      <span class="back-btn" @click="goBack">‹</span>
      <span class="page-title">账号绑定管理</span>
    </div>
    <div class="page-desc">输入账号密码绑定平台，之后可直接同步数据</div>

    <!-- 三个平台绑定卡片 -->
    <div class="card bind-card" v-for="p in platforms" :key="p.key">
      <div class="bind-header">
        <div class="platform-icon" :class="p.iconClass">{{ p.letter }}</div>
        <div class="platform-info">
          <div class="platform-name">{{ p.name }}</div>
          <div class="platform-desc">{{ p.domain }}</div>
        </div>
        <span v-if="p.bound" class="tag tag-success">已绑定</span>
        <span v-else class="tag tag-warning">未绑定</span>
      </div>
      <div class="bind-actions">
        <template v-if="p.bound">
          <div class="bind-user">账号: {{ p.displayName }}</div>
          <div class="btn-unbind" @click="confirmUnbind(p)">解除绑定</div>
        </template>
        <template v-else>
          <div class="btn-bind" @click="openBindModal(p)">绑定账号</div>
        </template>
      </div>
    </div>

    <!-- 说明 -->
    <div class="card">
      <div class="tip-title">使用说明</div>
      <div class="tip-item">1. 三个平台按需绑定，绑定任意两个及以上即可在它们之间同步数据</div>
      <div class="tip-item">2. Garmin 国服 / 国际服使用账号密码登录，开启了两步验证的账号需输入验证码；国服手机号登录需带 86 前缀，未填写时会自动补齐</div>
      <div class="tip-item">3. COROS 使用账号密码登录，账号可为注册邮箱或手机号</div>
      <div class="tip-item">4. 账号密码加密后仅保存在手机本地，用于登录官方服务器及登录状态过期后自动续期，不会上传</div>
      <div class="tip-item">5. 修改过平台密码或长期未使用导致同步失败时，重新绑定即可恢复</div>
      <div class="tip-item">6. 解除绑定会立即删除本机保存的该平台账号信息；更换账号先解绑再重新绑定</div>
    </div>

    <!-- 登录弹窗 -->
    <div class="modal-mask" v-if="showBindModal" @click.self="closeBindModal">
      <div class="modal-content">
        <div class="modal-title">绑定 {{ currentPlatformName }}</div>
        <div class="modal-desc">请输入你的平台账号和密码</div>
        <div class="input-group">
          <div class="input-label">账号</div>
          <input class="modal-input" ref="usernameInput" :placeholder="currentPlatform === 'coros' ? '请输入邮箱或手机号' : '请输入账号/邮箱'" v-model="username"
            autocapitalize="none" autocorrect="off" autocomplete="off" />
        </div>
        <div class="input-group">
          <div class="input-label">密码</div>
          <div class="pwd-wrap">
            <input class="modal-input" ref="passwordInput" placeholder="请输入密码" :type="showPassword ? 'text' : 'password'" v-model="password"
              autocapitalize="none" autocorrect="off" autocomplete="off" />
            <span class="pwd-eye" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</span>
          </div>
        </div>
        <div class="modal-actions">
          <div class="modal-btn cancel" @click="closeBindModal">取消</div>
          <div class="modal-btn confirm" :class="{ loading: loginLoading }" @click="submitLogin">
            {{ loginLoading ? '绑定中...' : '确认绑定' }}
          </div>
        </div>
      </div>
    </div>

    <!-- MFA 验证码弹窗 -->
    <div class="modal-mask" v-if="showMfaModal" @click.self="closeMfaModal">
      <div class="modal-content">
        <div class="modal-title">输入验证码</div>
        <div class="modal-desc">Garmin登录验证码有效期30分钟，请及时输入。</div>
        <div class="input-group">
          <div class="input-label">验证码</div>
          <input class="modal-input" ref="mfaInput" placeholder="请输入验证码" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" v-model="mfaCode"
            autocapitalize="none" autocorrect="off" autocomplete="off" />
        </div>
        <div class="modal-actions">
          <div class="modal-btn cancel" @click="closeMfaModal">取消</div>
          <div class="modal-btn confirm" :class="{ loading: mfaLoading }" @click="submitMfaCode">
            {{ mfaLoading ? '验证中...' : '确认' }}
          </div>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <div class="toast" v-if="toast.show">{{ toast.message }}</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { getBindInfo } from '../../services/storage.js'
import { bindWithPassword, submitMfa, unbindPlatform } from '../../services/garminAuth.js'
import { corosBind, corosUnbind } from '../../services/corosAuth.js'
import { registerBackInterceptor } from '../../utils/backButton.js'

const router = useRouter()

const bindData = ref({
  garminCn: { bound: false, displayName: '' },
  garminCom: { bound: false, displayName: '' },
  coros: { bound: false, displayName: '' },
})

const showBindModal = ref(false)
const showMfaModal = ref(false)
const currentPlatform = ref('')
const currentPlatformName = ref('')
const username = ref('')
const password = ref('')
const mfaCode = ref('')
const showPassword = ref(false)
const loginLoading = ref(false)
const mfaLoading = ref(false)
const toast = ref({ show: false, message: '' })
// 输入框模板引用（自动聚焦用）
const usernameInput = ref(null)
const passwordInput = ref(null)
const mfaInput = ref(null)

// 弹窗打开即聚焦首个输入框，缓解"点击激活/聚焦"分离导致的输入不畅
watch(showBindModal, (v) => { if (v) nextTick(() => usernameInput.value?.focus()) })
watch(showMfaModal, (v) => { if (v) nextTick(() => mfaInput.value?.focus()) })

let toastTimer = null
function showToast(msg, duration = 2000) {
  // 长消息（如带诊断信息的错误）延长展示时间，方便用户阅读和截图
  if (msg && msg.length > 40) duration = Math.max(duration, 8000)
  toast.value = { show: true, message: msg }
  // 先取消上一条的关闭定时器，避免新提示被提前关掉
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value.show = false }, duration)
}

const platforms = computed(() => [
  { key: 'garminCn', name: 'Garmin 国服', letter: 'G', iconClass: 'garmin-cn', domain: 'connect.garmin.cn', ...bindData.value.garminCn },
  { key: 'garminCom', name: 'Garmin 国际服', letter: 'G', iconClass: 'garmin-com', domain: 'connect.garmin.com', ...bindData.value.garminCom },
  { key: 'coros', name: 'COROS 高驰', letter: 'C', iconClass: 'coros', domain: 'coros.com', ...bindData.value.coros },
])

function loadBindInfo() {
  const res = getBindInfo()
  if (res.success) bindData.value = res.data
}

onMounted(loadBindInfo)

// 弹窗打开时，系统返回键/手势优先关闭弹窗（MFA 在上层，先关）
const unregisterBackInterceptor = registerBackInterceptor(() => {
  if (showMfaModal.value) { closeMfaModal(); return true }
  if (showBindModal.value) { closeBindModal(); return true }
  return false
})
onUnmounted(unregisterBackInterceptor)

function openBindModal(p) {
  currentPlatform.value = p.key
  currentPlatformName.value = p.name
  username.value = ''
  password.value = ''
  loginLoading.value = false
  showBindModal.value = true
}

function closeBindModal() { showBindModal.value = false }
function closeMfaModal() { showMfaModal.value = false }

async function submitLogin() {
  if (!username.value.trim() || !password.value.trim()) {
    showToast('请输入账号和密码'); return
  }
  loginLoading.value = true
  try {
    let account = username.value.trim()
    // 佳明国服手机号登录必须带 86 前缀（实测）：识别到标准 11 位手机号时自动补齐，
    // 邮箱含 @ 不会命中，已手动加 86 的也不会命中，不影响其他账号形式
    if (currentPlatform.value === 'garminCn' && /^1[3-9]\d{9}$/.test(account)) {
      account = '86' + account
    }
    let res
    if (currentPlatform.value === 'coros') {
      res = await corosBind(account, password.value.trim())
    } else {
      res = await bindWithPassword(currentPlatform.value, account, password.value.trim())
    }

    if (res.success && res.mfaRequired) {
      showBindModal.value = false
      showMfaModal.value = true
      mfaCode.value = ''
      mfaLoading.value = false
      return
    }

    if (res.success) {
      showToast(`${currentPlatformName.value} 绑定成功`)
      showBindModal.value = false
      loadBindInfo()
    } else {
      showToast(res.message || '绑定失败')
    }
  } catch (err) {
    console.error('绑定失败:', err)
    showToast('绑定失败，请重试')
  } finally {
    loginLoading.value = false
  }
}

async function submitMfaCode() {
  if (!mfaCode.value.trim()) { showToast('请输入验证码'); return }
  mfaLoading.value = true
  try {
    const res = await submitMfa(currentPlatform.value, mfaCode.value.trim())
    if (res.success) {
      showToast(`${currentPlatformName.value} 绑定成功`)
      showMfaModal.value = false
      loadBindInfo()
    } else {
      showToast(res.message || '验证码错误')
    }
  } catch (err) {
    showToast('验证失败，请重试')
  } finally {
    mfaLoading.value = false
  }
}

function confirmUnbind(p) {
  if (confirm(`确定要解绑 ${p.name} 吗？`)) {
    if (p.key === 'coros') {
      corosUnbind()
    } else {
      unbindPlatform(p.key)
    }
    showToast(`${p.name} 已解绑`)
    loadBindInfo()
  }
}

function goBack() { router.push('/index') }
</script>

<style scoped>
.page-container { padding: 16px; padding-bottom: 70px; }
.page-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.back-btn { font-size: 28px; color: #0052B9; cursor: pointer; line-height: 1; }
.page-title { font-size: 20px; font-weight: 600; color: #333; }
.page-desc { font-size: 13px; color: #999; margin-bottom: 20px; }

.bind-card { padding: 16px; }
.bind-header { display: flex; align-items: center; margin-bottom: 14px; }
.platform-icon {
  width: 44px; height: 44px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; font-weight: bold; color: #fff; margin-right: 14px;
}
.garmin-cn { background: linear-gradient(135deg, #00a3d9, #0088b8); }
.garmin-com { background: linear-gradient(135deg, #0052B9, #003d8a); }
.coros { background: linear-gradient(135deg, #F40000, #C80000); }
.platform-name { font-size: 15px; font-weight: 500; color: #333; margin-bottom: 3px; }
.platform-desc { font-size: 12px; color: #999; }
.platform-info { flex: 1; }
.bind-actions { padding-top: 12px; border-top: 1px solid #f0f0f0; }
.bind-user { font-size: 13px; color: #666; margin-bottom: 10px; }
.btn-bind {
  background: #0052B9; color: #fff; text-align: center;
  padding: 10px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer;
}
.btn-unbind {
  background: #fff1f0; color: #ff4d4f; text-align: center;
  padding: 10px; border-radius: 8px; font-size: 14px; cursor: pointer;
}

.tip-title { font-size: 14px; font-weight: 600; color: #333; margin-bottom: 10px; }
.tip-item { font-size: 12px; color: #666; line-height: 1.8; margin-bottom: 4px; }

/* 弹窗 */
.modal-mask {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5); display: flex; align-items: center;
  justify-content: center; z-index: 1000;
}
.modal-content {
  background: #fff; border-radius: 16px; width: 85%; max-width: 400px; padding: 24px;
}
.modal-title { font-size: 17px; font-weight: 600; text-align: center; margin-bottom: 8px; }
.modal-desc { font-size: 13px; color: #999; text-align: center; margin-bottom: 20px; }
.input-group { margin-bottom: 14px; }
.input-label { font-size: 13px; color: #666; margin-bottom: 6px; }
.modal-input {
  width: 100%; border: 1px solid #e0e0e0; border-radius: 8px;
  padding: 12px 14px; font-size: 14px; outline: none;
}
.modal-input:focus { border-color: #0052B9; }
.pwd-wrap { position: relative; }
.pwd-wrap .modal-input { padding-right: 64px; }
.pwd-eye {
  position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
  font-size: 12px; color: #0052B9; cursor: pointer; padding: 8px 4px; user-select: none;
}
.modal-actions { display: flex; gap: 12px; margin-top: 8px; }
.modal-btn {
  flex: 1; text-align: center; padding: 10px; border-radius: 8px;
  font-size: 14px; cursor: pointer;
}
.modal-btn.cancel { background: #f0f0f0; color: #666; }
.modal-btn.confirm { background: #0052B9; color: #fff; font-weight: 500; }
.modal-btn.confirm.loading { opacity: 0.6; }

.toast {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: rgba(0,0,0,0.75); color: #fff; padding: 10px 24px;
  border-radius: 8px; font-size: 14px; z-index: 2000;
}
</style>
