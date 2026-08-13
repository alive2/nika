import * as vscode from 'vscode';
import { SecretStore } from './secrets.js';
import { DEEPSEEK_MODELS, DEEPSEEK_RESPONSES_MODELS, getResponsesModel, getConfig, getSelectedModel, getMaxTokens, getTemperature, ThinkingEffort, getThinkingEffort, getContextWindowTokens, getContextWindowPreset, getVisionModelKey, getVisionSource, VisionSource } from './config.js';
import { vscodeMessagesToDeepSeek, deepseekMessagesToResponsesInput } from './transform/messages.js';
import { streamDeepSeekChat, streamDeepSeekResponses } from './api/deepseek.js';
import { safeStringify } from './api/sanitize.js';
import { resolveImageMessages, resolveVisionDescriber } from './vision/pipeline.js';
import { createReplayMarkerPart, hasImageParts } from './vision/replay.js';
import { log } from './log.js';
import { visionLog } from './vision/log.js';
import type { DeepSeekRequest, DeepSeekTool, DeepSeekMessage, DeepSeekResponsesRequest, DeepSeekResponsesTool } from './api/types.js';
import type { ReplayMarkerMetadata } from './vision/types.js';

/**
 * VS Code Output channel for Nika diagnostics.
 * Visible in View → Output → "Nika".
 */
let _outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
    if (!_outputChannel) {
        _outputChannel = vscode.window.createOutputChannel('Nika');
    }
    return _outputChannel;
}

/**
 * Rough token count estimation for messages.
 * DeepSeek uses a BPE tokenizer; we approximate at ~4 chars/token.
 */
function estimateMessageTokens(messages: DeepSeekMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        // Base overhead per message (~4 tokens for role formatting)
        total += 4;
        if (typeof msg.content === 'string') {
            total += Math.ceil(msg.content.length / 4);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) {
                    total += Math.ceil(part.text.length / 4);
                }
            }
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                total += Math.ceil(tc.function.name.length / 4);
                total += Math.ceil(tc.function.arguments.length / 4);
            }
        }
    }
    return total;
}

/**
 * Truncate messages to fit within the configured context window.
 * Preserves the system message (first message) and removes oldest user/assistant
 * messages from the middle when the context is exceeded.
 */
function truncateMessagesToContextWindow(messages: DeepSeekMessage[]): DeepSeekMessage[] {
    const maxContextTokens = getContextWindowTokens();
    const maxOutputTokens = getMaxTokens();
    // Reserve space for output — input context = total - max_output - safety buffer
    const availableInputTokens = maxContextTokens - maxOutputTokens - 1024;

    const estimatedTokens = estimateMessageTokens(messages);
    if (estimatedTokens <= availableInputTokens) {
        return messages;
    }

    // Need to truncate. Keep system message (index 0 if it's role: 'system'),
    // then keep the most recent messages.
    const systemMessages: DeepSeekMessage[] = [];
    const otherMessages: DeepSeekMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'system' && systemMessages.length === 0) {
            systemMessages.push(msg);
        } else {
            otherMessages.push(msg);
        }
    }

    // Work from newest to oldest, keeping what fits
    const keptMessages: DeepSeekMessage[] = [];
    let tokenBudget = availableInputTokens - estimateMessageTokens(systemMessages);

    for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = estimateMessageTokens([msg]);
        if (msgTokens <= tokenBudget) {
            keptMessages.unshift(msg);
            tokenBudget -= msgTokens;
        } else {
            // This message is too large — skip it and everything older
            break;
        }
    }

    const truncated = [...systemMessages, ...keptMessages];

    log.info(
        `Context window: truncated from ${messages.length} to ${truncated.length} messages ` +
        `(~${estimateMessageTokens(messages).toLocaleString()} → ~${estimateMessageTokens(truncated).toLocaleString()} tokens)`
    );

    return truncated;
}

/**
 * NikaChatProvider — a VS Code LanguageModelChatProvider bringing multiple
 * model families under the single "Nika" vendor.
 *
 * - DeepSeek V4 Flash & Pro → proxied to DeepSeek API
 * - Gemini 2.5 Flash & Flash-Lite → proxied to Gemini API
 * - Gemma 4 (Ollama) → proxied to local Ollama
 *
 * Registered via vscode.lm.registerLanguageModelChatProvider('nika', provider).
 * All models appear in Copilot Chat's model picker under "Nika".
 */
