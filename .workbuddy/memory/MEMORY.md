# 项目长期记忆（佳捷驰 jiajiechi-app）

## 用户铁律（必须遵守）
- **不要乱动项目里的代码以及 GitHub 的内容**：除非用户明确要求，否则一律只读分析、输出方案/说明，不得直接修改 src/android/docs 等任何项目文件，不得 push/改写 GitHub 仓库内容。需要落地改动时必须先征得用户同意。
- 用户是跑步爱好者，本项目为跑团团友自用，非盈利、不推广；隐私红线：凭证不出手机、无服务器。

## 项目速览
- 佳捷驰：运动手表数据跨平台同步工具（Garmin 国行/国际服 ↔ COROS），纯本地、无服务器。
- 技术栈：Vue 3 + Vue Router + Vite 5 + Capacitor 8（Android）；crypto-js/jszip；JDK 21、SDK 36。
- 版本基线：v0.9.8-beta.1 / versionCode 41（main 分支）。
- 页面：index/bind/sync/history/about/pb（共 6 页，README 还写 5 页）。

## 已实现要点
- 三平台双向同步、启动自动同步（autoSync.js：冷启动 + 回前台超 1h，最多 50 条）、三层去重、同步记录保留策略（1000 条/90 天）。
- 启动屏：SplashScreen 插件 `launchAutoHide: false`，JS 侧手动 hide；背景 #FDFDFB。

## 待拍板/搁置
- 小米体重同步（proposals 留档，未立项，风险=小米登录逆向稳定性）。
- 真后台定时同步（WorkManager 二期，搁置）。
