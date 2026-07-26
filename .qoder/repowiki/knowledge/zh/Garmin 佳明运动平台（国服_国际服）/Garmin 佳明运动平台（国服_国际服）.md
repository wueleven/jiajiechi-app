---
kind: external_dependency
name: Garmin 佳明运动平台（国服/国际服）
slug: garmin
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### Garmin 佳明运动平台
- **角色**：主要数据源平台，区分国服与国际服两个区域版本
- **集成点**：`garminAuth/index.js` 中的 OAuth 1.0a → OAuth 2.0 认证链、`garminSync/index.js` 中的数据拉取与上传
- **认证协议**：OAuth 1.0a → OAuth 2.0 双阶段认证，支持 MFA 短信验证码二步验证（中间状态存数据库，5分钟过期）
- **Token 管理**：检测过期前5分钟自动用 OAuth1 刷新 OAuth2，403 错误时强制刷新 token
- **数据格式**：FIT 文件下载/上传
- **同步逻辑**：参照开源项目 dailysync-ref 的实现，拉取最近20条活动 → 比较最新活动时间 → 倒序逐个下载 FIT 文件
- verify exact API/params against official docs