export class NikaChatProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
    private readonly secrets: SecretStore;

    constructor(context: vscode.ExtensionContext) {
        this.secrets = new SecretStore(context.secrets);
    }

    /** Expose key check so the extension can prompt on startup. */
    async getApiKey(): Promise<string | undefined> {
        return this.secrets.getDeepSeekApiKey();
    }

    /** Expose Gemini key check for internal use. */
    private async getGeminiApiKey(): Promise<string | undefined> {
        return this.secrets.getGeminiApiKey();
    }

    /**
     * Returns the list of available models. Called by VS Code when the model picker opens.
     * Shows all configured models under the single "Nika" vendor.
     *
     * - DeepSeek models: require DeepSeek API key
     * - Gemini models: require Gemini API key
     * - Gemma 4: always available (local Ollama, no key needed)
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const models: vscode.LanguageModelChatInformation[] = [];
        const deepseekKey = await this.secrets.getDeepSeekApiKey();
        const geminiKey = await this.secrets.getGeminiApiKey();

        // ── DeepSeek models ──────────────────────────────────────────
        if (deepseekKey) {
            const effectiveInputTokens = getContextWindowTokens();
            const effectiveOutputTokens = getMaxTokens();
            for (const m of DEEPSEEK_MODELS) {
                const modelInfo: vscode.LanguageModelChatInformation & {
                    configurationSchema?: ReturnType<typeof buildThinkingEffortSchema>;
                } = {
                    id: m.id,
                    name: m.name,
                    family: m.family,
                    version: m.version,
                    maxInputTokens: Math.min(m.maxInputTokens, effectiveInputTokens),
                    maxOutputTokens: Math.min(m.maxOutputTokens, effectiveOutputTokens),
                    capabilities: m.capabilities,
                    detail: m.detail,
                };

                // Both Flash and Pro support thinking — add the per-model dropdown
                // in Copilot Chat's model picker (matching Vizards UX).
                modelInfo.configurationSchema = buildThinkingEffortSchema();

                models.push(modelInfo as vscode.LanguageModelChatInformation);
            }

            // Responses API models (flash + pro) — picked via the Copilot picker,
            // intentionally NOT part of DEEPSEEK_MODELS / nika.selectedModel so
            // the chat-completions handler can never be told to send these ids.
            for (const rm of DEEPSEEK_RESPONSES_MODELS) {
                const responsesModelInfo: vscode.LanguageModelChatInformation & {
                    configurationSchema?: ReturnType<typeof buildThinkingEffortSchema>;
                } = {
                    id: rm.id,
                    name: rm.name,
                    family: rm.family,
                    version: rm.version,
                    maxInputTokens: Math.min(rm.maxInputTokens, effectiveInputTokens),
                    maxOutputTokens: Math.min(rm.maxOutputTokens, effectiveOutputTokens),
                    capabilities: rm.capabilities,
                    detail: rm.detail,
                };
                responsesModelInfo.configurationSchema = buildThinkingEffortSchema();
                models.push(responsesModelInfo as vscode.LanguageModelChatInformation);
            }
        } else if (!options.silent) {
            vscode.window.showWarningMessage(
                'Nika: DeepSeek API key not configured. DeepSeek models will not appear in the model picker until the key is set.'
            );
        }

        // ── Gemini models ────────────────────────────────────────────
        if (geminiKey) {
            models.push(
                {
                    id: 'gemini-2.5-flash',
                    name: 'Gemini 2.5 Flash',
                    family: 'gemini',
                    version: '2.5.0',
                    maxInputTokens: 1_000_000,
                    maxOutputTokens: 8_192,
                    capabilities: { imageInput: true },
                    detail: 'Google Gemini 2.5 Flash — free tier',
                },
                {
                    id: 'gemini-2.5-flash-lite',
                    name: 'Gemini 2.5 Flash-Lite',
                    family: 'gemini',
                    version: '2.5.0',
                    maxInputTokens: 1_000_000,
                    maxOutputTokens: 8_192,
                    capabilities: { imageInput: true },
                    detail: 'Google Gemini 2.5 Flash-Lite — fastest, most cost-efficient',
                }
            );
        } else if (!options.silent && !deepseekKey) {
            // Only show one warning if neither key is set
            vscode.window.showWarningMessage(
                'Nika: Gemini API key not configured. Gemini models will not appear in the model picker until the key is set.'
            );
        }

        // ── Gemma 4 (always available, local Ollama) ─────────────────
        models.push({
            id: 'gemma4:31b',
            name: 'Gemma 4 (Ollama)',
            family: 'gemma',
            version: '4.0.0',
            maxInputTokens: 128_000,
            maxOutputTokens: 4_096,
            capabilities: { imageInput: true },
            detail: 'Local Gemma 4 via Ollama — runs on your machine',
        });

        return models;
    }

    /**
     * Handle a chat request. Routes to the correct handler based on model ID.
     *
     * - deepseek-* → DeepSeek API (with vision preprocessing + replay markers)
     * - gemini-*   → Gemini API directly
     * - gemma4:*   → Ollama API directly
     */
    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Route to the appropriate handler
        if (model.id.startsWith('gemini-')) {
            return this.handleGeminiChat(model.id, messages, progress, token);
        }
        if (model.id.startsWith('gemma4:')) {
            return this.handleGemma4Chat(model.id, messages, progress, token);
        }
        if (getResponsesModel(model.id)) {
            return this.handleDeepSeekResponsesChat(model.id, messages, options, progress, token);
        }

        // ── DeepSeek handler (inline, for minimal diff) ──────────────
        const apiKey = await this.secrets.getDeepSeekApiKey();
        if (!apiKey) {
            throw new Error(
                'DeepSeek API key not configured. Run "Nika: Input Deepseek userToken" from the command palette (F1).'
            );
        }

        // Check for cancellation
        if (token.isCancellationRequested) return;

        // Resolve images to text descriptions (replay markers / vision model)
        // This operates on raw VS Code messages BEFORE conversion to DeepSeek format.
        // Wrap in try-catch so a describer failure doesn't crash the whole request.
        const getDescriber = async () => {
            try {
                return await this.createVisionDescriber();
            } catch (err) {
                visionLog.error('Failed to create vision describer', err);
                return undefined;
            }
        };
        const visionResolution = await resolveImageMessages(messages, token, getDescriber);
        const resolvedMessages = visionResolution.messages;
        const replayMarkerMetadata = visionResolution.replayMarkerMetadata;

        // Log vision stats for diagnostics
        if (visionResolution.stats.inputImageParts > 0) {
            const s = visionResolution.stats;
            visionLog.info(
                `Vision: ${s.inputImageParts} image(s) in ${s.inputImageMessages} message(s) ` +
                `→ current=${s.currentImageMessages} generated=${s.generatedImageMessages} ` +
                `replayed=${s.replayedImageMessages} omitted=${s.omittedImageMessages} ` +
                `unavailable=${s.unavailableImageMessages} failed=${s.failedImageMessages}`
            );
        }

        // Show any vision notices to the user
        if (visionResolution.initialResponseNotice) {
            progress.report(new vscode.LanguageModelTextPart(
                `\n\n${visionResolution.initialResponseNotice}\n\n`
            ));
        }

        if (token.isCancellationRequested) return;

        // Convert resolved VS Code messages to DeepSeek format
        let deepseekMessages = vscodeMessagesToDeepSeek(resolvedMessages);

        // Truncate messages to fit within the configured context window
        deepseekMessages = truncateMessagesToContextWindow(deepseekMessages);

        if (token.isCancellationRequested) return;

        // Build the API request
        const config = getConfig();
        const modelId = getSelectedModel();

        // Log which model is being used — detect agent type from modelOptions
        const agentName = options.modelOptions?.['agent']
            ?? options.modelOptions?.['agentName']
            ?? options.modelOptions?.['mode']
            ?? options.modelOptions?.['subagent']
            ?? '';
        const isSubagent = !!(options.modelOptions?.['subagent']
            || options.modelOptions?.['_subagent']
            || (options.modelOptions?.['agentName'] && options.modelOptions?.['agentName'] !== options.modelOptions?.['mode']));
        const agentType = isSubagent ? 'subagent' : (agentName ? `agent` : 'direct');
        const agentLabel = agentName ? ` [${agentType}: ${agentName}]` : '';
        const msg = `[Nika] Using model: ${modelId}${agentLabel}`;
        console.log(msg);
        getOutputChannel().appendLine(msg);

        const ctxWindowTokens = getContextWindowTokens();
        getOutputChannel().appendLine(`[Nika] Context window: ${ctxWindowTokens.toLocaleString()} tokens (setting: ${getContextWindowPreset()})`);

        // Read thinking effort from Copilot Chat's model picker dropdown first,
        // fall back to the saved nika.thinkingEffort setting.
        const thinkingEffort = getRequestThinkingEffort(options);
        const thinkingParams = buildThinkingParams(thinkingEffort);

        // Log which effort is being used
        const extOpts = options as unknown as Record<string, unknown>;
        const hasDropdownEffort = !!(extOpts.modelConfiguration as Record<string, unknown> | undefined)?.reasoningEffort;
        getOutputChannel().appendLine(`[Nika] Thinking effort: ${thinkingEffort}${hasDropdownEffort ? ' (from model picker dropdown)' : ''}`);

        // When thinking mode is enabled, ensure enough headroom for reasoning
        // tokens. DeepSeek's thinking can consume 4K-16K+ tokens on reasoning
        // alone, leaving nothing for visible output if max_tokens is too low.
        const effectiveMaxTokens = getMaxTokens();
        const thinkingEnabled = thinkingEffort !== 'off';
        const minThinkingTokens = 16_384;
        const boostedTokens = thinkingEnabled
            ? Math.max(effectiveMaxTokens, minThinkingTokens)
            : effectiveMaxTokens;

        if (boostedTokens !== effectiveMaxTokens) {
            getOutputChannel().appendLine(
                `[Nika] Thinking mode enabled — boosting max_tokens from ` +
                `${effectiveMaxTokens.toLocaleString()} to ${boostedTokens.toLocaleString()} to leave room for reasoning`
            );
        }

        const request: DeepSeekRequest = {
            model: modelId,
            messages: deepseekMessages,
            temperature: getTemperature(),
            max_tokens: boostedTokens,
            stream: true,
            ...thinkingParams,
            stream_options: { include_usage: true },
        };

        // Add tools if provided in options
        if (options.tools && options.tools.length > 0) {
            request.tools = options.tools.map(mapTool);
            request.tool_choice = 'auto';
        }

        // Detect incompatible parameter combinations
        const hasThinking = thinkingEnabled;
        const hasTools = (options.tools?.length ?? 0) > 0;
        if (hasThinking && hasTools) {
            const warning = `[Nika] WARNING: thinking mode (${getThinkingEffort()}) combined with ${options.tools!.length} tool(s). DeepSeek API may reject requests that include both thinking and tool parameters simultaneously. If you get a 400 error, try disabling thinking mode in settings.`;
            getOutputChannel().appendLine(warning);
            log.warn(warning);
        }

        // Validate message sequence order before sending
        const sequenceIssues = validateMessageSequence(deepseekMessages);
        if (sequenceIssues.length > 0) {
            const warning = `[Nika] WARNING: Message sequence validation found ${sequenceIssues.length} issue(s):\n  ${sequenceIssues.join('\n  ')}`;
            getOutputChannel().appendLine(warning);
            log.warn(warning);

            // Log the full message roles for debugging (verbose only)
            const roleSequence = deepseekMessages.map((m, i) => {
                const hasTc = m.tool_calls ? ` (${m.tool_calls.length} tool_calls)` : '';
                const isToolResult = m.tool_call_id ? ` (tool_call_id: ${m.tool_call_id})` : '';
                const contentLen = typeof m.content === 'string' ? m.content.length :
                    Array.isArray(m.content) ? m.content.length : 0;
                return `  [${i}] role=${m.role}${hasTc}${isToolResult} content=${typeof m.content === 'string' ? m.content.slice(0, 80) : contentLen > 0 ? `[${contentLen} parts]` : m.content === null ? 'null' : 'empty'}`;
            }).join('\n');
            log.verbose(`Full message role sequence (${deepseekMessages.length} messages):\n${roleSequence}`);
        }

        // Log request summary to nika.log
        const bodySize = new TextEncoder().encode(safeStringify(request)).length;
        log.info(
            `Sending DeepSeek request: model=${modelId}, ` +
            `messages=${deepseekMessages.length}, ` +
            `tools=${options.tools?.length ?? 0}, ` +
            `bodySize=${(bodySize / 1024).toFixed(1)}KB, ` +
            `thinking=${thinkingEnabled}, ` +
            `max_tokens=${boostedTokens.toLocaleString()}, ` +
            `temperature=${getTemperature()}`
        );

        // Create an AbortController for cancellation
        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => {
            abortController.abort();
        });

        try {
            const streamResult = await streamDeepSeekChat(
                request,
                apiKey,
                abortController.signal,
                // onText
                (text: string) => {
                    progress.report(new vscode.LanguageModelTextPart(text));
                },
                // onToolCalls
                (toolCalls) => {
                    for (const tc of toolCalls) {
                        progress.report(
                            new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.arguments)
                        );
                    }
                },
                // onComplete
                (usage) => {
                    // Report token usage
                    if (usage) {
                        progress.report(
                            new vscode.LanguageModelDataPart(
                                new TextEncoder().encode(
                                    JSON.stringify({
                                        prompt_tokens: usage.promptTokens,
                                        completion_tokens: usage.completionTokens,
                                        total_tokens: usage.promptTokens + usage.completionTokens,
                                    })
                                ),
                                'usage'
                            )
                        );
                    }

                    // Inject replay marker if we described images this turn
                    // This allows the next turn to replay descriptions without
                    // calling the vision model again.
                    if (replayMarkerMetadata.visionText) {
                        progress.report(createReplayMarkerPart(replayMarkerMetadata));
                    }
                }
            );

            // If DeepSeek returned nothing, don't throw — VS Code's agent loop
            // handles empty responses fine. Just log it for diagnostics.
            if (!streamResult.receivedContent && !streamResult.receivedToolCalls) {
                log.info(
                    `Empty response from DeepSeek (finish_reason: ${streamResult.finishReason ?? 'none'}, ` +
                    `max_tokens: ${boostedTokens.toLocaleString()}, thinking: ${thinkingEnabled})`
                );
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                // Cancelled by user — silently stop
                return;
            }
            // Build a descriptive error for VS Code's error reporting.
            // The Copilot summarizer catches errors and logs them; an opaque
            // "unknown" message makes debugging impossible. We wrap the error
            // so VS Code's ConversationHistorySummarizer gets a useful message.
            const errorMessage = err instanceof Error ? err.message : String(err || 'unknown error');
            const wrappedError = new Error(
                `Nika provider error (model: ${modelId}): ${errorMessage}`
            );
            // Preserve the original stack if available
            if (err instanceof Error && err.stack) {
                wrappedError.stack = err.stack;
            }

            // Log to nika.log for offline investigation
            log.error(
                `Chat request failed for model "${modelId}" (messages: ${deepseekMessages.length}, tools: ${options.tools?.length ?? 0})`,
                err
            );
            // Also log extra context that might help debug 400s
            log.verbose(
                `Error context: model=${modelId}, ` +
                `thinking=${thinkingEnabled}, ` +
                `tools=${options.tools?.length ?? 0}, ` +
                `max_tokens=${boostedTokens}, ` +
                `temperature=${getTemperature()}, ` +
                `bodySize=${(new TextEncoder().encode(safeStringify(request)).length / 1024).toFixed(1)}KB, ` +
                `contextWindow=${getContextWindowPreset()}`
            );

            // Only report to progress for interactive (non-background) requests.
            // Background summarization requests don't have a visible chat window,
            // and calling progress.report on them is harmless but unnecessary.
            progress.report(new vscode.LanguageModelTextPart(`\n\n❌ ${errorMessage}\n\n`));
            throw wrappedError;
        } finally {
            cancelDisposable.dispose();
        }
    }

    /**
     * Handle a chat request routed to the DeepSeek Responses API (POST /responses).
     *
     * Supports `deepseek-v4-flash` and `deepseek-v4-pro` on this endpoint.
     * The API model name is derived from the Copilot-facing model id (e.g.
     * `deepseek-v4-pro-responses` → `deepseek-v4-pro`), NOT from
     * `nika.selectedModel` (which is scoped to the chat-completions handler).
     *
     * Reuses the same vision pipeline, message conversion, context truncation,
     * thinking-effort dropdown, and tool mapping as the chat-completions path —
     * only the wire format / SSE parsing differs (see streamDeepSeekResponses).
     */
    private async handleDeepSeekResponsesChat(
        modelId: string,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const apiKey = await this.secrets.getDeepSeekApiKey();
        if (!apiKey) {
            throw new Error(
                'DeepSeek API key not configured. Run "Nika: Input Deepseek userToken" from the command palette (F1).'
            );
        }

        // Map the Copilot-facing id (e.g. deepseek-v4-pro-responses) to the
        // API model name (deepseek-v4-pro). The router guarantees this exists.
        const responsesModel = getResponsesModel(modelId);
        if (!responsesModel) {
            throw new Error(`Unknown Responses API model: ${modelId}`);
        }
        const apiModel = responsesModel.apiModel;

        if (token.isCancellationRequested) return;

        // Resolve images to text descriptions (same pipeline as chat completions)
        const getDescriber = async () => {
            try {
                return await this.createVisionDescriber();
            } catch (err) {
                visionLog.error('Failed to create vision describer', err);
                return undefined;
            }
        };
        const visionResolution = await resolveImageMessages(messages, token, getDescriber);
        const resolvedMessages = visionResolution.messages;
        const replayMarkerMetadata = visionResolution.replayMarkerMetadata;

        if (visionResolution.initialResponseNotice) {
            progress.report(new vscode.LanguageModelTextPart(
                `\n\n${visionResolution.initialResponseNotice}\n\n`
            ));
        }

        if (token.isCancellationRequested) return;

        // Convert + truncate to DeepSeek message form, then to Responses input
        let deepseekMessages = vscodeMessagesToDeepSeek(resolvedMessages);
        deepseekMessages = truncateMessagesToContextWindow(deepseekMessages);
        const { input, instructions } = deepseekMessagesToResponsesInput(deepseekMessages);

        // Thinking effort from the picker dropdown / nika.thinkingEffort setting
        const thinkingEffort = getRequestThinkingEffort(options);
        const reasoningParams = buildResponsesThinkingParams(thinkingEffort);
        const thinkingEnabled = thinkingEffort !== 'off';

        // Same headroom boost as chat completions: leave room for reasoning tokens
        const effectiveMaxTokens = getMaxTokens();
        const minThinkingTokens = 16_384;
        const boostedTokens = thinkingEnabled
            ? Math.max(effectiveMaxTokens, minThinkingTokens)
            : effectiveMaxTokens;

        const request: DeepSeekResponsesRequest = {
            model: apiModel,
            input,
            temperature: getTemperature(),
            max_output_tokens: boostedTokens,
            stream: true,
            ...reasoningParams,
        };
        if (instructions) request.instructions = instructions;

        if (options.tools && options.tools.length > 0) {
            request.tools = options.tools.map(mapResponsesTool);
            request.tool_choice = 'auto';
        }

        // Log request summary
        const bodySize = new TextEncoder().encode(safeStringify(request)).length;
        log.info(
            `Sending DeepSeek Responses request: model=${modelId} (api=${apiModel}), ` +
            `inputItems=${Array.isArray(input) ? input.length : 0}, ` +
            `tools=${options.tools?.length ?? 0}, ` +
            `bodySize=${(bodySize / 1024).toFixed(1)}KB, ` +
            `thinking=${thinkingEnabled}, ` +
            `max_output_tokens=${boostedTokens.toLocaleString()}, ` +
            `temperature=${getTemperature()}`
        );
        getOutputChannel().appendLine(
            `[Nika] Responses API: model=${modelId} (api=${apiModel}), inputItems=${Array.isArray(input) ? input.length : 0}, ` +
            `thinking=${thinkingEnabled}, tools=${options.tools?.length ?? 0}`
        );

        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => {
            abortController.abort();
        });

        try {
            const streamResult = await streamDeepSeekResponses(
                request,
                apiKey,
                abortController.signal,
                // onText
                (text: string) => {
                    progress.report(new vscode.LanguageModelTextPart(text));
                },
                // onToolCalls
                (toolCalls) => {
                    for (const tc of toolCalls) {
                        progress.report(
                            new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.arguments)
                        );
                    }
                },
                // onComplete
                (usage) => {
                    if (usage) {
                        progress.report(
                            new vscode.LanguageModelDataPart(
                                new TextEncoder().encode(
                                    JSON.stringify({
                                        prompt_tokens: usage.promptTokens,
                                        completion_tokens: usage.completionTokens,
                                        total_tokens: usage.promptTokens + usage.completionTokens,
                                    })
                                ),
                                'usage'
                            )
                        );
                    }
                    if (replayMarkerMetadata.visionText) {
                        progress.report(createReplayMarkerPart(replayMarkerMetadata));
                    }
                }
            );

            if (!streamResult.receivedContent && !streamResult.receivedToolCalls) {
                log.info(
                    `Empty response from DeepSeek Responses (finish_reason: ${streamResult.finishReason ?? 'none'}, ` +
                    `max_output_tokens: ${boostedTokens.toLocaleString()}, thinking: ${thinkingEnabled})`
                );
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                return; // Cancelled by user — silently stop
            }
            const errorMessage = err instanceof Error ? err.message : String(err || 'unknown error');
            const wrappedError = new Error(
                `Nika provider error (model: ${modelId}): ${errorMessage}`
            );
            if (err instanceof Error && err.stack) {
                wrappedError.stack = err.stack;
            }
            log.error(
                `Chat request failed for model "${modelId}" (Responses API, inputItems: ${Array.isArray(input) ? input.length : 0}, tools: ${options.tools?.length ?? 0})`,
                err
            );
            progress.report(new vscode.LanguageModelTextPart(`\n\n❌ ${errorMessage}\n\n`));
            throw wrappedError;
        } finally {
            cancelDisposable.dispose();
        }
    }

    /**
     * Handle a chat request routed to the Gemini API.
     */
    private async handleGeminiChat(
        modelId: string,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const apiKey = await this.secrets.getGeminiApiKey();
        if (!apiKey) {
            throw new Error('Gemini API key not configured. Run "Nika: Input Gemini API Key" from the command palette.');
        }

        if (token.isCancellationRequested) return;

        // Convert VS Code messages to Gemini format
        const contents: { role?: string; parts: { text: string }[] }[] = [];
        for (const msg of messages) {
            const role = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'model' : 'user';
            let text = '';
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    text += part.value;
                }
            }
            if (text.trim()) {
                contents.push({ role, parts: [{ text: text.trim() }] });
            }
        }

        const request = { contents, generationConfig: { temperature: 0.7, maxOutputTokens: 4096 } };
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);
            }

            const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message: string } };
            if (data.error) throw new Error(`Gemini API error: ${data.error.message}`);

            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
                progress.report(new vscode.LanguageModelTextPart(text));
                getOutputChannel().appendLine(`[Nika] Gemini response: ${text.slice(0, 100)}...`);
            }
        } catch (err) {
            if (abortController.signal.aborted) return;
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.error(`Gemini chat failed for model "${modelId}"`, err);
            progress.report(new vscode.LanguageModelTextPart(`\n\n❌ ${errorMessage}\n\n`));
            throw err;
        } finally {
            cancelDisposable.dispose();
        }
    }

    /**
     * Handle a chat request routed to Gemma 4 via Ollama.
     */
    private async handleGemma4Chat(
        modelId: string,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        if (token.isCancellationRequested) return;

        // Convert VS Code messages to Ollama format
        const ollamaMessages: { role: string; content: string }[] = [];
        for (const msg of messages) {
            const role = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
            let content = '';
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    content += part.value;
                }
            }
            if (content.trim()) {
                ollamaMessages.push({ role, content: content.trim() });
            }
        }

        const request = {
            model: modelId,
            messages: ollamaMessages,
            stream: false,
            options: { temperature: 0.7, num_predict: 4096 },
        };

        const { getOllamaBaseUrl } = await import('./config.js');
        const url = `${getOllamaBaseUrl().replace(/\/$/, '')}/api/chat`;

        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
            }

            const data = await response.json() as { message?: { content?: string; thinking?: string }; error?: string };
            if (data.error) throw new Error(`Ollama error: ${data.error}`);

            const text = data.message?.content?.trim() || data.message?.thinking?.trim();
            if (text) {
                progress.report(new vscode.LanguageModelTextPart(text));
                getOutputChannel().appendLine(`[Nika] Gemma4 response: ${text.slice(0, 100)}...`);
            }
        } catch (err) {
            if (abortController.signal.aborted) return;
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.error(`Gemma4 chat failed for model "${modelId}"`, err);
            progress.report(new vscode.LanguageModelTextPart(`\n\n❌ ${errorMessage}\n\n`));
            throw err;
        } finally {
            cancelDisposable.dispose();
        }
    }

    /**
     * Create a vision describer based on the current configuration.
     *
     * For Nika-native vision models (Gemini, Gemma4), we call the API directly
     * — this is the Vizards "api-endpoint" pattern.
     *
     * For Copilot-provided models (GPT-4o, Claude, etc.), we use selectChatModels
     * and wrap the result — this is the Vizards "vscode-lm" pattern.
     *
     * Priority:
     * 1. visionModelKey setting (for Copilot models, vendor/id composite key)
     * 2. visionModel setting (legacy: 'gemini', 'gemini-flash-lite', 'ollama-gemma4')
     * 3. Default: Gemini 2.5 Flash
     */
    private async createVisionDescriber(): Promise<import('./vision/types.js').VisionDescriber | undefined> {
        const config = getConfig();
        const visionModelKey = getVisionModelKey();
        const oldVisionModel = config.get<string>('visionModel');
        const visionSource = getVisionSource();

        visionLog.info(
            `Creating vision describer: visionModelKey=${visionModelKey ?? '(none)'}, ` +
            `visionModel=${oldVisionModel ?? '(none)'}, visionSource=${visionSource}`
        );

        // ── Direct API path ───────────────────────────────────────────
        // Nika-native models (keys starting with "nika/") MUST use the direct API
        // because the Copilot LM path would route back to our own provider, which
        // only extracts text parts and drops image data — making vision unusable.
        //
        // The legacy "nika-" prefix is also handled here.

        // Nika-native models by visionModelKey ("nika/gemini-2.5-flash-lite" etc.)
        if (visionModelKey === 'nika/gemini-2.5-flash-lite') {
            return this.createDirectGeminiDescriber('gemini-2.5-flash-lite');
        }
        if (visionModelKey === 'nika/gemini-2.5-flash') {
            return this.createDirectGeminiDescriber('gemini-2.5-flash');
        }
        if (visionModelKey === 'nika/gemma4:31b') {
            return this.createDirectGemma4Describer();
        }

        // Legacy nika- prefixed keys
        if (visionModelKey?.startsWith('nika-')) {
            return this.createNikaDirectDescriber(visionModelKey);
        }

        // Legacy visionModel setting (from "Nika Native" picker)
        if (!visionModelKey) {
            if (oldVisionModel === 'gemini-flash-lite') {
                return this.createDirectGeminiDescriber('gemini-2.5-flash-lite');
            }
            if (oldVisionModel === 'gemini' || !oldVisionModel) {
                return this.createDirectGeminiDescriber('gemini-2.5-flash');
            }
            if (oldVisionModel === 'ollama-gemma4') {
                return this.createDirectGemma4Describer();
            }
        }

        // ── Copilot LM path (third-party models only) ─────────────────
        // For non-Nika visionModelKey (e.g. "copilot/gpt-4o", "github/gpt-4o"),
        // try the Copilot LM path. These models are provided by VS Code itself
        // and properly handle image data parts through sendRequest.
        if (visionModelKey) {
            visionLog.info(`Trying Copilot LM for model: ${visionModelKey}`);
            const describer = await resolveVisionDescriber({
                source: 'vscode-lm',
                visionModelKey,
            });
            if (describer) return describer;
            visionLog.warn(`Copilot LM model not found: "${visionModelKey}"`);
        }

        // ── Default fallback ─────────────────────────────────────────
        visionLog.info('Falling back to default: Gemini Flash (direct API)');
        return this.createDirectGeminiDescriber('gemini-2.5-flash');
    }

    /**
     * Create a direct Gemini describer that calls the Gemini API directly.
     * This is the Vizards "api-endpoint" pattern for Nika's built-in models.
     */
    private async createDirectGeminiDescriber(
        modelName: string,
    ): Promise<import('./vision/types.js').VisionDescriber | undefined> {
        const apiKey = await this.secrets.getGeminiApiKey();
        if (!apiKey) {
            visionLog.warn('Gemini API key not configured');
            return undefined;
        }

        const { describeImage } = await import('./vision/gemini.js');

        return {
            id: `gemini:${modelName}`,
            source: 'api-endpoint' as const,
            describe: async (request) => {
                const results: string[] = [];
                for (const [index, image] of request.images.entries()) {
                    const result = await describeImage(
                        image.data,
                        image.mimeType,
                        apiKey,
                        modelName,
                        index === 0 ? request.prompt : undefined,
                    );
                    if (!result.success) {
                        throw new Error(`Gemini vision failed: ${result.error}`);
                    }
                    results.push(result.description);
                }
                return results.join('\n\n---\n\n');
            },
        };
    }

    /**
     * Create a direct Gemma4 describer that calls Ollama directly.
     */
    private async createDirectGemma4Describer(): Promise<import('./vision/types.js').VisionDescriber | undefined> {
        const { getOllamaBaseUrl } = await import('./config.js');
        const { describeImage } = await import('./vision/gemma4.js');

        return {
            id: 'gemma4:31b',
            source: 'api-endpoint' as const,
            describe: async (request) => {
                const results: string[] = [];
                for (const [index, image] of request.images.entries()) {
                    const result = await describeImage(
                        image.data,
                        image.mimeType,
                        getOllamaBaseUrl(),
                        index === 0 ? request.prompt : undefined,
                    );
                    if (!result.success) {
                        throw new Error(`Gemma4 vision failed: ${result.error}`);
                    }
                    results.push(result.description);
                }
                return results.join('\n\n---\n\n');
            },
        };
    }

    /**
     * Map a Nika provider key to a direct describer.
     */
    private async createNikaDirectDescriber(
        key: string,
    ): Promise<import('./vision/types.js').VisionDescriber | undefined> {
        if (key.includes('gemini-2.5-flash-lite')) {
            return this.createDirectGeminiDescriber('gemini-2.5-flash-lite');
        }
        if (key.includes('gemini')) {
            return this.createDirectGeminiDescriber('gemini-2.5-flash');
        }
        if (key.includes('gemma4')) {
            return this.createDirectGemma4Describer();
        }
        return this.createDirectGeminiDescriber('gemini-2.5-flash');
    }

    /**
     * Rough token count estimation.
     * DeepSeek uses a BPE tokenizer; we approximate at ~4 chars/token.
     */
    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
        }

        const content = typeof text.content === 'string'
            ? text.content
            : text.content
                .map(part => {
                    if (part instanceof vscode.LanguageModelTextPart) return part.value;
                    if (part instanceof vscode.LanguageModelDataPart) return `[image:${part.mimeType}]`;
                    return '';
                })
                .join('');

        return Math.ceil(content.length / 4);
    }
}

