# App 国服→高驰「网页成功、APK 失败」排查笔记（2026-07-28）

## 现象
- 本机网页 dev 测试：国服→高驰同步成功，import 返回 `apiCode:8E16FCC7, data.status:2`。
- 打包 APK（clean3/clean4）真机：显示成功、无报错，但高驰无数据。
- 今早 App 还成功同步过 → 说明同步代码在正确状态下能工作，是「状态/环节」问题，非整段逻辑写错。
- 小程序（云服务器）报 `1019 Access token is invalid`，已修为正确标 failed（暂放，先查 App）。

## 锚点结论（已对照开源确认）
- import 通知环节：App `corosSync.js` 与开源 `coros_client.py` 一致（字段 `jsonParameter`、端点 `/activity/fit/import`、判定 `result=="0000"` 或 `apiCode==8E16FCC7`）。**这部分没问题。**
- 真正差异在 **S3/OSS 上传环节**（import 之前先把 zip 传到阿里云）。

## 开源对照（garmin-sync-coros / XiaoSiHwang）
- `scripts/oss/ali_oss_client.py`（国服阿里云 OSS）：
  - 用阿里云官方 `oss2` SDK **分片上传**：`init_multipart_upload → upload_part(逐个) → complete_multipart_upload`。
  - STS 解码用 `utils.coros_oss_credients_utils.decode`（专有函数）。
- `scripts/coros/coros_client.py` 的 `uploadActivity`：只发 `jsonParameter` 到 `/activity/fit/import`，**不含 S3 上传**（S3 在 oss 模块完成）。

## App 当前实现（corosSync.js）
- `uploadToS3`（152-206 行）：用 AWS S3 SDK 单步 `PutObject`（`forcePathStyle:true` 兼容阿里云），
  签名用自写 `ossSign`（OSS v1）/ `awsSigV4Sign`。
  STS 解码：`stripped = raw.replace(SALT); JSON.parse(base64)`。
- 调用：`httpRequest(url, { method:'PUT', body:data(二进制 zipBuffer), responseType:'text' })`。

## 根因假设（待真机日志坐实）
APK 原生环境下，二进制 PUT body 经 `http.js` 的 CapacitorHttp 桥接被 **base64 文本化**：
- `http.js` 153 行：`useFetch = responseType==='arraybuffer' || body instanceof FormData`。
  S3 PUT 的 responseType='text' 且 body 是 Uint8Array → useFetch=false → 走 CapacitorHttp 原生桥接。
- CapacitorHttp 桥接（224-234 行）把 `Uint8Array` 转 `btoa` base64 放进 requestData.data。
  阿里云 OSS 收到的是 base64 文本而非原始 zip → PUT 返回 200（签名/路径对）但**对象内容损坏**
  → import 接口返回 8E16FCC7（接受）但后台解压失败/无数据 → 表现「显示成功、没数据」。
- 网页 dev 走 `webRequest`（fetch）直接发原始 Uint8Array → OSS 收到正确 zip → 成功。
  这正好解释「网页成功、APK 失败」。

## 明日验证
1. 手机同步国服→高驰一次，抓日志确认 import 返回 8E16FCC7 但数据没出现（坐实 OSS 内容损坏）。
2. 修 `http.js`：二进制 PUT/POST（Uint8Array/ArrayBuffer）在 APK 也走 WebView fetch（与 FormData 同路），避免 base64 化。
3. 打包 clean5，真机复测。

