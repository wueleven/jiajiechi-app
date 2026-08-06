# 账号密码输入无法顺利输入 · 修复方案（未实施）

> 状态：**待拍板，未实施**
> 记录日期：2026-08-06
> 相关页面：`src/pages/bind/bind.vue`（账号/密码/MFA 弹窗）、`src/pages/sync/sync.vue`（MFA 弹窗）
> 跟进自 2026-08-05 分析（输入框"多次点击无法正常输入"），本次补充了构建产物层面的根因确认。

## 问题现象

- 测试用户反馈：绑定账号时输入账号/密码**经常无法顺利输入**，要点很多次才进得去。
- 涉及三个输入场景：bind.vue 账号/密码弹窗、bind.vue MFA 验证码弹窗、sync.vue MFA 验证码弹窗，均为 fixed 居中弹窗。
- **测试用户设备为未知安卓手机（品牌不明）**；开发者使用的 vivo（OriginOS WebView）可复现类似状况，仅作为开发复现环境。
- **问题定性：通用 Android WebView 键盘适配缺陷**（`adjustPan` 整窗平移 + fixed 居中弹窗），不限定于特定品牌，任何 ROM/WebView 组合都可能触发。

## 现状核实（2026-08-06 代码核对）

1. `android/app/src/main/AndroidManifest.xml`：MainActivity **未声明 `windowSoftInputMode`**（默认 `adjustUnspecified`）。
2. 构建产物（`android/app/build/intermediates/.../mergeDebugResources/merger.xml` 等）中可见 `stateUnspecified|adjustPan` 出现 3 处——来自依赖库主题链（Capacitor / AndroidX SplashScreen），即**实际运行主题生效的是 `adjustPan`**。
3. `values/styles.xml`：`AppTheme.NoActionBarLaunch` 继承 `Theme.SplashScreen`，无软键盘模式项。
4. bind.vue 登录弹窗：账号/密码两个 input，**无** `autofocus` / `autocapitalize` / `autocorrect` / `autocomplete`；弹窗无 form 包裹、无键盘适配。
5. sync.vue MFA input：`type="number" maxlength="6"`——**`maxlength` 对 `type="number"` 不生效**（已知 Web 行为）；bind.vue MFA 用 `type="text" inputmode="numeric"`（正确）。
6. 全项目 **无任何键盘适配 JS**：无 `visualViewport` / `resize` / `scrollIntoView` / `focus()` 逻辑（grep 零命中）。

## 根因分析（按权重）

| # | 根因 | 机制说明 |
|---|---|---|
| 1 | **软键盘模式为 `adjustPan`**（继承自库主题） | 键盘弹出时**整个窗口平移上移、layout viewport 高度不变**。fixed 居中弹窗被顶起 → 视觉位置与手指点击坐标错位；键盘收起时窗口弹回 → 弹窗"跳动"。焦点在跳变中丢失，表现即"反复点不中、输不进"。这是最主要的机制差异：`adjustResize` 会真正缩小视口，配合 JS 滚动可以精确、可预期地定位到输入框。 |
| 2 | **fixed 居中弹窗 + 无键盘适配** | 弹窗 `align-items:center` 垂直居中，键盘占掉一半屏幕后剩余空间不足，输入框可能被键盘遮住或被顶到屏幕外；无 `visualViewport` 监听、无自动聚焦，键盘弹出时页面不做任何补救。 |
| 3 | **部分 WebView 的 IME 连接特性**（开发机上为 vivo OriginOS 复现） | "第一击激活、第二击聚焦"是部分 ROM/WebView 的已知通用表现（非品牌独有），叠加前两条后体感被放大。缓解方向：保证焦点稳定不跳、点击热区足够大、弹窗位置不抖动。 |
| 4 | 密码框 `type="password"` 不可见 | 用户输入后看不到内容，容易误判"没输进去"而反复点击，体感上加重"无法输入"的印象。 |
| 5 | sync.vue MFA `type="number"` | `maxlength` 无效（小问题，JS 侧已有长度校验），但部分 ROM 数字键盘缺少"完成"键，应统一为 `text + inputmode="numeric"`。 |

## 修复方案（分层，可逐层推进）

### L0 最小改动（零风险，强烈建议先做）