/**
 * Validate DeepSeek message sequence ordering.
 * The API expects strict alternating roles (system → user → assistant → user → assistant → ...)
 * with tool results following tool call messages.
 * Returns an array of human-readable issue descriptions (empty if no issues).
 */
function validateMessageSequence(messages: DeepSeekMessage[]): string[] {
    const issues: string[] = [];

    if (messages.length === 0) {
        issues.push('No messages in request');
        return issues;
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const prev = i > 0 ? messages[i - 1] : null;
        const next = i < messages.length - 1 ? messages[i + 1] : null;

        // Check 1: System message must be first if present
        if (msg.role === 'system' && i !== 0) {
            issues.push(`Message [${i}]: system role must be first, not at index ${i}`);
        }

        // Check 2: Run of 3+ consecutive user messages.
        // Two consecutive user messages are LEGITIMATE (e.g. internal title/
        // progress-message requests send instructions + request as two user
        // messages, and DeepSeek accepts consecutive user messages anyway),
        // so only flag a degenerate run of three or more. This fires once per
        // run, at the third user message in the sequence.
        if (
            msg.role === 'user' &&
            prev?.role === 'user' &&
            messages[i - 2]?.role === 'user'
        ) {
            issues.push(`Message [${i}]: three or more consecutive user messages (run ends at [${i}])`);
        }

        // Check 3: Two consecutive assistant messages (without tool calls)
        if (msg.role === 'assistant' && prev?.role === 'assistant' && !msg.tool_calls && !prev?.tool_calls) {
            issues.push(`Message [${i}]: two consecutive assistant messages without tool calls`);
        }

        // Check 4: Tool message without a preceding assistant message with tool_calls
        if (msg.role === 'tool') {
            if (!prev || prev.role !== 'assistant' || !prev.tool_calls) {
                issues.push(`Message [${i}]: tool result without preceding assistant tool_calls message`);
            }
            // Check that tool_call_id exists
            if (!msg.tool_call_id) {
                issues.push(`Message [${i}]: tool result missing tool_call_id`);
            }
        }

        // Check 5: Assistant with tool_calls should have content: null (or empty)
        if (msg.tool_calls && msg.tool_calls.length > 0 && msg.content !== null) {
            issues.push(`Message [${i}]: assistant tool_calls message should have content: null, got content type: ${typeof msg.content}`);
        }

        // Check 6: Check for empty content in user/assistant messages
        if ((msg.role === 'user' || msg.role === 'assistant') && !msg.tool_calls) {
            if (msg.content === null || (typeof msg.content === 'string' && msg.content.trim() === '')) {
                issues.push(`Message [${i}]: ${msg.role} message has empty content`);
            }
        }

        // Check 7: Check for oversized individual messages (>100K chars)
        if (typeof msg.content === 'string' && msg.content.length > 100_000) {
            issues.push(`Message [${i}]: ${msg.role} message content is ${msg.content.length.toLocaleString()} chars (very large)`);
        }
    }

    return issues;
}

