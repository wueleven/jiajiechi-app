# Zepp/华米 单向数据拉取 — 技术验证归档说明

> 状态：**已封存**（2026-07-27）。主线 `main` 不含任何 Zepp 代码，Garmin/COROS 不受影响。
> 代码在分支 `archive/zepp`，需捡回时：`git checkout archive/zepp`。

## 结论（为什么封存）

1. **账号密码直登私有通道已废弃**：`api-user-us2.zepp.com/v2/registrations/tokens`
   对所有 host（us2 / cn / account）实测均返回 `error=401`。第三方逆向库
   `huami-token`（GitHub + Codeberg 最新版）用相同账号密码同样 401 —— 证明非代码 bug，
   是华米封堵了该通道。

2. **华米官方只支持 OAuth 授权登录**（读官方仓库 `zepp-health/oauth-Android-sdk` 确认）：
   - 登录流程是 `OpenAuthorize.startGetAccessToken()` 拉起授权页 → 用户授权 → 回调拿
     `accessToken` / `refreshToken` / `region` / `expiresIn`
   - **需要向华米商务申请 `APP_ID`**（提交产品名/LOGO/包名 `com.jjt.app`/应用签名）
   - 华米校验**调用方应用签名**（`10003 校验签名错误`），APP_ID 绑定包名+签名
   - 即：第三方无法复用 Zepp App 自身的 client_id（签名校验拦死）

3. 技术验证定论：**华米不向第三方开放账号密码直登**，只走官方 OAuth 授权。
   账号密码直登这条路在当前服务端已走不通，非实现问题。

## 从 APK 挖到的真实端点（仅供参考，非产品化路径）

- 华米账户 SDK V2 登录：`account.zepp.com/v2/client/login`
  - 请求/响应均 AES-CBC 加密，密钥 `xeNtBVqzDc6tuNTh` / IV `MAAAYAAAAAAAAABg`
  - 响应解密后形如 `{"error_code":"0100"}`（`0100` = 业务层拒绝，需有效授权/签名）
- OAuth 授权端点（活着）：`auth.zepp.com/oauth2/authorize`（需 `huami_auth_code`）、
  `auth.zepp.com/oauth2/huamiAuthorize`（需 `scopeObjects`）
- 回调 scheme：`zepp://auth-return`

⚠ 以上端点是华米**自家账户 SDK 内部步骤**，第三方接入仍须走 `OpenAuthorize` + APP_ID + 签名。

## 若将来要重启 Zepp 接入（正确路径）

1. 向华米商务申请 `com.jjt.app` 的 OAuth `APP_ID`（提交包名+签名哈希）
2. 接入 `oauth-Android-sdk` 的 `OpenAuthorize`，拉起授权页
3. 用户授权后拿 token，用 `zepp-health/rest-api` 数据接口拉运动数据
4. 从 `archive/zepp` 分支捡回 zeppAuth.js / bind.vue / sync.vue 的 zepp 入口代码作参考

## 归档时改动文件清单（在 archive/zepp）

- `src/services/zeppAuth.js`（新建，账号密码登录+本地密文存储）
- `src/pages/bind/bind.vue`（zepp 绑定入口）
- `src/pages/sync/sync.vue`（zepp 同步方向选择）
- `vite.config.js`（zepp 代理白名单 + CORS）
- `android/app/build.gradle`（versionCode 升到 14 / 1.13，解封时按需处理）
- `ZEPP_CAPTURE_GUIDE.md`（抓包指引）
