const { randomUUID } = require("crypto");
const { extractSnapshots } = require("./BuildProtocol");

const MODEL = "gemini-4-argon";
const matchesRpc = (response, method) => response.url().endsWith(`.MakerSuiteService/${method}`);
const failure = (status, message) => Object.assign(new Error(message), { status });

function normalizeMessages(body) {
    if (!Array.isArray(body.messages) || !body.messages.length) throw failure(400, "messages must be a nonempty array");
    for (const key of [
        "tools",
        "functions",
        "tool_choice",
        "function_call",
        "response_format",
        "audio",
        "modalities",
    ]) {
        if (body[key] != null) throw failure(400, `Build text chat does not support ${key}`);
    }
    if (body.n != null && body.n !== 1) throw failure(400, "Build text chat only supports n=1");
    return body.messages.map(message => {
        if (!message || !["system", "developer", "user", "assistant"].includes(message.role) || message.tool_calls) {
            throw failure(400, "Build text chat supports system/developer/user/assistant text messages only");
        }
        let content = message.content;
        if (Array.isArray(content)) {
            if (content.some(part => part?.type !== "text" || typeof part.text !== "string")) {
                throw failure(400, "Build text chat does not support images, audio or other attachments");
            }
            content = content.map(part => part.text).join("\n");
        }
        if (typeof content !== "string") throw failure(400, "Message content must be text");
        return { content, role: message.role };
    });
}

