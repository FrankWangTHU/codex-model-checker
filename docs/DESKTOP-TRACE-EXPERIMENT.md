# 桌面对话旁路核验实验

测试日期：2026-10-22；后台程序：`codex-cli 0.163.0-alpha.10.2`。

## 已完成的验证

| 环节 | 方法 | 结果 |
| --- | --- | --- |
| 真实服务器响应模型 | 使用桌面自带同一后台程序，创建独立临时 app-server 测试会话，固定 pong 提示 | 完成事件含 `response.model=gpt-6-astra`，请求参数也是 `gpt-6-astra` |
| 当前配置保护 | 测试前后计算真实 config.toml 的 SHA-256 | 相同，没有写入连接代理 |
| 单靠诊断 span 关联 | 检查原始 WebSocket 收到消息的 JSON 日志及 last_model_response_id | 不足：这些事件不含明确对话/轮次上下文，不使用时间猜测 |
| 通过消息 ID 关联 | 在独立本地模拟环境，比较完成响应的 output 助手消息 ID 与 JSONL response_item.id；取同一记录所属 session_meta 和 turn_context | 通过：明确关联到相同对话、轮次、请求模型 |
| 桌面日志格式 | 按已安装程序的 stderr/debug 序列化规则生成固定测试日志，用只读观察器解析，再关联真实后台生成的模拟会话 JSONL | 通过；这是日志格式模拟，不是正在运行的桌面端集成测试 |
| 临时状态清理 | 完全隔离的模拟 CODEX_HOME 和 SQLite 路径在测试后清理，保留模型元数据报告 | 完成；没有复制登录文件 |

真实账号测试和模拟测试相互独立，不能把模拟关联结果当作对当前对话的实测结论。真实账号测试使用短请求，会消耗额度；后续协议排查均改为本地模拟服务。

## 尚未完成

**仍未证明实际桌面进程重启后会完整转存这些诊断流，也未证明当前这条桌面对话的逐轮检测已经可用。**

最后一步需要在用户确认后，以定向 RUST_LOG 和 CODEX_MAX_LOG_LEVEL=debug 启动真实桌面。该次启动的请求仍由 Codex 直连，不经过检测器代理。但桌面自身可能将完整诊断写入本地日志，包含对话正文，有性能和磁盘开销，因此不默认开启，也不自动结束正在运行的 Codex。

## 可执行实验工具

- `scripts/test-appserver-trace.mjs`：显式手工执行的诊断实验，不属于 npm test，不在应用启动时执行。`--mock` 仅用本机模拟服务与临时 CODEX_HOME，不消耗模型额度。没有 `--mock` 时会调用真实账号。
- `scripts/start-desktop-diagnostic.ps1`：拒绝在当前桌面程序仍运行时启动；不自动杀进程。仅为新启动的桌面进程设置环境变量，不写全局环境、模型配置、代理或证书。记录启动时间、配置哈希和原有日志清单。
- `scripts/read-desktop-models.mjs`：只读桌面诊断日志及会话 JSONL，只输出/保存模型、响应 ID、助手消息 ID、对话和轮次元数据。只有唯一明确消息 ID 关联才比较；缺失保持未知，重复关联视为冲突。

启动实验（先保存工作、完全退出 Codex）：

```powershell
pwsh -NoProfile -File .\scripts\start-desktop-diagnostic.ps1
```

在原对话发一条短消息，随后读取结果：

```powershell
node scripts/read-desktop-models.mjs
```

退出本次诊断 Codex 后，从正常快捷方式启动即可停用临时开关。原始诊断日志不会因退出自动消失；应按实验启动前保存的日志清单，审查并只清理本次新建的诊断文件，不删除既有日志。

## 当前限制

- 实验成功后已于 v0.1.2 集成小窗，实验脚本仍仅用于手工调试。
- 当前仅实验性支持上述 Windows 安装布局与日志格式；程序升级可能改变路径或编码。
- 超过读取上限、诊断被截断、日志轮转、对话 fork 导致同一消息 ID 出现于多个上下文时，不作肯定判断。
- 只能读服务器报告的模型标识，不能独立证明后端权重。

官方说明：[诊断环境变量](https://learn.chatgpt.com/docs/config-file/environment-variables)、[App Server 协议](https://learn.chatgpt.com/docs/app-server)。

直接 exe 启动可能使用 `%LOCALAPPDATA%\Codex\Logs`；产品已同时监听两个目录。原实验读取脚本可通过 `--session` 指定修正目录后的元数据文件。