/**
 * Map a VS Code LanguageModelChatTool to DeepSeek tool format.
 * DeepSeek requires every tool parameter schema to be a valid JSON Schema
 * with `type: "object"`. VS Code tools may have null or bare schemas,
 * so we sanitize here.
 */
const FALLBACK_SCHEMA = { type: 'object' as const, properties: {} };

function mapTool(tool: vscode.LanguageModelChatTool): DeepSeekTool {
    const rawSchema = tool.inputSchema as Record<string, unknown> | null | undefined;
    const parameters = sanitizeSchema(rawSchema);

    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description ?? '',
            parameters,
        },
    };
}

function sanitizeSchema(schema: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return FALLBACK_SCHEMA;
    }
    // Ensure it has `type: "object"` at minimum
    if (!schema.type || schema.type !== 'object') {
        return { ...schema, type: 'object' };
    }
    return schema;
}

/**
 * Map a VS Code LanguageModelChatTool to the Responses API tool format.
 *
 * The Responses API FLATTENS the function definition — `name`, `description`,
 * and `parameters` are top-level tool fields (NOT nested under `function` like
 * Chat Completions). Sending the Chat Completions shape fails deserialization
 * with `tools[0]: missing field name`.
 */
function mapResponsesTool(tool: vscode.LanguageModelChatTool): DeepSeekResponsesTool {
    const rawSchema = tool.inputSchema as Record<string, unknown> | null | undefined;
    const parameters = sanitizeSchema(rawSchema);

    return {
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters,
    };
}

