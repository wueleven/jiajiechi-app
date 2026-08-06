# 佳捷驰（安卓 App / jiajiechi-app）

「佳捷驰」是一款把**运动手表数据**在不同平台之间互相同步的工具。本仓库是 **Android 原生 App 版本**（基于 Capacitor 8 打包，Web 前端跑在手机本地 WebView 里）。

> 项目仍在持续开发中，功能与文档会不定期更新，欢迎通过 Issue 反馈问题。

## 开发背景（为什么做这个）

1. **本人是个热衷于马拉松训练的跑者**，平时喜欢把运动数据放到各个平台去做分析。跑团里的小伙伴也恰好需要把数据同步到佳明，去参加天梯排名。之前大家一直用「佳某通」，但它更新之后开始收费，太贵了我用不起，而且软件也越来越臃肿，多了很多无关的功能，于是就想自己搞一个，方便跑团团友卷跑量。虽然 RQ 也能卷跑量，但佳明的每月竞赛会颁奖，这一点很棒。
2. **最近听说 AI 编程发展得非常快、效果也很好**。我虽然是计算机相关专业出身，但对编程几乎一窍不通，又是个喜欢折腾的人，就想借这个机会试试用 AI 写一个程序、看看效果到底如何。正好自己就有这个真实需求，就拿它当第一个练手项目。这个app基本完全是使用Qoder国际版以及Hermes agent+hy3配合开发的。
3. **这个项目最初其实是按微信小程序来做的**（同步逻辑跑在微信云函数上），当初想着小程序不用安装方便就按小程序做了，功能基本都测试完成才发现其实小程序是无法上线的。小程序不允许收集用户在第三方平台的账号密码，而 Garmin/COROS 官方又不提供「向平台写入活动」的开放接口——也就是说这个小程序实际上永远无法过审上线。于是只好以小程序版为底子，把整套同步逻辑搬到手机本地，改造成了现在这个安卓版。小程序版的完整代码和提交历史归档在本仓库的 [`archive/miniprogram`](../../tree/archive/miniprogram) 分支，作为一段失败但有价值的弯路留存。
4. **本人对写程序几乎一窍不通，这个应用肯定还有很多 bug**，遇到能修的我会尽量修，但能力有限，不保证完善；文档或代码里若有任何不专业、不合规矩、或冒犯到别人的地方，**非常欢迎指正**，我会认真学习并修正。本项目本意**仅为供跑团跑友及我个人便利使用，不为盈利、也不会刻意推广**；若未来公开发布时有任何不合适、不合规之处，请务必提醒我，必要时我会直接删库处理。尤其要说明的是，本项目参考了若干开源项目（详见文末「参考与致谢」），若对原作者有任何冒犯之处，在此先行致歉。

> **账号与隐私声明**
>
> 1. **数据存储**：用户在各运动平台（Garmin 国行 / Garmin 国际服 / COROS 高驰）的账号及密码，仅以加密形式存储于用户本人设备本地，本软件不设立亦不接入任何远端服务器，不会将上述凭证上传、传输或披露给任何第三方。
> 2. **使用范围**：所存储的账号凭证**仅限于**向相应运动平台发起身份认证、及在此基础上执行用户主动触发的运动数据同步，不作任何其他用途。
> 3. **责任限制**：用户应自行妥善保管其设备与账号安全。因用户设备遗失、保管不善、或平台方政策变更等原因所导致的任何账号安全问题、数据异常、同步失败或其他损失，本软件作者**不承担任何责任**。本软件按"现状"提供，不对其适用性、安全性或可靠性作出明示或暗示的担保。
> 4. **使用限制**：本软件**仅供个人学习及研究使用**，不得用于任何商业用途，亦不得用于任何违反法律法规或侵犯第三方合法权益的用途。因违反上述约定所产生的任何后果，由使用者自行承担。

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

此外，打开 App 或从后台回到前台时会自动同步最近的运动记录（数量与开关可在同步页设置），省去手动点同步的步骤。

## 技术架构

