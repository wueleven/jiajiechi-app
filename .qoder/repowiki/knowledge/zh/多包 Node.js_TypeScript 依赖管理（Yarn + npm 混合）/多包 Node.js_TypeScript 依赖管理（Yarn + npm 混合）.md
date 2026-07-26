---
kind: dependency_management
name: 多包 Node.js/TypeScript 依赖管理（Yarn + npm 混合）
category: dependency_management
scope:
    - '**'
source_files:
    - dailysync-ref/package.json
    - dailysync-ref/yarn.lock
    - cloudfunctions/corosSync/package.json
    - cloudfunctions/garminAuth/package.json
    - cloudfunctions/garminSync/package.json
    - cloudfunctions/syncRecord/package.json
---

本仓库采用多包结构，依赖管理分散在多个独立的 package.json 中，未使用 monorepo 工具（如 lerna、pnpm workspace、yarn workspaces），各子模块独立声明依赖并各自锁定版本。

1. 使用的系统与工具
- dailysync-ref：基于 Yarn v1（lockfile v1），通过 yarn.lock 锁定所有依赖的精确版本与镜像源（npmmirror.com），是仓库中唯一存在 lockfile 的位置。
- cloudfunctions 下四个云函数（corosSync、garminAuth、garminSync、syncRecord）：每个目录独立维护 package.json，仅声明运行时依赖，未生成或提交 lockfile，由微信云开发平台在安装时解析语义化版本范围。
- miniprogram 前端：未发现 package.json，依赖由微信开发者工具/小程序框架隐式提供，不在本仓库内显式声明。

2. 关键文件与位置
- dailysync-ref/package.json：命令行工具的依赖清单，包含业务依赖（axios、garmin-connect、googleapis、strava-v3、sqlite3 等）与开发依赖（typescript、ts-node、nodemon）。
- dailysync-ref/yarn.lock：完整的依赖树锁定文件，固定了所有依赖及其子依赖的版本与来源镜像。
- cloudfunctions/*/package.json：四个云函数各自的依赖声明，核心公共依赖为 wx-server-sdk（~2.6.3），其余按功能引入 axios、form-data、oauth-1.0a、@aws-sdk/client-s3、jszip 等。

3. 架构与约定
- 按功能拆分包：每个云函数是一个独立 npm 包，职责单一（认证、同步、记录管理、COROS 推送），避免共享依赖膨胀。
- 版本策略差异：dailysync-ref 使用精确锁定（yarn.lock）保证构建可重现；云函数使用语义化范围（如 ^1.6.0、~2.6.3），由部署平台决定最终安装版本。
- 无私有仓库配置：未发现 .npmrc、.yarnrc 或 GOPRIVATE 等私有源配置，依赖均从公开镜像（npmmirror.com）拉取。
- 无 vendoring：未使用 node_modules 提交或 vendor 目录，依赖均在安装时下载。

4. 约束与观察到的规则
- dailysync-ref 必须通过 Yarn v1 安装依赖（lockfile v1 格式），且构建产物依赖 yarn.lock 中固定的版本。
- 云函数依赖版本使用较宽松的语义化范围（^、~），未做严格锁定，升级可能随平台默认行为变化。
- 所有 Node.js/TypeScript 项目均未使用 monorepo 依赖提升，不存在跨包共享依赖的统一管理。
- 未发现 Go 语言依赖管理文件（go.mod/go.sum），本仓库不涉及 Go 依赖。