/**
 * Build the `configurationSchema` that makes Copilot Chat render a per-model
 * Thinking Effort dropdown (None / Low / High / Max) next to the model picker.
 *
 * This matches the Vizards approach — the dropdown appears for every model
 * that supports thinking, and the user's choice comes through as
 * `options.modelConfiguration.reasoningEffort` on each request.
 *
 * Levels match DeepSeek's Thinking Mode guide: for `deepseek-v4-flash`, `low`
 * maps to a genuinely lower reasoning effort (distinct from `high`); only Pro
 * collapses `low` → `high` server-side.
 */
function buildThinkingEffortSchema() {
    return {
        properties: {
            reasoningEffort: {
                type: 'string',
                title: 'Thinking Effort',
                enum: ['none', 'low', 'high', 'max'],
                enumItemLabels: ['None', 'Low', 'High', 'Max'],
                enumDescriptions: [
                    'Disable thinking for faster responses',
                    'Light reasoning — fastest thinking mode, good for simple lookups',
                    'Recommended for most tasks — balanced reasoning',
                    'Maximum reasoning depth for complex agent tasks',
                ],
                default: 'high',
                group: 'navigation',
            },
        },
    } as const;
}

/**
 * Read the thinking effort from the request options (set by Copilot Chat's
 * model picker dropdown) or fall back to the saved `nika.thinkingEffort`
 * setting for backward compatibility.
 *
 * Maps 'none' (Copilot dropdown value) → 'off' (Nika's internal value).
 */
