---
kind: external_dependency
name: COROS 高驰运动平台 API
slug: coros
category: external_dependency
category_hints:
    - vendor_identity
    - sdk_real_api
scope:
    - '**'
---

### COROS 高驰运动平台
- **角色**：数据同步目标平台，与 Garmin 国服/国际服并列的第三方运动数据平台
- **集成点**：`garminAuth/index.js` 中的 `corosBind`/`corosRefresh` action、`garminSync/index.js` 中的 `getCorosSession`/`uploadToCoros`、`corosSync/index.js`
- **认证方式**：通过 `teamapi.coros.com/account/login` 登录，请求体需 `{account, accountType:2, pwd: MD5哈希密码}`，响应中 `accessToken` 位于响应头 `accesstoken`（非标准 Authorization Bearer），状态码使用 `apiCode` 而非 `code`
- **会话管理**：保存邮箱+密码用于 session 自动刷新，无需 MFA 二步验证
- **数据格式**：FIT 文件上传
- **注意**：COROS 绑定弹窗在 UI 上已有入口但尚未完全实现独立认证流程；同步方向支持「国服→高驰」「国际服→高驰」
- verify exact API/params against official docs