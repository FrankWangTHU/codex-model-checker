# Codex Model Checker

白色、简洁的 Windows 桌面 mini 窗口，汇总 **Codex + ChatGPT** 请求模型与服务器报告的响应路由，重点提示 **GPT-6 Astra 请求返回其他模型标识**。

![桌面 mini 窗口](docs/images/mini-window.png)

这是模型字段的一致性检查工具。它不能证明服务器实际运行的模型权重，也不通过回答速度、写作风格或模型自述判断“降智”。本项目独立开发，不隶属于 OpenAI。

## v0.1.1 修复说明

旧版增强代理可能导致 Codex 502，现已从运行路径移除。升级后自动恢复可识别的旧配置，随后请完全退出并重开 Codex。不要再启用 v0.1.0 的增强代理。

## 安装与使用

1. 在 [Releases](https://github.com/FrankWangTHU/codex-model-checker/releases) 下载 Windows x64 安装包与扩展 ZIP，可用 `SHA256SUMS.txt` 校验文件。
2. 运行安装包。程序默认启用 Windows 登录后在托盘后台启动；启动 Codex 或打开已连接的 ChatGPT 页面时显示小窗。可在托盘关闭自启动。
3. 解压扩展 ZIP，在 `edge://extensions` 或 `chrome://extensions` 开启开发者模式，选择“加载解压缩的扩展”，选中含 `manifest.json` 的目录。无需安装第三方同类扩展。
4. 在桌面小窗选择“设置 → 生成配对码”。点击浏览器扩展图标，输入 8 位配对码。配对码 5 分钟有效、只能使用一次；Chrome 和 Edge 分别配对。
5. 刷新已打开的 ChatGPT 页面，发送新消息。小窗将显示可取得的请求模型、响应路由和判断；点击记录可查看原始字段名及模型值。
6. Codex 会话日志和诊断数据库自动只读监听。只有服务器模型诊断或 `model_reroute` 事件才可直接比较；普通会话模型不算响应证明。
7. 在“设置 → Astra 独立抽检 → 抽检一次”启动短请求。优先使用桌面自带 CLI，沿用现有登录；会消耗额度，结果仅代表这次独立请求，在记录中标为“抽检”。支持取消，90 秒超时，不自动重试。

关闭小窗会收回托盘；托盘菜单提供彻底退出。程序不会再因进程检测超时自动隐藏。若升级恢复失败，可使用托盘“恢复 Codex 配置”，或运行安装目录中的 `Codex Model Checker.exe --restore-proxy` 后完全重启 Codex。

## 如何理解结果

| 结果 | 含义 |
| --- | --- |
| 一致 | 网络请求/响应字段或 Codex 服务器诊断中的模型一致；独立抽检另标“抽检”，比较 CLI 参数与本次响应 |
| 不一致 | 请求与显式响应路由不同；Astra 请求默认触发红色状态及一次静音系统通知 |
| 无法核验 | 缺少网络请求模型、缺少显式响应路由、只有模型标签/会话日志，或属于独立工具任务 |
| 证据冲突 | 同一请求中的响应路由字段或模型标签相互矛盾 |
| 自动路由 | 网络请求指定 `auto` 且取得显式响应路由 |

`assistant.metadata.model_slug` 是模型标签，独立展示，**不会仅凭标签判定一致**。显式响应字段包括 `response.model`、标准响应对象 `model`、`resolved_model_slug`、`server_ste_metadata.model_slug`。不同字段冲突时不会选择性忽略证据。未知模型后缀不会自动归入 Astra。

## Codex 支持边界

- 会话日志：读取当日和前一日 JSONL；普通 `turn_context.model` 仅是会话请求侧证据。`codex-auto-review` 单独标为专用工具，不覆盖主卡片。
- 当前会话直接核验：只读 `logs_2.sqlite` 中 Codex 的精确服务器模型诊断，以及 JSONL 中的 `model_reroute`。SQLite 每 5 秒按 ID 分批读取，零锁等待，随后关闭连接。日志不可读不影响 Codex 请求。支持 `CODEX_HOME` / `CODEX_SQLITE_HOME`；自定义配置文件中的 `sqlite_home` 尚不自动解析。
- **没有服务器字段时仍然无法核验。** 当前版本不能从正在运行的桌面进程中无侵入地补回未记录的响应正文；不能根据模型自述或上下文标签推断替换。
- 独立抽检：调用官方 CLI 的 `exec --ignore-user-config --ephemeral --sandbox read-only`，在空临时目录执行固定 pong 请求，诊断开关仅作用于子进程。不接管主会话，不读取主会话内容，不更改连接设置。抽检忽略用户配置，因此不代表自定义 provider、profile 或当前桌面对话的路由。
- 抽检从入站 `response.created` / `response.completed` 取 `response.model`，按响应 ID 关联；只采用成功完成且含助手消息的响应，忽略空预热响应、失败、取消和缺失数据。请求证据是 CLI 调用参数，并非抓获的网络请求字段。
- CLI 不存在、版本不兼容、认证失败或网络不可用会明确报告；不自动安装 CLI，也不切换账号或模型。沿用环境代理；桌面启动时可从系统代理解析出 HTTP(S) 代理，仅传给抽检子进程。

详见 [直接核验调查](docs/DIRECT-CHECK.md) 和 [兼容性记录](docs/COMPATIBILITY.md)。

## 隐私与本地数据

模型检测记录仅存在 `%APPDATA%\Codex Model Checker`，默认保留最近 30 天、最多 10,000 条。窗口列出最近 500 条，导出包含全部保留记录。可以清空全部检测记录。

不保存提示词、回答正文、Cookie、认证头或原始流量；不会将检测数据上传到第三方服务器。浏览器通过 `127.0.0.1:43821` 与桌面通信，使用单次配对码、令牌及扩展来源校验。v0.1.1 不再启动模型代理端口。

抽检诊断流只在内存解析，不保存原始流、提示词或回答正文。CLI 自身可能按其默认行为维护缓存和诊断元数据；检测器不读取登录令牌、不复制认证文件。旧版配置备份可能包含敏感设置，恢复成功后删除。详情见 [PRIVACY.md](PRIVACY.md)。

## 开发与打包

需要 Windows x64、Node.js 24 或更新版本。首次构建会下载 Electron 和 NSIS；下载失败时按自身网络环境设置 `HTTPS_PROXY`，不要关闭 TLS 或校验。

```powershell
npm ci
npm run typecheck
npm test
npm start
```

```powershell
npm exec -- playwright install chromium
npm run test:browser
$env:CMC_BROWSER_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm run test:browser
Remove-Item Env:CMC_BROWSER_PATH
npm run test:ui
npm run package
```

产物：`release/Codex Model Checker Setup 0.1.1.exe`、`release/model-checker-extension-0.1.1.zip`、`release/SHA256SUMS.txt`。开发构建不会在首次启动自动注册登录项；打包版本默认注册。安装包未购买代码签名证书。

CI 在推送和 PR 时运行类型检查、核心集成测试、桌面与 Edge 离线端到端测试并生成安装包。成功的 `main` 构建按 package.json 版本创建 Release；已有版本不覆盖，后续发布使用新版本标签。

## 实现结构与参考

- `src/core`：共享模型比较、白名单提取、SSE 解析和记录类型。
- `src/main`：托盘窗口、本地桥接、只读诊断、独立抽检、日志增量读取及记录存储。
- `src/extension`：页面原生 API 观察、隔离桥、扩展后台及配对页面。
- `tests`：模型判定、协议转发、取消、故障、并发、隐私、配置恢复、浏览器和桌面集成测试。

技术思路参考 [Liu-Bot24/chatgpt-route-inspector](https://github.com/Liu-Bot24/chatgpt-route-inspector)。本项目没有复制其源码、品牌或图片。项目代码使用 MIT 许可证，依赖遵循各自许可证。