function getRequestThinkingEffort(
    options: vscode.ProvideLanguageModelChatResponseOptions,
): ThinkingEffort {
    const extOptions = options as unknown as Record<string, unknown>;
    const modelConfig = extOptions.modelConfiguration as Record<string, unknown> | undefined;
    const cfg = extOptions.configuration as Record<string, unknown> | undefined;
    const configuredEffort = modelConfig?.reasoningEffort ?? cfg?.reasoningEffort;

    if (configuredEffort === 'none') return 'off';
    if (configuredEffort === 'low') return 'low';
    if (configuredEffort === 'high') return 'high';
    if (configuredEffort === 'max') return 'max';

    // Fall back to the saved setting (for users who haven't used the dropdown yet)
    return getThinkingEffort();
}

/**
 * Build DeepSeek chat-completions thinking parameters from effort level.
 *
 * DeepSeek's API uses:
 *   thinking.type: "enabled" | "disabled"
 *   reasoning_effort: "low" | "high" | "max"
 *
 * Per the API docs' effort mapping, for `deepseek-v4-flash`:
 *   low → low (genuinely lighter reasoning)
 *   high → high
 *   xhigh → high
 *   max → max
 * (Pro collapses low → high; we pass the user's request through either way.)
 *
 * Effort levels:
 *   off  → thinking disabled
 *   low  → thinking enabled, light reasoning
 *   high → thinking enabled, standard reasoning (default)
 *   max  → thinking enabled, maximum reasoning (for complex agent tasks)
 */
function buildThinkingParams(effort: ThinkingEffort): Partial<DeepSeekRequest> {
    if (effort === 'off') {
        return {
            thinking: { type: 'disabled' },
        };
    }

    return {
        thinking: { type: 'enabled' },
        reasoning_effort: effort,
    };
}

/**
 * Build Responses API reasoning parameters from effort level.
 *
 * The Responses API uses a top-level `reasoning: { effort }` field instead of
 * chat-completions' `thinking`/`reasoning_effort` pair. Per DeepSeek's
 * Thinking Mode guide, valid efforts are `none`/`low`/`high`/`max`, where
 * `none` DISABLES thinking mode (thinking is enabled by default when the
 * parameter is absent, so omitting `reasoning` would NOT turn it off).
 */
function buildResponsesThinkingParams(effort: ThinkingEffort): { reasoning?: { effort: 'none' | 'low' | 'high' | 'max' } } {
    if (effort === 'off') {
        return {
            reasoning: { effort: 'none' },
        };
    }

    return {
        reasoning: { effort },
    };
}