- **前端**：Vue 3 + Vue Router + Vite（写界面和逻辑）
- **壳**：Capacitor 8 把它打包成安卓 App，运行在手机本地，不依赖服务器
- **网络请求**：自己封装的 `http.js`，在手机本地发请求，对接各家运动平台接口
- **加密与压缩**：`crypto-js`（Garmin 老接口需要 OAuth1 签名）；`jszip`（处理活动文件的压缩包）

代码位置：

```
src/
  pages/          # 页面：首页(index)、账号绑定(bind)、同步(sync)、记录(history)、关于(about)
  services/
    garminAuth.js / garminSync.js   # Garmin 登录与上传下载
    corosAuth.js / corosSync.js     # 高驰登录与上传下载
    http.js        # 统一网络请求层
    syncOrchestrator.js  # 同步总调度（决定谁同步给谁、去重、重试）
    syncRecord.js  # 同步记录（App 内"记录"页的数据）
    storage.js     # 本地存储（账号、token 等）
    autoSync.js    # 打开 App / 回到前台时自动同步
  utils/
    crypto.js      # 加密与签名辅助
    oauth1.js      # Garmin OAuth1 签名
    keyboard.js    # 键盘弹出时的弹窗适配（输入框不被遮挡）
```

## 本地构建与运行（给开发者）

环境要求：

- Node.js（建议 18+）
- JDK 21（Capacitor 8 打包安卓必须用 JDK 21）
- Android SDK（platforms;android-36 + build-tools;36.0.0）
- Gradle（无需手动安装，项目自带的 `gradlew` 会自动下载 8.14.3）
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

- **重复活动识别**：同步前先查本地同步记录去重；上传时 Garmin 返回 `409` 或静默去重（响应中 `uploadId` 为空）都会标记为「跳过」；往高驰同步因其导入接口为异步处理不返回重复信息，改为上传前预检高驰最近 200 条活动的开始时间判重，更早的重复活动由高驰后台自行去重（不会产生重复数据，但会显示「成功」）。
- 本项目为纯本地运行，**不使用任何云函数**，所有请求从手机直接发出。
- 代码中内嵌的 COROS 应用编号等为平台通用常量（所参考的开源项目中同样公开使用），不属于个人密钥；用户的账号密码、登录凭证只保存在手机本地，不会进入本仓库。签名 keystore 已被 `.gitignore` 排除。

## 参考与致谢

本项目在开发过程中参考了下列优秀的开源项目，在此郑重感谢原作者们的无私分享。需要特别说明的是：**本项目为自行实现，但部分接口流程、参数结构与平台私有常量参考了下述项目（尤其是 COROS 侧的 STS 凭证、上传与导入流程，以及 Garmin 的 SSO 登录与 OAuth 令牌交换流程），并非完全从零独立探索；源代码为各自用 JavaScript/TypeScript 重新编写，未直接复制其源文件。**

- **running_page**（GitHub，by [@yihong0618](https://github.com/yihong0618)）：[github.com/yihong0618/running_page](https://github.com/yihong0618/running_page)
  本项目佳明侧的 SSO 登录与 OAuth 令牌交换流程，参考了它的实现思路。
- **garmin-sync-coros**（GitHub，by [@XiaoSiHwang](https://github.com/XiaoSiHwang)）：[github.com/XiaoSiHwang/garmin-sync-coros](https://github.com/XiaoSiHwang/garmin-sync-coros)
  本项目高驰侧的上传、导入机制，参考了它的实现思路。
- **dailysync**（GitHub，by [@gooin](https://github.com/gooin)，采用 **GNU GPL v3** 许可证）：[github.com/gooin/dailysync-rev](https://github.com/gooin/dailysync-rev)
  本项目国服/国际服互传的同步逻辑，参考了它的处理方式。

本项目同样以 **GNU GPL v3** 许可证开源（详见仓库根目录 `LICENSE` 文件）。再次感谢上述开源项目打下的基础。

## 许可证

本项目采用 **GNU GPL v3** 许可证开源，详见仓库根目录 [LICENSE](LICENSE) 文件。
