---
kind: logging_system
name: 日志系统 — 基于 console 的原生输出与微信云开发内置日志
category: logging_system
scope:
    - '**'
source_files:
    - miniprogram/app.js
    - cloudfunctions/garminAuth/index.js
    - cloudfunctions/corosSync/index.js
    - dailysync-ref/src/utils/garmin_cn.ts
    - dailysync-ref/src/utils/garmin_global.ts
    - dailysync-ref/src/utils/garmin_common.ts
---

本仓库未引入第三方日志框架，整体采用 JavaScript/TypeScript 原生 `console` 对象进行输出，并结合微信小程序云开发的内置日志能力。具体表现如下：

1. **使用的系统与工具**
   - 云函数（cloudfunctions 下各模块）与 dailysync-ref 命令行工具均直接使用 `console.log`、`console.error` 等原生 API 输出调试信息。
   - 微信小程序前端通过 `wx.cloud.init({ traceUser: true })` 启用云开发的用户追踪日志，所有 `wx.cloud.callFunction` 调用会由云开发平台自动记录请求上下文与错误堆栈。
   - dailysync-ref 的 CI/CD 场景使用 `@actions/core` 的 `core.setFailed()` 将错误上报到 GitHub Actions 日志。

2. **关键文件与位置**
   - 云函数入口统一在 `cloudfunctions/*/index.js` 中，错误处理集中在 try/catch 块内，通过 `console.error("xxx error:", err)` 输出异常。
   - 微信小程序初始化位于 `miniprogram/app.js`，通过 `traceUser: true` 开启用户级日志追踪。
   - dailysync-ref 的各 utils 模块（如 `src/utils/garmin_cn.ts`、`garmin_global.ts`、`garmin_common.ts`）大量使用 `console.log` 打印同步进度、用户信息与异常。

3. **架构与约定**
   - 无统一的 logger 模块或日志配置中心，每个文件按需直接调用 `console` 方法。
   - 错误日志统一以 `console.error("模块名 error:", err)` 的形式输出，便于在云开发控制台或 CI 日志中快速定位。
   - 业务调试日志以 `console.log` 为主，内容多为中文描述性文本，包含活动名称、时间、ID 等关键字段，属于“人类可读”的调试输出而非结构化日志。
   - 小程序端依赖微信云开发平台的 `traceUser` 能力收集调用链日志，不自行封装日志采集逻辑。

4. **约定与约束**
   - 未发现强制性的日志级别规范（如 info/warn/error/fatal 的统一枚举），仅观察到 `console.log` 和 `console.error` 两种用法。
   - 未定义结构化日志格式（如 JSON 行、固定字段集合），日志为自由文本，不利于机器解析与聚合。
   - 未在代码中发现日志开关、采样率、输出目标（文件/远程服务）等配置项，所有输出均直接写入标准输出流。
   - 在 dailysync-ref 的 CI 场景中，通过 `core.setFailed(err)` 将错误状态传递给 GitHub Actions，这是该子项目唯一的“结构化上报”方式。

总体而言，本项目采用最简化的原生 console 日志方案，配合微信云开发的 traceUser 功能完成基础的可观测性，没有独立的日志框架、集中式配置或结构化输出规范。