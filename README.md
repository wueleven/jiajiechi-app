# 佳捷同（安卓 App / jjt-app）

「佳捷同」是一款把**运动手表数据**在不同平台之间互相同步的工具。本仓库是 **Android 原生 App 版本**（基于 Capacitor 8 打包，Web 前端跑在手机本地 WebView 里）。

> 项目仍处于开发阶段，当前为私有仓库，尚未正式发布。

## 开发背景（为什么做这个）

1. **本人是个热衷于马拉松训练的跑者**，平时喜欢把运动数据放到各个平台去做分析。跑团里的小伙伴也恰好需要把数据同步到佳明，去参加天梯排名。之前大家一直用「佳某通」这类软件，但它更新之后开始收费，而且收费方式不合理、软件也越来越臃肿，于是就想自己搞一个。
2. **最近听说 AI 编程发展得非常快、效果也很好**。我虽然是计算机专业出身，但对编程几乎一窍不通，又是个喜欢折腾的人，就想借这个机会试试用 AI 写一个程序、看看效果到底如何。正好自己就有这个真实需求，就拿它当第一个练手项目。

> 声明：作者本人对程序开发基本一窍不通，也不懂开源社区的规矩。文档、代码里如果有任何不专业、不合规矩、或冒犯到别人的地方，**非常欢迎指正**，我会认真学习并修正。

## 它能做什么

把你在一家运动平台上的运动记录，同步到另一家，省得手动导出导入。支持三种平台：

- **Garmin 国行**（connect.garmin.cn）
- **Garmin 国际服**（connect.garmin.com）
- **COROS 高驰**（coros.com）

以及它们之间的双向同步：

| 方向 | 说明 |
|------|------|
| 国行 ↔ 国际服 | Garmin 国服与国际服互传 |
| 高驰 → 国行/国际服 | 把高驰手表记录同步到 Garmin |
| 国行/国际服 → 高驰 | 把 Garmin 记录同步到高驰 |

## 技术架构（大白话）

- **前端**：Vue 3 + Vue Router + Vite（写界面和逻辑）
- **壳**：Capacitor 8 把它打包成安卓 App，运行在手机本地，不依赖服务器
- **网络请求**：自己封装的 `http.js`，在手机本地发请求，对接各家运动平台接口
- **加密**：`crypto-js`（Garmin 老接口需要 OAuth1 签名）、`jszip` / `pako`（处理活动文件的压缩包）

代码位置（给想看的人）：

```
src/
  pages/          # 四个页面：首页(index)、账号绑定(bind)、同步(sync)、记录(history)
  services/
    garminAuth.js / garminSync.js   # Garmin 登录与上传下载
    corosAuth.js / corosSync.js     # 高驰登录与上传下载
    http.js        # 统一网络请求层
    syncOrchestrator.js  # 同步总调度（决定谁同步给谁、去重、重试）
    syncRecord.js  # 同步记录（App 内"记录"页的数据）
    storage.js     # 本地存储（账号、token 等）
```

## 本地构建与运行（给开发者）

环境要求：

- Node.js（建议 18+）
- JDK 21（Capacitor 8 打包安卓必须用 JDK 21）
- Android SDK（platforms;android-36 + build-tools;36.0.0）
- Gradle 8.9
- 一台开启了「USB 调试」的安卓手机（当前测试机：vivo V2419A）

步骤：

```bash
# 1. 安装依赖
npm install

# 2. 构建前端
npm run build

# 3. 同步进安卓工程
npx cap sync android

# 4. 用 Android Studio 打开安卓工程，或命令行编译
cd android
./gradlew assembleDebug

# 5. 装到手机
adb -s <设备ID> install -r app/build/outputs/apk/debug/app-debug.apk
```

> 每次发版需要提升 `android/app/build.gradle` 里的 `versionCode` / `versionName`。

## 已知问题与限制

- **高驰 → Garmin 上传**：早期版本因请求层把文件悄悄转成了文本导致 `HTTP 415`，已在 v1.9 修复；重复活动 Garmin 返回 `409`，已改为「跳过」而非「失败」。
- 本项目为纯本地运行，**不使用任何云函数**，所有请求从手机直接发出。
- 仓库为私有，公开前需清理代码中可能内嵌的密钥（如 COROS 相关编号、OSS 桶名等）。

## 参考与致谢

本项目在开发过程中参考了两个优秀的开源项目，在此郑重感谢原作者们的无私分享。需要特别说明的是：**本项目为自行实现，但部分接口流程、参数结构与平台私有常量参考了下述项目（尤其是 COROS 侧的 STS 凭证、上传与导入流程），并非完全从零独立探索；源代码为各自用 JavaScript/TypeScript 重新编写，未直接复制其源文件。**

- **[garmin-sync-coros](https://github.com/XiaoSiHwang/garmin-sync-coros)**（by [@XiaoSiHwang](https://github.com/XiaoSiHwang)）
  一个用 Python 实现「COROS 高驰 ↔ Garmin 佳明」数据互传的项目。本项目高驰侧的上传、导入流程，借鉴了它的实现思路。
- **[dailysync](https://gitlab.com/gooin/dailysync)**（by [@gooin](https://gitlab.com/gooin)），采用 **GNU GPL v3** 许可证
  一个做「Garmin 国行 ↔ 国际服」同步的项目（TypeScript 实现）。本项目国服/国际服互传的处理方式，参考了它的逻辑。

本项目同样以 **GNU GPL v3** 许可证开源（详见仓库根目录 `LICENSE` 文件）。再次感谢上述开源项目打下的基础。

## 许可证

待定（当前私有，未选定开源协议）。
