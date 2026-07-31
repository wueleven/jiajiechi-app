# 小米体重同步 · 功能可行性方案（未实施）

> 状态：**留档评估，未立项**
> 记录日期：2026-07-31
> 参考开源项目：[XiaoSiHwang/garmin-weight-sync](https://github.com/XiaoSiHwang/garmin-weight-sync)（Python，MIT，小米运动健康体重 → 佳明 Connect）
> 结论：技术可行，两项技术风险已实机验证下调为低，成败**收敛到唯一决定性风险——小米账号登录接口的稳定性**；建议先做真实账号登录验证作为立项闸口。

## 背景与目标

把**小米运动健康（Mi Fitness）中的体重/体成分数据**同步到佳明（可扩展至高驰）。链路分三段：

1. **小米账号登录**：`account.xiaomi.com` 账号体系，拿到 `userId / passToken / ssecurity`，passToken 静默续期。
2. **拉取体重数据**：`hlth.io.mi.com/app/v1/data/get_fitness_data_by_time`（key=weight，分页拉全量），返回体重、BMI、体脂率、水分、骨量、肌肉量、内脏脂肪、基础代谢等。该接口有私有加密协议：nonce → `SHA256(ssecurity+nonce)` → **RC4(drop-1024) 加密** → SHA1 签名 → 响应再 RC4 解密。
3. **生成 FIT 并上传佳明**：生成 Weight 类型 FIT（file_id type=WEIGHT + weight_scale 消息，伪装 Garmin Index Scale product=2429），POST 到 `/upload-service/upload/fit`，按时间戳去重。

## 现状复用评估

佳明侧链路**佳捷驰已全部具备**，是最大省力项：

| 模块 | 对应实现 | 复用情况 |
|---|---|---|
| 佳明登录 / token 刷新 / MFA / 自动重登 / 412 提示 | `garminAuth.js`、`garminSync.js` | ✅ 完全复用 |
| FIT 上传端点 `/upload-service/upload/fit` + 去重（409 / 空 uploadId） | `uploadGarminActivity()` | ✅ 体重 FIT 走同端点，去重逻辑通用 |
| 加密原语 SHA256 / SHA1 / MD5 / AES | `utils/crypto.js` | ✅ 补一个 RC4（约 30 行）即可 |
| 原生网络层（CapacitorHttp 绕 CORS、二进制 File 包装防损坏） | `services/http.js` | ✅ 请求小米域名无 CORS，上传侧防损坏已解决 |

## 技术验证结论（2026-07-31 实机验证）

三个风险点做了实机验证（临时脚本跑完即删，未改动项目文件）：

### ✅ 验证一：小米私有加密协议 —— 可用现有 crypto-js 完整移植

将 `client.py` 的 RC4(drop-1024) + SHA256/SHA1 双重签名链做成 Python 参考实现，用项目**现有 crypto-js** 做 JS 移植，对同一输入逐字节比对：标准 RC4 已知向量、`signed_nonce`、`rc4_hash`、RC4 加密 `data` / `rc4_hash__`、最终 `signature` **全部逐字节一致**。

- 影响：**零新增依赖**即可精确复刻，风险由「中高」下调为**低**。

### ✅ 验证二：FIT 编码 —— 可自研，无需引入 FIT SDK 到生产

手写最小 FIT weight_scale 编码器（文件头 + CRC-16 + file_id + weight_scale，约 90 行产出 91 字节），用**官方 `@garmin/fitsdk` Decoder 回读校验**（真规范验证）：`isFIT()`、`checkIntegrity()` 通过，解码错误 0，`weight/percentFat/boneMass/bmi` 字段值精确还原，`file_id.type=weight` 正确。

- 关键字段定义（取自官方 Profile）：weight_scale global=30，weight(field0,uint16,scale100,kg)、percentFat(1,scale100)、percentHydration(2,scale100)、boneMass(4,scale100)、muscleMass(5,scale100)、**bmi(13,uint16,scale10)**、timestamp(253,uint32,FIT 秒)；FIT epoch=631065600。file_id global=0，type=weight(9)、manufacturer=garmin(1)。
- 影响：官方 SDK 仅开发期校验，生产代码手写即可，**不增加包体积**，风险确认为**中偏低**。

### ⚠️ 验证三：小米登录 —— 接口可达，风险维持「高」，需真实账号才能定论

- 已验证：登录 step-1 接口 `account.xiaomi.com/pass/serviceLogin?sid=miothealth` 在 JS 中**可达**，返回符合预期（`&&&START&&&` 前缀 + `_sign`/`qs`/`callback`），`code=70016`（需密码登录），证明链路能起步。响应含 **`captchaUrl` 字段**，从接口层印证「首次登录几乎必然触发验证码」。
- 未消除的不确定性（必须真实小米账号在真机跑通）：密码哈希 + `serviceLoginAuth2` step-2、图形验证码识别、短信 2FA 全流程。
- 长期维护负担：小米登录为非官方逆向接口、无文档、强风控，`micloud` 类库历史上多次因风控加强失效；一旦改版，用户端表现为大面积登录失败，需紧急逆向跟进。性质与 Garmin/COROS 官方 OAuth 的稳定性不在一个量级。

## 需新增 / 改动的代码

新增：

| 文件 | 职责 | 预估行数 | 难度 |
|---|---|---|---|
| `src/services/xiaomiAuth.js` | 小米登录：密码哈希、`serviceLoginAuth2` 链式认证、passToken 续期、图形验证码 + 短信 2FA | ~250 | 高 |
| `src/services/xiaomiClient.js` | 加密请求协议（nonce/RC4/签名）+ `get_fitness_data_by_time` 分页 + 数据解析 | ~200 | 中低（已验证） |
| `src/services/fitEncoder.js` | 最小 FIT weight 编码器（file header + file_id + weight_scale + CRC-16） | ~150 | 中低（已验证） |
| `src/services/weightSync.js` | 体重同步编排：拉小米 → 编码 FIT → 上传佳明，增量水位、去重、记录 | ~150 | 中 |

改动：

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `src/utils/crypto.js` | 补 RC4(drop-1024) 原语 | ~30 |
| `src/services/storage.js` | 新增 `xiaomi` 平台数据结构（token / 水位 / 绑定态） | ~20 |
| `src/services/garminSync.js` | 复用上传，几乎零改动 | ~5 |
| `src/pages/bind/bind.vue` | 小米绑定入口 + 验证码展示 + 2FA 输入（复用现有 MFA UI 模式） | ~120 |
| `src/pages/sync/sync.vue` | 体重同步卡片 + 方向开关（遵循同步页开关 UI 一致性规范） | ~100 |
| `syncOrchestrator.js` / `syncRecord.js` | 接入体重同步类型与记录 | ~40 |

净新增约 780 行、改动约 315 行。

## 工作量预估

| 阶段 | 乐观 | 现实 | 悲观 |
|---|---|---|---|
| 小米登录（JS 重写 + 真机调试验证码/2FA） | 2.0 | **4.0** | 7.0+ |
| 加密协议移植（已验证，仅落地） | 0.5 | **1.0** | 2.0 |
| FIT 编码（已验证，仅落地） | 1.0 | **1.5** | 2.0 |
| 同步编排（weightSync + storage + 去重/水位） | 1.0 | **1.5** | 2.0 |
| UI 集成（绑定页 + 同步页 + 记录） | 1.5 | **2.0** | 3.0 |
| 联调回归（端到端 + 不影响现有三平台同步的零影响红线） | 1.0 | **1.5** | 3.0 |
| **合计** | ~7 | **≈11.5 人天** | ~19 |

（验证后加密/FIT 两项工作量较初评下调，现实基准由 ~13 降至 ~11.5 人天；方差仍主要来自小米登录。）

## 风险等级（验证后）

| 风险点 | 初评 | 验证后 |
|---|---|---|
| 小米加密协议移植 | 🟠 中高 | 🟢 低（已证零依赖可复刻） |
| FIT 编码 | 🟡 中 | 🟢 中偏低（已证官方 SDK 校验通过） |
| 小米登录稳定性与长期维护 | 🔴 高 | 🔴 高（唯一决定性风险，不变） |

## 用户额外授权

比现有平台多一层敏感度：

1. **小米账号密码**：绑定页输入，加密存储（复用 `encryptPassword` AES-256-CBC）。
2. **图形验证码**：首次登录几乎必然出现，需用户看图手输（App 内可内嵌图片，体验优于命令行）。
3. **短信 2FA**：异地/新设备登录时需输入短信码（复用现有 MFA 输入 UI）。
4. 佳明侧无新增授权；新注册佳明账号仍受 412 数据存储授权约束（提示文案已有）。

合规提示：会再引入一个非官方逆向 API（小米），与现有 Garmin/COROS 逆向接入同源风险叠加，需在 README/免责声明中一并说明。

## 建议与待拍板问题

**成败已收敛到唯一一点：小米登录能否稳定跑通。** 建议以「真实小米账号在真机跑通登录 + 拉体重数据」作为立项前的最终闸口（约 2 人天 Spike）：通过则后续均为确定性工作；过不去则不投入。

待拍板：

1. 是否接受"背小米风控这个长期维护雷"？这是决策核心，而非技术能否实现。
2. 立项前是否先做真实账号登录 Spike，还是直接立项开发？
3. 同步方向范围：先做「小米 → 佳明」单向，还是一并规划高驰目标端？
4. 体重同步入口：同步页独立卡片，还是并入"实验功能"区？
