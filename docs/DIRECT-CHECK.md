# 不接管 Codex 网络的核验方式

调查和实测日期：2026-10-22。

## 当前会话的直接证据

官方源码的 [response_model](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs) 读取响应事件 headers / response.headers 中的 OpenAI-Model。普通 response.model 不会被该内部事件当成 ServerModel 处理，两者不能混为一谈。

[session 模块](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/mod.rs) 在收到服务器模型时会记录精确的 server reported model 诊断；不一致时发送 model_reroute 事件。本程序只读这些明确事件，不把任意 model 字段或 safety buffering 的 faster_model 当成主回答模型。

本机诊断数据库及近期会话抽查没有这类服务器模型事件。因此不能给当前桌面对话显示“一致”。新版加入监听后，未来有明确事件才会更新判断；不存在事件不是“一致”的证据。

## 为什么读取全部日志也拿不到

官方 [SQLite 日志过滤器](https://github.com/openai/codex/blob/main/codex-rs/state/src/log_db.rs) 将传输正文和 SSE 目标限制在 DEBUG，并关闭 legacy log 目标；[feedback 过滤器](https://github.com/openai/codex/blob/main/codex-rs/feedback/src/lib.rs) 同样抑制大量请求与响应内容。调高其他日志级别不能保证这些存储会保留原始模型响应。

官方 [环境变量文档](https://learn.chatgpt.com/docs/config-file/environment-variables) 说明 RUST_LOG 控制 CLI/app-server 诊断，exec 在标准输出/错误流上输出诊断。因此本版本仅对独立抽检子进程开启定向诊断，内存解析后立即丢弃原始数据。没有为桌面全局设置 RUST_LOG，也没有改其启动命令。

## 独立抽检

思路参考 [codex-routing-detector](https://github.com/darkdarkcocoa/codex-routing-detector) 的 trace 模式，独立实现，没有复制代码。使用官方 CLI 发起固定短请求并读入站完成事件，排除空预热响应、失败和取消。比较的是 CLI 调用参数与服务器 response.model，结果明确标为抽检。

本机全局 CLI 0.150.1 被服务器以“需要新版 Codex”拒绝。改用桌面自带 0.163.0-alpha.10.2 后成功取得 gpt-6-astra → gpt-6-astra。未使用回答自述判断模型。

它不改变主会话的模型选择、provider、连接地址或 TLS。仍会使用额度和少量计算/网络资源，不能承诺绝对零开销。一次抽检不能证明其他对话、不同推理强度、不同时间或所有后续请求的路由。

## 其他方案的取舍

- ChatGPT 浏览器：参考 [chatgpt-route-inspector](https://github.com/Liu-Bot24/chatgpt-route-inspector)，观察页面已有响应；适用于网页，不能读取桌面 Codex 的 Rust 网络栈。
- OTel：官方文档列出 model、请求状态和事件指标，但不保证普通 model 标签来自响应。不能以此制造已核验状态。
- 实时 TLS 代理：可以看到每轮字段，但让请求依赖中间转发，与“检测器退出也不影响 Codex”的目标冲突。本版本不启用。
- 给桌面 app-server 注入、改二进制或安装根证书：未采用。

如果必须逐轮得到原始 response.model，当前桌面版需要提供受支持的只读事件出口，或接受启动诊断/代理等额外改动；现有日志不足时，本程序明确保留无法核验。