class BuildChatService {
    constructor(system) {
        this.system = system;
        this.busy = false;
        this.account = (process.env.BUILD_ACCOUNT_EMAIL || "").trim().toLowerCase();
        this.appUrl = process.env.BUILD_APP_URL || "";
        this.timeoutMs = system.config.fakeStreamTimeoutMs;
        if (this.appUrl && !/^https:\/\/aistudio\.google\.com\/apps\/[a-zA-Z0-9-]+(?:\?[^#]*)?$/.test(this.appUrl)) {
            throw new Error("BUILD_APP_URL must be an https://aistudio.google.com/apps/<id> URL");
        }
    }

    get enabled() {
        return Boolean(this.account && this.appUrl);
    }

    matches(req) {
        const model = req.body?.model || req.path.match(/\/models\/([^:/]+):/)?.[1];
        return typeof model === "string" && model.replace(/^models\//, "") === MODEL;
    }

    async preparePage(page) {
        this.stage = "open-draft";
        page.setDefaultTimeout(20000);
        await page.goto(this.appUrl, { timeout: 60000, waitUntil: "domcontentloaded" });
        await page
            .getByRole("textbox", { exact: true, name: "Make changes, add new features, ask for anything" })
            .waitFor({ timeout: 60000 });
        const tour = page.getByRole("button", { name: /^(关闭导览|Close tour)$/ });
        await tour.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
        if (await tour.isVisible()) await tour.click();
        this.stage = "select-model";
        await page.getByRole("button", { name: /^(设置|Settings)$/ }).click();
        await page.getByRole("combobox", { name: "Select the model for chat" }).click();
        await page.getByRole("option", { name: /^Gemini 4 Argon(?:, Paid)?$/ }).click();
        await page.getByRole("button", { name: /^(关闭面板|Close panel)$/ }).click();
        this.stage = "new-chat";
        await page.getByRole("button", { name: /^(New chat|Chat history)$/ }).click();
        await page.getByRole("menuitem", { exact: true, name: "Start new chat" }).click();
    }

    async generate(page, messages) {
        await this.preparePage(page);
        const prompt =
            "This is a text conversation. Answer the final user message directly. " +
            "Do not create, edit, publish or deploy files or applications. Do not use tools. " +
            "The following JSON contains the conversation in order. Follow the system/developer instructions " +
            "within it and return only the assistant reply, without a role label or JSON wrapper.\n\n" +
            JSON.stringify(messages);
        await page
            .getByRole("textbox", { exact: true, name: "Make changes, add new features, ask for anything" })
            .fill(prompt);
        this.stage = "submit";
        const submission = page.waitForResponse(response => matchesRpc(response, "CodeAssistantOffline"), {
            timeout: this.timeoutMs,
        });
        const stream = page.waitForResponse(response => matchesRpc(response, "StreamCodeAssistantOfflineGeneration"), {
            timeout: this.timeoutMs,
        });
        submission.catch(() => {});
        stream.catch(() => {});
        await page.getByRole("button", { exact: true, name: "Send" }).click();
        const submitted = await submission;
        const sent = submitted.request().postDataJSON();
        // Google protobuf JSON encodes boolean fields as either true or 1.
        if (sent?.[7] !== `models/${MODEL}` || ![true, 1].includes(sent?.[22])) {
            throw new Error("Build did not select the requested model and a fresh chat");
        }
        if (!submitted.ok()) throw new Error(`Build submission failed (HTTP ${submitted.status()})`);
        const task = await submitted.json();
        if (typeof task?.[0] !== "string") throw new Error("Build did not return a generation ID");
        this.stage = "read-result";
        const response = await stream;
        if (!response.ok()) throw new Error(`Build generation failed (HTTP ${response.status()})`);
        if (response.request().postDataJSON()?.[0] !== task[0]) throw new Error("Build task mismatch");
        const final = extractSnapshots(await response.json()).at(-1);
        if (!final?.complete || !final.text) throw new Error("Build did not return a completed text answer");
        if (final.model !== `models/${MODEL}` || final.generationId !== task[0])
            throw new Error("Build result model/task mismatch");
        this.system.logger.info(`[Build] Verified ${MODEL} completed text response`);
        return final.text;
    }

    async handle(req, res) {
        const id = `chatcmpl-${randomUUID()}`;
        let lease;
        let heartbeat;
        let timer;
        let tracked = false;
        let ownsSlot = false;
        let status = 200;
        let errorMessage;
        let completed = false;
        const abort = new AbortController();
        const disconnected = () => {
            if (!res.writableEnded) abort.abort(failure(499, "Client disconnected"));
        };
        res.on("close", disconnected);
        const stats = this.system.usageStatsService;
        let authIndex;
        try {
            if (req.method !== "POST" || req.path !== "/v1/chat/completions") {
                throw failure(400, `${MODEL} currently supports /v1/chat/completions text chat only`);
            }
            if (!this.enabled)
                throw failure(503, "Set BUILD_ACCOUNT_EMAIL and BUILD_APP_URL to enable Build text chat");
            const messages = normalizeMessages(req.body);
            if (this.busy) throw failure(429, "Build is processing another request; retry after it completes");
            this.busy = true;
            ownsSlot = true;
            this.stage = "acquire-account";
            authIndex = this.system.authSource
                .getRotationIndices()
                .find(index => this.system.authSource.accountNameMap.get(index)?.toLowerCase() === this.account);
            if (authIndex == null) throw failure(503, "Configured Build account credential is unavailable");
            stats.startRequest(id, {
                apiFormat: "openai",
                initialAccountName: this.account,
                initialAuthIndex: authIndex,
                isStreaming: req.body.stream === true,
                method: req.method,
                model: MODEL,
                path: req.path,
                requestCategory: "generation",
                streamMode: req.body.stream === true ? "fake" : "non",
            });
            tracked = true;
            // A page lease protects its existing account context from pool eviction.
            timer = setTimeout(() => abort.abort(failure(504, "Build generation timed out")), this.timeoutMs);
            lease = await this.system.browserManager.acquireContextPage(authIndex, {
                ensureAccount: async () => {
                    const result = await this.system.requestHandler.authSwitcher.switchToSpecificAuth(authIndex);
                    if (!result.success) throw failure(503, "Account switch is in progress; retry shortly");
                },
                signal: abort.signal,
            });
            if (abort.signal.aborted) throw abort.signal.reason;
            const ignored = [
                "temperature",
                "top_p",
                "max_tokens",
                "max_completion_tokens",
                "stop",
                "seed",
                "presence_penalty",
                "frequency_penalty",
                "logprobs",
                "top_logprobs",
                "reasoning_effort",
            ].filter(key => req.body[key] != null);
            if (ignored.length) res.setHeader("X-Build-Ignored-Parameters", ignored.join(","));
            const created = Math.floor(Date.now() / 1000);
            const chunk = (delta, finishReason = null) => ({
                choices: [{ delta, finish_reason: finishReason, index: 0 }],
                created,
                id,
                model: MODEL,
                object: "chat.completion.chunk",
            });
            if (req.body.stream === true) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("X-Accel-Buffering", "no");
                res.flushHeaders();
                res.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
                heartbeat = setInterval(() => {
                    if (!res.destroyed) res.write(": waiting\n\n");
                }, 15000);
            }
            let rejectAbort;
            const aborted = new Promise((_, reject) => {
                rejectAbort = () => reject(abort.signal.reason);
            });
            abort.signal.addEventListener("abort", rejectAbort, { once: true });
            let text;
            try {
                text = await Promise.race([this.generate(lease.page, messages), aborted]);
            } finally {
                abort.signal.removeEventListener("abort", rejectAbort);
            }
            completed = true;
            if (req.body.stream === true) {
                res.write(`data: ${JSON.stringify(chunk({ content: text }))}\n\n`);
                res.end(`data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`);
            } else {
                res.json({
                    choices: [{ finish_reason: "stop", index: 0, message: { content: text, role: "assistant" } }],
                    created,
                    id,
                    model: MODEL,
                    object: "chat.completion",
                });
            }
        } catch (error) {
            status = error.status || 502;
            errorMessage = error.message;
            // Playwright errors can contain locators or prompt text; never return or log those details.
            const publicMessage = error.status
                ? error.message
                : "Build text generation failed; check account access and the dedicated draft";
            this.system.logger.warn(
                `[Build] Request failed (${status}, ${error.name}, stage=${this.stage || "validate"})`
            );
            const body = { error: { code: "build_chat_error", message: publicMessage, type: "api_error" } };
            if (!res.destroyed && !res.writableEnded) {
                if (res.headersSent) res.end(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`);
                else res.status(status).json(body);
            }
        } finally {
            clearInterval(heartbeat);
            clearTimeout(timer);
            res.off("close", disconnected);
            if (lease) {
                if (!completed && !lease.page.isClosed()) {
                    const cancel = lease.page.getByRole("button", { exact: true, name: "Cancel generation" });
                    if (await cancel.isVisible().catch(() => false)) {
                        const cancelled = lease.page
                            .waitForResponse(response => matchesRpc(response, "CancelCodeAssistantOfflineGeneration"), {
                                timeout: 5000,
                            })
                            .catch(() => null);
                        await cancel.click({ timeout: 3000 }).catch(() => {});
                        await cancelled;
                    }
                }
                await lease
                    .release()
                    .catch(error => this.system.logger.warn(`[Build] Page release failed (${error.name})`));
            }
            if (ownsSlot) this.busy = false;
            if (tracked)
                stats.finishRequest(id, {
                    errorMessage: errorMessage ? `Build request failed (${status})` : null,
                    finalAccountName: this.account,
                    finalAuthIndex: authIndex,
                    outcome: status === 499 ? "aborted" : status >= 400 ? "error" : "success",
                    statusCode: status,
                });
        }
    }
}

module.exports = { BuildChatService, matchesRpc, MODEL, normalizeMessages };