1. **`AndroidManifest.xml` MainActivity 加一行**：
   ```xml
   android:windowSoftInputMode="adjustResize"
   ```
   将"整窗平移"改为"视口真正缩小"，这是后续 JS 键盘适配能生效的前提，也是解决弹窗跳动的基础。
2. **bind.vue / sync.vue 输入框补属性**（隐私红线：一律 `autocomplete="off"`，不启用系统自动填充，凭证不出手机）：
   - 账号框：`autocapitalize="none" autocorrect="off" autocomplete="off" inputmode="email"`（COROS 支持邮箱/手机号，`inputmode="email"` 更贴切；或保留默认）
   - 密码框：`autocapitalize="none" autocorrect="off" autocomplete="off"`
   - sync.vue MFA：`type="number"` → `type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6"`（对齐 bind.vue MFA 的正确写法，让 `maxlength` 生效）

### L1 弹窗键盘适配（JS + CSS，改动集中、风险低）

3. **打开弹窗自动聚焦首个输入框**：`openBindModal` / MFA 弹窗打开时 `nextTick(() => inputRef.focus())`，让焦点一次就位，缓解"第一击激活"。
4. **全局键盘适配函数**（建议放 `src/utils/` 或 App.vue 全局）：
   - 监听 `window.visualViewport.resize`（兜底 `window.resize` + `orientationchange`），键盘弹出（视口高度显著缩小）时：
     - 弹窗容器由垂直居中改为顶部对齐 + 顶部留白（`padding-top`）；
     - 限制弹窗 `max-height: calc(100vh - 键盘可视高度 - 留白)`，内容可内部滚动；
     - 对当前聚焦输入框执行 `scrollIntoView({ block: 'center' })`，保证输入框始终在键盘上方可见。
5. **密码可见切换**：密码框加"小眼睛"按钮切换 `type=password/text`，消除"看不到内容以为没输上"的误判。
6. **输入热区 ≥ 44px**：bind.vue 输入框当前约 38px 高，`padding` 加至 44px 级，降低点不中概率。

### L2 结构优化（彻底方案，改动较大，按需选择）

7. **弹窗改底部抽屉（bottom sheet）**：`fixed bottom:0` + 圆角 + `safe-area-inset-bottom`，在 `adjustResize` 下天然贴着键盘上方，不居中挤压、位置稳定；两个 MFA 弹窗优先改。
8. **绑定表单独立成路由页**：账号/密码表单放正常文档流页面（页面整体可滚动），键盘交互与普通页面一致，兼容性最强（vivo 等 ROM 问题基本消失）。改动面：bind.vue 弹窗 → 新页面或内嵌子路由。
9. **表单化**：`<form @submit.prevent>` 包裹 + `enterkeyhint="next"/"done"`，回车可跳下一框/提交，减少点击次数。

### L3 真机验证清单

- [ ] 开发者 vivo（复现机）：冷启动 → 绑定页 → 输入账号 → 密码 → MFA 验证码，全程键盘弹出/收起无跳动、一次点中
- [ ] 至少一台原生 Android（如 Pixel / 其他 ROM）回归同场景，确认修复不依赖品牌
- [ ] **测试用户（未知设备）回归**：确认问题在其设备上也消失
- [ ] 键盘弹出时输入框始终可见、可滚动到
- [ ] 密码可见切换正常；MFA 数字键盘弹出且最多 6 位
- [ ] 原有功能回归：绑定成功/失败提示、MFA 流程、同步流程不受影响

## 建议路线

1. **先落地 L0**（1 行 Manifest + 输入属性，零风险）→ 打包真机验证。若复现机或测试用户设备上仍有输入法问题，继续：
2. **落地 L1 的 3/4/5**（自动聚焦 + 键盘适配 + 密码可见）→ 再验证。
3. 仍不理想或用户愿意接受结构改动 → **L2**（MFA 改底部抽屉 + 绑定表单独立页）。
4. 每步验证通过后再进入下一步，避免一次大改难定位。

## 隐私红线核对

- 全程纯本地改动：无网络请求、无服务器、无埋点。
- `autocomplete="off"` 关闭系统自动填充，凭证（账号密码）不交给 Android Autofill / GMS，守住"凭证不出手机"承诺。
