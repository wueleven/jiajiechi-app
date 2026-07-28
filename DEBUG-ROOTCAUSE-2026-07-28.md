# 根因定位：APK 国服/国际服→高驰 假成功（2026-07-28 更新）

## 铁证（阿健确认）
- 昨天（华米验证之前的老包）App 国服/国际服→高驰**一直成功**，高驰有数据。
- 今天网页 dev（localhost:5173）国服→高驰成功，高驰 App 验证有数据。
- 今天 clean3/4/5 APK：同样代码，两个方向都假成功（显示成功、高驰无数据）。
- 华米相关 git 提交仅文档，android/ 原生层从 init 起未被华米改动。

## 根因（代码事实，非推测）
- `capacitor.config.json`: `"CapacitorHttp": { "enabled": true }`（开启原生 HTTP 插件）
- `package.json` dependencies **无 `@capacitor/http` 依赖** → 插件没装，"enabled"是空开关。

### 网页成、APK 败的链路
1. 网页 dev：`http.js` → `webRequest`（fetch）→ 经 Vite 代理 `/__proxy__/` 把跨域变同源 → 无 CORS → 成功。
2. APK：`http.js` → `nativeRequest` → 先试 WebView fetch 直连 coros.com → **被 CORS 拦截**（coros.com 不允许我们的 origin）→ fetch 失败无 status → 回退 CapacitorHttp 原生插件（http.js 206-208 行）→ **插件没装** → 静默异常被吞 → 假成功。
- CapacitorHttp 插件设计用途正是**绕过 WebView CORS**（原生层发请求不受同源策略限制），等价于开源服务端直连 urllib3。

### 为什么昨天老包能成
昨天华米前的包里 `@capacitor/http` 还装着（记忆：老包 `@capacitor/http@0.0.2` 必须移除 → 曾存在，后删依赖但 config 的 enabled 没改回）。删依赖留空开关 → 现在 APK 回退到空插件 → 假成功。

## 修法
装回**与 Capacitor 8 兼容**的 `@capacitor/http`，让 `enabled:true` 真正生效（原生请求绕 CORS）。
⚠️ 不能装 @0.0.2（与 C8 不兼容，记忆明确规定移除）。需查官方 C8 对应版本。
改后需 `npm install` + `npx cap sync android` + 重打包 clean6。
