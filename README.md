# 佳捷驰 · Zepp/华米技术验证归档（archive/zepp）

> ⚠️ **本分支为技术验证归档，已封存，不再开发（2026-07）。**
>
> 这里保存的是「佳捷驰」尝试接入 **Zepp/华米** 单向数据拉取的一段技术验证代码。
> 主线 `main` 分支不包含任何 Zepp 代码，Garmin / COROS 的功能不受本分支影响。
> 想使用可正常工作的三平台同步版本，请回到 **[`main` 分支](../../tree/main)**（安卓 App 版佳捷驰）。

「佳捷驰」是一款把**运动手表数据**在不同平台之间互相同步的工具（安卓原生 App，基于 Capacitor 8 打包，Web 前端跑在手机本地 WebView 里）。本分支只是它在开发过程中的一次失败探索的留存。

## 为什么 Zepp/华米没能做进「佳捷驰」

结论：**不是代码写不出来，而是华米服务端不向第三方 App 开放账号密码直登，签名校验也堵死了"复用 Zepp 自身凭证"的捷径。** 依据均来自华米官方文档：

1. **华米官方只支持 OAuth 授权登录，不支持账号密码直登。** 官方仓库 `zepp-health/oauth-Android-sdk` 的登录流程是拉起授权页 → 用户登录授权 → 回调拿 `accessToken`；官方 `rest-api` 数据接口里根本没有"账号密码换 token"的接口。
2. **签名校验要求绑定本应用的包名 + 签名，无法复用 Zepp 的凭证。** 华米校验调用方应用签名（`10003 校验签名错误`），`APP_ID` 绑定包名 + 签名；非官方包名/签名的 App 复用 Zepp 的 client_id 会被拦死。

一句话：想接入只能走**官方 OAuth 授权**，且必须先向华米商务申请一个绑定「佳捷驰」包名（`com.jiajiechi.app`）+ 签名的 `APP_ID`。本分支里那套账号密码直登的旧实现（`src/services/zeppAuth.js`）依赖的私有通道已被封堵，**不可用于未来产品**，仅作技术记录留存。

> 完整的封存说明、未来正确的接入路径与官方文档来源，见 `main` 分支的 [`docs/archive/ZEPP_VERIFICATION_ARCHIVED.md`](../../blob/main/docs/archive/ZEPP_VERIFICATION_ARCHIVED.md)。

## 本分支相对 main 的主要改动

- `src/services/zeppAuth.js`：Zepp 账号密码直登旧实现（已废弃）
- `src/pages/bind/bind.vue`：Zepp 绑定入口
- `src/pages/sync/sync.vue`：Zepp 同步方向选择
- `vite.config.js`：Zepp 代理白名单 + CORS 配置

## 技术架构（与 main 一致）

- **前端**：Vue 3 + Vue Router + Vite
- **壳**：Capacitor 8 打包成安卓 App，运行在手机本地，不依赖服务器
- **网络请求**：自封装的 `http.js`，在手机本地直接对接各家运动平台接口
- **加密与压缩**：`crypto-js`（Garmin 老接口的 OAuth1 签名）、`jszip`（活动文件压缩包）

## 许可证

本项目以 **GNU GPL v3** 许可证开源，详见仓库根目录 `LICENSE` 文件。
