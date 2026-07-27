# Zepp/华米 单向数据拉取 — 技术验证归档说明

> 状态：**已封存**（2026-07-27）。主线 `main` 不含任何 Zepp 代码，Garmin/COROS 不受影响。
> 代码在分支 `archive/zepp`，需捡回时：`git checkout archive/zepp`。

## 一、为什么无法在「佳捷同」里实现华米登录（无法实现的原因）

结论：**不是代码写不出来，是华米服务端不向第三方 App 开放账号密码直登，且签名校验堵死了"复用 Zepp 自身凭证"的捷径。** 具体两层原因（依据均为华米官方文档）：

1. **华米官方只支持 OAuth 授权登录，不支持账号密码直登**
   - 读官方仓库 `zepp-health/oauth-Android-sdk` 确认：登录流程是
     `OpenAuthorize.startGetAccessToken()` 拉起授权页 → 用户登录授权 → 回调拿
     `accessToken` / `refreshToken` / `region` / `expiresIn`。
   - 官方 `rest-api` 数据接口文档里**根本没有"账号密码换 token"的接口**，只有 OAuth2 验证。

2. **签名校验要求绑定本应用包名+签名，无法复用 Zepp 的凭证**
   - 华米校验**调用方应用签名**（`10003 校验签名错误`），`APP_ID` 绑定包名+签名。
   - 非官方包名/签名的 App 复用 Zepp 的 client_id 会被签名校验拦死。
   - 错误码定义（来自官方接入文档）：`10003 校验签名错误`、`10009 APPID未配置`、
     `10013 当前用户区域设置错误`、`10015 参数检查错误`。

> 一句话：华米不把"账号密码直登"开放给第三方；想接只能走官方 OAuth 授权，且必须
> 先拿到华米分配的、绑定本应用包名+签名的 `APP_ID`。

## 二、若将来要实现 Zepp/华米接入，该走什么申请

**正确路径 = 官方 OAuth 授权接入，不是账号密码直登、也不是逆向复用。**

### 前置申请（必须，向华米商务提交）

1. 准备「佳捷同」的**应用签名哈希**和**包名 `com.jjt.app`**：
   - 用发布签名 keystore 跑：`keytool -exportcert -alias <alias> -keystore <jjt.keystore> | openssl sha1 -binary | openssl base64`
   - 注意：华米校验的是**最终发布包的签名**，测试签名和正式签名要一致（官方 Sample 用 `android_key.jks` 签名才能过校验）。
2. 向**华米商务**提交接入申请，材料（来自官方 `接入须知.md`）：
   - 应用名称（如：佳捷同）
   - 应用 LOGO 链接
   - 应用介绍
   - **应用包名：`com.jjt.app`**
   - **应用签名哈希**（上一步算出来的）
3. 华米审核通过后，分配一个**绑定本包名+签名的 `APP_ID`**（官方 Sample 的 APP_ID 是
   `e8f70b0f-814d-482a-89db-ab25a8a59539`，仅作示例，我们得用自己申请的）。

### 接入步骤（拿到 APP_ID 后）

1. 把官方 `oauth-Android-sdk` 的 `hmauth` SDK（jar/aar）接入 jjt-app。
2. 用 `OpenAuthorize` 拉起授权页：`new OpenAuthorize(ctx).setAppId(<我们的APP_ID>).secretEnable(false).setAuthCallback(...).startGetAccessToken(activity)`
3. 回调里拿 `accessToken` / `refreshToken` / `region` / `expiresIn`，本地密文存储（与现有 Garmin/COROS 一致）。
4. 用 `rest-api` 的数据接口（带 `Bearer access_token`）拉运动数据，接入 sync.vue 的同步方向选择。

> ⚠ 账号密码直登（archive/zepp 里那套旧实现）**不可用于未来产品**，依赖的私有通道已被封堵。
> 未来实现必须基于官方 OAuth `OpenAuthorize`。

## 三、参考的官方文档路径（查证来源）

全部来自华米官方 GitHub 组织 `zepp-health` / `huamitech`，非第三方逆向：

- **OAuth 登录 SDK（本次定论的核心依据）**
  - 仓库：`https://github.com/zepp-health/oauth-Android-sdk`
  - 接入文档：`Docs/华米授权SDK接入文档.md`（含 `OpenAuthorize` 用法、错误码表）
  - 商务申请须知：`Docs/接入须知.md`（提交包名+签名给华米商务）
  - Sample 代码：`Sample/app/src/main/java/com/huami/android/oauth/sample/`（含 `Constants.java` 的 APP_ID 示例、`MainActivity.java` 的授权调用）
  - SDK 包：`Sdk/hmauth-v0.0.6.aar`、`Sdk/hmauth-v0.0.5.jar`

- **数据接口（拿到 token 后拉数据用）**
  - 仓库：`https://github.com/zepp-health/rest-api`
  - 鉴权方式：请求头 `Authorization: Bearer <access_token>`；接口如 `GET /users/-/profile`、`/users/-/activities`、`/users/-/sleep`、`/users/-/heartrates`、`/users/-/devices`、`/users/-/sports`
  - 补充 wiki：`https://github.com/huamitech/rest-api/wiki`

## 归档时改动文件清单（在 archive/zepp）

- `src/services/zeppAuth.js`（账号密码直登旧实现，已废弃）
- `src/pages/bind/bind.vue`（zepp 绑定入口）
- `src/pages/sync/sync.vue`（zepp 同步方向选择）
- `vite.config.js`（zepp 代理白名单 + CORS）
- `android/app/build.gradle`（versionCode 升到 14 / 1.13，解封时按需处理）
- `ZEPP_CAPTURE_GUIDE.md`（抓包指引，仅本地调试用）
