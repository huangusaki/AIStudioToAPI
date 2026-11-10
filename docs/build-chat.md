# Gemini 4 Argon / Carbon 文本聊天

本维护仓库的 `main` 分支基于上游 v1.4.0，已合入 AI Studio Build 开发助手通道。它与原项目在应用内调用的生成接口不同；原接口配额为零，不代表同一账号不能在 Build 开发助手使用该模型。

保留上游默认应用地址和 `AI_STUDIO_APP_URL` 配置。两条通道共用该应用的账号初始化与连接恢复流程。

## 配置

凭证直接放在原 `configs/auth/`，Argon 与普通模型共用原项目的当前账号和账号切换器，不检查会员等级、不绑定特定邮箱。无需额外的 Build 邮箱或草稿环境变量。

首次使用账号时，从 Build 新应用页面选择 Argon，直接提交客户端的真实消息；不会先发探测或初始化提示词。Google 返回的私有草稿地址按账号保存在 `data/build-drafts.json`，后续复用。请持久化挂载 `data/`，避免重建容器后重新建草稿。

两条通道共用使用次数与失败计数。沿用原项目规则：`IMMEDIATE_SWITCH_STATUS_CODES`（默认 429、503）立即切换，其他失败按 `FAILURE_THRESHOLD`（默认 3）累计，成功清零失败计数；`SWITCH_ON_USES`（默认 40，0 关闭）按合计使用次数轮换。客户端参数错误、并发占用和客户端断开不计入账号失败。Argon 不自动重放已提交的消息，避免重复消耗额度。

复用原 HTTP 服务、API Key、Camoufox 和当前账号 context；连接未就绪时走原项目的启动与恢复流程。Argon 仅在当前账号中打开辅助页面，结束后关闭该页面，保留普通模型页面和 WebSocket；不另建临时账号 context，也不为切换模型回收当前账号。账号切换会先阻止新请求进入，并等待已有辅助页面释放；所有等待均为异步。

## 调用

支持 `gemini-4-argon` 和 `gemini-4-carbon`，也接受 `models/` 前缀。服务根据请求选择开发助手模型，提交与返回结果均核对对应模型 ID；两者共用账号、浏览器、草稿存储和并发限制，无需额外服务。

2026-11-11 页面核查：当前服务器 Pro 账号选择 Carbon 时显示需要 Google AI Ultra 或 Gemini API Key。模型出现在列表不等于账号有权限；服务识别模型解锁弹窗后返回明确 403，不自动开通订阅或绑定 Key。

```json
{
  "model": "gemini-4-argon",
  "messages": [{ "role": "user", "content": "你好" }],
  "stream": true
}
```

地址为原服务的 `POST /v1/chat/completions`；调用 Carbon 时将示例中的 model 改为 `gemini-4-carbon`。有有效账号时 `/v1/models` 会列出两个模型。其他模型保持原通道。Build 模型的其他协议端点暂不支持，返回明确错误。

## 当前边界

- 仅文本输入输出；工具、附件、结构化输出返回 400。
- 同时处理一个 Build 请求，其他 Build 请求返回 429；普通模型请求继续使用原流程。
- `stream: true` 使用 SSE 心跳等待完整答案，最后返回正文及 `[DONE]`，不是逐 token 流式。
- 每次使用独立的新聊天，历史消息以 JSON 文本传给开发助手；system/developer 是文本约定，不是原生 API 系统指令。新聊天不清除草稿文件上下文，请不要把自动创建的草稿用于其他开发任务。
- 不支持采样、输出 token 上限和思考等级等参数控制；传入这些字段时通过 `X-Build-Ignored-Parameters` 响应头列出。不会伪造 token usage。
- 只返回完成的模型正文，过滤思考段；提交和结果均核对模型与任务 ID，不能确认时返回错误。
- 提示开发助手不要使用工具或修改应用，但这不是协议级工具禁用；本适配不能提供原生聊天 API 的完整语义。
- 总等待时间沿用 `FAKE_STREAM_TIMEOUT_MS`。客户端断开、超时或失败时尝试取消生成并关闭临时页。Google 页面和内部响应结构变化可能需要更新适配。

## 后续维护

普通模型若已有原通道权限，通常只需更新 `configs/models.json`。只在 Build 开发助手提供的模型则还需要更新 `BuildChatService.js` 的 UI 选项和模型核对，并实际验证。不能仅在目录中加名字就认定接入成功。
