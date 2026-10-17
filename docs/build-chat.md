# Gemini 4 Argon 文本聊天

维护分支 `feat/argon-build` 基于上游 v1.3.7，加入 AI Studio Build 开发助手通道。它与原项目在应用内调用的生成接口不同；原接口配额为零，不代表同一账号不能在 Build 开发助手使用该模型。

## 配置

在 AI Studio Build 建立一个专用、私有、无业务文件的草稿。账号必须能在该草稿设置中选择 Gemini 4 Argon。

```dotenv
BUILD_ACCOUNT_EMAIL=your-account@example.com
BUILD_APP_URL=https://aistudio.google.com/apps/your-draft-id
```

凭证仍放在原 `configs/auth/`，按邮箱定位账号。复用原 HTTP 服务、API Key、Camoufox 和账号池；每个请求临时打开一个页面，用完关闭，不启动第二个浏览器。`MAX_CONTEXTS` 仍然生效。指定账号不在池中时先等待旧请求完成，再正常切换；Build 请求期间延后关闭其账号 context。

## 调用

```json
{
  "model": "gemini-4-argon",
  "messages": [{ "role": "user", "content": "你好" }],
  "stream": true
}
```

地址为原服务的 `POST /v1/chat/completions`。启用配置后 `/v1/models` 会列出模型。原有模型保持原通道。Argon 的其他协议端点暂不支持，返回明确错误。

## 当前边界

- 仅文本输入输出；工具、附件、结构化输出返回 400。
- 同时处理一个 Build 请求，其他 Build 请求返回 429；普通模型请求继续使用原流程。
- `stream: true` 使用 SSE 心跳等待完整答案，最后返回正文及 `[DONE]`，不是逐 token 流式。
- 每次点击新聊天，历史消息以 JSON 文本传给开发助手；system/developer 是文本约定，不是原生 API 系统指令。新聊天不清除草稿文件上下文，因此请使用专用空草稿。
- 不支持采样、输出 token 上限和思考等级等参数控制；传入这些字段时通过 `X-Build-Ignored-Parameters` 响应头列出。不会伪造 token usage。
- 只返回完成的模型正文，过滤思考段；提交和结果均核对模型与任务 ID，不能确认时返回错误。
- 提示开发助手不要使用工具或修改应用，但这不是协议级工具禁用；本适配不能提供原生聊天 API 的完整语义。
- 总等待时间沿用 `FAKE_STREAM_TIMEOUT_MS`。客户端断开、超时或失败时尝试取消生成并关闭临时页。Google 页面和内部响应结构变化可能需要更新适配。

## 后续维护

普通模型若已有原通道权限，通常只需更新 `configs/models.json`。只在 Build 开发助手提供的模型则还需要更新 `BuildChatService.js` 的 UI 选项和模型核对，并实际验证。不能仅在目录中加名字就认定接入成功。
