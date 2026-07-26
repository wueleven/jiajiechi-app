---
kind: build_system
name: 构建与部署系统：微信小程序 + 云函数 + GitHub Actions 流水线
category: build_system
scope:
    - '**'
source_files:
    - project.config.json
    - dailysync-ref/package.json
    - dailysync-ref/Dockerfile
    - dailysync-ref/docker-compose.yml
    - dailysync-ref/.github/workflows/sync_garmin_cn_to_garmin_global.yml
    - dailysync-ref/.github/workflows/daily_sync_rq.yml
    - uploadCloudFunction.sh
---

本项目的构建与部署体系围绕微信开发者工具、Node.js/TypeScript 命令行工具以及 GitHub Actions 持续集成展开，覆盖小程序前端、云函数和 Garmin/COROS 数据同步工具的完整生命周期。

**1. 使用的系统与工具**
- 微信开发者工具：通过 `project.config.json` 统一配置小程序根目录（`miniprogram/`）与云函数根目录（`cloudfunctions/`），启用 ES6、postcss、代码压缩等编译选项。
- Node.js + Yarn：`dailysync-ref` 子项目使用 TypeScript 编写，依赖 `ts-node` 直接运行源码，`nodemon` 用于开发热重载，`tsc -w` 提供 TypeScript 监听编译。
- Docker：`dailysync-ref/Dockerfile` 基于 `node:lts-alpine3.19` 镜像，启用 corepack 并设置时区为 Asia/Shanghai，`docker-compose.yml` 定义 `daily-sync` 服务，默认执行 `yarn sync_cn`。
- GitHub Actions：在 `dailysync-ref/.github/workflows/` 下维护多个工作流，包括 Garmin CN↔Global 双向同步、RQ 数据采集写入 Google Sheets 等定时任务。
- 云函数部署脚本：根目录 `uploadCloudFunction.sh` 调用微信 CLI 的 `cloud functions deploy` 命令，支持指定环境 ID、项目名称及强制覆盖参数。

**2. 关键文件与位置**
- `project.config.json`：微信工程全局配置，声明小程序与云函数根路径、编译开关、AppID、库版本等。
- `dailysync-ref/package.json`：定义所有 npm scripts（`sync_cn`、`sync_global`、`migrate_*`、`rq`、`dev`、`watch` 等），管理运行时与开发依赖。
- `dailysync-ref/Dockerfile` 与 `docker-compose.yml`：容器化构建与运行入口。
- `dailysync-ref/.github/workflows/*.yml`：CI/CD 流水线，通过 `secrets` 注入敏感配置，使用 `actions/setup-node@v3` 固定 Node 14 环境。
- `uploadCloudFunction.sh`：一键部署云函数的 Shell 封装。
- `cloudfunctions/*`：各云函数独立目录，每个包含 `index.js`、`package.json`，部分含 `config.json`。

**3. 架构与约定**
- 多模块并行构建：小程序前端（`miniprogram/`）、云函数（`cloudfunctions/`）、命令行工具（`dailysync-ref/`）各自独立构建与部署，通过微信开发者工具统一编排。
- 脚本驱动：所有构建与运行均通过 `package.json` 中的 npm scripts 或 Shell 脚本触发，无 Makefile 或复杂构建系统。
- 环境变量管理：GitHub Actions 通过 `secrets` 注入认证信息（Garmin 账号、Google API、BARK 通知等），本地开发通过 `.env` 文件配合 `env_file` 注入 Docker 容器。
- 定时任务模式：所有自动化任务均以 GitHub Actions 的 `schedule` cron 表达式驱动，如每 6 小时同步一次、每日 17:30 采集 RQ 数据。

**4. 约定与约束**
- 小程序编译：`project.config.json` 中 `minified`、`minifyWXML`、`minifyWXSS` 均为 `true`，生产构建强制压缩；`es6`、`postcss`、`enhance` 开启现代语法与样式处理。
- Node 版本锁定：GitHub Actions 固定使用 Node 14（`actions/setup-node@v3` with `node-version: '14'`），Docker 镜像使用 LTS Alpine 3.19。
- 云函数部署：必须通过 `uploadCloudFunction.sh` 调用微信 CLI，需传入 `--e ${envId}` 指定环境、`--r` 强制覆盖、`--project ${projectPath}` 指定工程路径。
- 依赖管理：`dailysync-ref` 使用 `yarn.lock` 锁定依赖版本，禁止 `nodeModules` 打包到小程序（`project.config.json` 中 `nodeModules: false`）。
- 日志与存储：Docker Compose 配置 JSON 文件日志驱动，单文件最大 10MB；SQLite 数据库文件位于 `db/` 目录并通过 `.gitkeep` 占位。