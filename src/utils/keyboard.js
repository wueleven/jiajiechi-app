// 全局键盘适配（Android WebView）
// 背景：MainActivity 已声明 windowSoftInputMode="adjustResize"，
// 键盘弹出时 WebView 视口真正缩小。这里监听 visualViewport 变化，
// 键盘弹出时给 body 加 .kb-open 并设置 --kb-height 变量，
// 配合 global.css 让 fixed 弹窗改为顶部对齐、限高可滚动，
// 输入框始终可见，避免弹窗被键盘顶起跳动导致"反复点不中"。

let installed = false

export function setupKeyboardHandler() {
  if (installed) return
  installed = true

  const apply = () => {
    const vv = window.visualViewport
    // 键盘占用高度 ≈ 窗口高度 - 视觉视口高度（视觉视口即键盘上方可见区域）
    const kbHeight = vv ? Math.max(0, Math.round(window.innerHeight - vv.height)) : 0
    const open = kbHeight > 150 // 阈值防误判（小于 150 视为无键盘或系统导航条差异）
    document.documentElement.style.setProperty('--kb-height', `${kbHeight}px`)
    document.body.classList.toggle('kb-open', open)
  }

  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
  }
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', () => setTimeout(apply, 200))
  apply()
}

// 聚焦输入框并滚动到可视区（供弹窗打开自动聚焦调用）
export function focusAndReveal(el) {
  if (!el) return
  try {
    el.focus()
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center' })
    }
  } catch (e) {
    /* noop */
  }
}
