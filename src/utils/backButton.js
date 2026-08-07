// 全局返回键/手势处理（仅 Android 原生生效）
//
// 背景：Capacitor 8 的 AppPlugin 一旦检测到 JS 侧注册了 backButton 监听器，
// 系统返回键/手势的默认行为就完全交给 JS 接管（不再自动后退或退出）。
// 这也正是此前"返回键/手势不会退出 App"的根因——没有监听器时，
// WebView 无历史可退就什么都不做，应用留在首页。
//
// 这里按 Android 通用惯例实现：
//  - 页面级拦截器优先：弹窗等页面内部状态打开时，返回先关闭它（后进先出）
//  - 非首页：跟随 Vue Router 后退（WebView 无历史可退时回首页，避免空白页）
//  - 首页：第一次返回弹出"再按一次退出"提示，窗口期内再次返回才真正退出
//    （防误退，微信/淘宝等主流应用同款交互）
//  - 从后台回前台时重置退出计数，避免提示后切后台很久回来误触"立即退出"

import { Capacitor } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'

let installed = false

// 页面级返回拦截器栈（后进先出）。页面在 setup 中注册，返回 true 表示
// 本次返回已被消费（如关闭了弹窗），不再继续走路由后退/退出逻辑。
const backInterceptors = []

/**
 * 注册一个返回拦截器，返回注销函数（建议在 onUnmounted 中调用）。
 * @param {() => boolean} handler 返回 true 表示已消费本次返回
 */
export function registerBackInterceptor(handler) {
  backInterceptors.push(handler)
  return function unregister() {
    const idx = backInterceptors.indexOf(handler)
    if (idx >= 0) backInterceptors.splice(idx, 1)
  }
}

export function setupBackButtonHandler({ router, onExitHint, exitWindowMs = 2000 }) {
  // 仅原生平台启用；浏览器调试时保持浏览器默认返回行为
  if (installed || !Capacitor.isNativePlatform()) return
  installed = true

  const HOME_PATH = '/index'
  let lastBackAt = 0

  // 后台切回前台时清空"已提示"状态，防止隔很久回来第一次返回就退出
  CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) lastBackAt = 0
  })

  CapacitorApp.addListener('backButton', ({ canGoBack }) => {
    // 1. 页面级拦截器优先：弹窗打开时返回先关弹窗
    for (let i = backInterceptors.length - 1; i >= 0; i--) {
      try {
        if (backInterceptors[i]() === true) return
      } catch (e) {
        // 拦截器异常不应阻断返回逻辑
      }
    }

    const path = router.currentRoute.value.path

    // 2. 首页：第一次返回提示，窗口期内再次返回则真正退出
    if (path === HOME_PATH) {
      const now = Date.now()
      if (now - lastBackAt <= exitWindowMs) {
        CapacitorApp.exitApp()
        return
      }
      lastBackAt = now
      if (typeof onExitHint === 'function') onExitHint()
      return
    }

    // 3. 非首页：正常后退；无历史可退（如 deep link 直达）则回首页
    if (canGoBack) {
      router.back()
    } else {
      router.replace(HOME_PATH)
    }
  })
}
