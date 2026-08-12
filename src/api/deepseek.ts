import * as vscode from 'vscode';
import { log } from '../log.js';
import { safeStringify } from './sanitize.js';
import type { DeepSeekRequest, DeepSeekResponse, DeepSeekDelta, DeepSeekErrorResponse, DeepSeekToolCallDelta, DeepSeekResponsesRequest, DeepSeekResponsesEvent } from './types.js';

const DEEPSEEK_API_BASE = 'https://api.deepseek.com';
const DEEPSEEK_CHAT_ENDPOINT = `${DEEPSEEK_API_BASE}/chat/completions`;
const DEEPSEEK_RESPONSES_ENDPOINT = `${DEEPSEEK_API_BASE}/responses`;

/**
 * DeepSeek API client with SSE streaming support.
 *
 * DeepSeek's API is OpenAI-compatible. The endpoint is /chat/completions
 * (NOT /v1/chat/completions).
 *
 * DeepSeek also exposes the OpenAI-compatible Responses API at /responses
 * (currently `deepseek-v4-flash` only) — see streamDeepSeekResponses().
 */

export interface StreamResult {
    receivedContent: boolean;
    receivedToolCalls: boolean;
    finishReason: string | null | undefined;
}

/**
 * Fetch with retry for transient network-level failures.
 *
 * "fetch failed" in VS Code's extension host (Electron fetch) is frequently a
 * transient TLS/network failure. We retry the initial connection a few times
 * with exponential backoff — but ONLY on network-level errors (fetch threw
 * before receiving an HTTP response). HTTP error responses (4xx/5xx) and
 * user-initiated aborts are propagated immediately without retrying.
 */
async function fetchWithRetry(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    options: { retries?: number; label?: string } = {}
): Promise<Response> {
    const retries = options.retries ?? 2; // total attempts = retries + 1
    const label = options.label ?? url;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (signal.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }
        try {
            return await fetch(url, init);
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw err; // Never retry a user cancellation
            }
            lastError = err;
            const cause = err instanceof Error ? err.message : String(err);
            if (attempt < retries) {
                const delayMs = 500 * Math.pow(2, attempt);
                log.warn(
                    `Transient network error connecting to ${label} ` +
                    `(attempt ${attempt + 1}/${retries + 1}): ${cause}. ` +
                    `Retrying in ${delayMs}ms.`
                );
                await new Promise(resolve => setTimeout(resolve, delayMs));
                if (signal.aborted) {
                    throw new DOMException('The operation was aborted.', 'AbortError');
                }
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Build a hint for the common "fetch failed" TLS certificate issue.
 * VS Code's extension host uses Electron's fetch, which can fail with a
 * generic "fetch failed" when TLS certificate validation fails, even when
 * curl/Node.js work fine. This is a known VS Code issue.
 */
function fetchFailedTlsHint(cause: string): string {
    if (cause !== 'fetch failed' && !cause.includes('fetch failed')) {
        return '';
    }
    return ' This is often caused by TLS certificate validation in VS Code\'s embedded browser. ' +
        'Try setting "http.systemCertificates": true in VS Code settings, or adding ' +
        '"http.proxyStrictSSL": false as a workaround.';
}

/**
 * Log the full request details for debugging.
 */
function logRequestDetails(request: DeepSeekRequest): void {
    try {
        const bodyStr = safeStringify(request);
        const bodySize = new TextEncoder().encode(bodyStr).length;
        const truncatedBody = bodyStr.length > 10_000
            ? bodyStr.slice(0, 10_000) + `\n... [truncated, full body is ${bodyStr.length} chars / ${bodySize} bytes]`
            : bodyStr;

        log.verbose(
            `DeepSeek API request:\n` +
            `  URL: ${DEEPSEEK_CHAT_ENDPOINT}\n` +
            `  Method: POST\n` +
            `  Body size: ${bodySize} bytes (${bodyStr.length} chars)\n` +
            `  Messages: ${request.messages?.length ?? 0}\n` +
            `  Tools: ${request.tools?.length ?? 0}\n` +
            `  Model: ${request.model}\n` +
            `  Stream: ${request.stream}\n` +
            `  Thinking: ${request.thinking?.type ?? 'not set'}\n` +
            `  Reasoning effort: ${request.reasoning_effort ?? 'not set'}\n` +
            `  Max tokens: ${request.max_tokens}\n` +
            `  Temperature: ${request.temperature}\n` +
            `  Tool choice: ${request.tool_choice ?? 'not set'}\n` +
            `  Body (first 10K chars):\n${truncatedBody}`
        );
    } catch (err) {
        // Don't let logging itself cause issues
        log.warn('Failed to log request details', err);
    }
}

export async function streamDeepSeekChat(
    request: DeepSeekRequest,
    apiKey: string,
    signal: AbortSignal,
    onText: (text: string) => void,
    onToolCalls: (toolCalls: CompletedToolCall[]) => void,
    onComplete: (usage?: { promptTokens: number; completionTokens: number }) => void
): Promise<StreamResult> {
    // Ensure stream options are set
    const streamRequest: DeepSeekRequest = {
        ...request,
        stream: true,
        stream_options: { include_usage: true },
    };

    // Log the full request details before sending
    logRequestDetails(streamRequest);

    let response: Response;
    try {
        // Network-level failures (DNS, TLS, connection refused, etc.) are
        // retried with backoff — see fetchWithRetry(). HTTP errors and aborts
        // are not retried.
        response = await fetchWithRetry(
            DEEPSEEK_CHAT_ENDPOINT,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'text/event-stream',
                },
                body: safeStringify(streamRequest),
                signal,
            },
            signal,
            { label: 'DeepSeek API' }
        );
    } catch (fetchErr) {
        if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') {
            throw fetchErr; // Let the caller handle cancellation
        }
        const cause = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        log.error(
            `Network error connecting to DeepSeek API (${DEEPSEEK_CHAT_ENDPOINT})`,
            fetchErr
        );

        // Provide more specific troubleshooting for common VS Code fetch issues
        const hint = fetchFailedTlsHint(cause);

        throw new Error(
            `Failed to connect to DeepSeek API (${DEEPSEEK_CHAT_ENDPOINT}): ${cause}.` +
            hint
        );
    }

    if (!response.ok) {
        await handleErrorResponse(response, streamRequest);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('No response body reader available');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const pendingToolCalls = new Map<number, PendingToolCall>();
    let hasCompleted = false;
    let receivedContent = false;
    let receivedToolCalls = false;
    let finalFinishReason: string | null | undefined;
    let loggedModelIdentity = false;

    try {
        while (true) {
            let readResult;
            try {
                readResult = await reader.read();
            } catch (readErr) {
                // Stream read failure (e.g., connection dropped mid-stream)
                const cause = readErr instanceof Error ? readErr.message : String(readErr);
                log.error('DeepSeek API stream interrupted', readErr);
                throw new Error(`DeepSeek API stream interrupted: ${cause}`);
            }
            const { done, value } = readResult;
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;

                const data = trimmed.slice(6); // Remove "data: " prefix
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data) as DeepSeekResponse;
                    if (!loggedModelIdentity) {
                        loggedModelIdentity = true;
                        log.verbose(
                            `DeepSeek response model identity: ` +
                            `model=${parsed.model ?? 'unknown'}, ` +
                            `system_fingerprint=${parsed.system_fingerprint ?? 'not provided'}`
                        );
                    }
                    for (const choice of parsed.choices) {
                        const delta = choice.delta;
                        if (!delta) continue;

                        if (choice.finish_reason) {
                            finalFinishReason = choice.finish_reason;
                        }

                        // Handle text content
                        if (delta.content) {
                            receivedContent = true;
                            onText(delta.content);
                        }

                        // Handle tool calls (streamed in chunks)
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                mergeToolCallDelta(pendingToolCalls, tc);
                            }
                        }

                        // Check for finished tool calls
                        if (choice.finish_reason === 'tool_calls') {
                            const completed = finalizeToolCalls(pendingToolCalls);
                            if (completed.length > 0) {
                                receivedToolCalls = true;
                                onToolCalls(completed);
                            }
                        }
                    }

                    // Track usage from final chunk
                    if (parsed.usage) {
                        onComplete({
                            promptTokens: parsed.usage.prompt_tokens,
                            completionTokens: parsed.usage.completion_tokens,
                        });
                        hasCompleted = true;
                    }
                } catch {
                    // Skip unparseable SSE lines
                }
            }
        }

        // Process any remaining data in the buffer after stream end
        if (buffer.trim()) {
            const trimmed = buffer.trim();
            if (trimmed.startsWith('data: ')) {
                const data = trimmed.slice(6);
                if (data !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(data) as DeepSeekResponse;
                        for (const choice of parsed.choices) {
                            const delta = choice.delta;
                            if (!delta) continue;
                            if (choice.finish_reason) finalFinishReason = choice.finish_reason;
                            if (delta.content) {
                                receivedContent = true;
                                onText(delta.content);
                            }
                            if (delta.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    mergeToolCallDelta(pendingToolCalls, tc);
                                }
                            }
                            if (choice.finish_reason === 'tool_calls') {
                                const completed = finalizeToolCalls(pendingToolCalls);
                                if (completed.length > 0) {
                                    receivedToolCalls = true;
                                    onToolCalls(completed);
                                }
                            }
                        }
                        if (parsed.usage) {
                            onComplete({
                                promptTokens: parsed.usage.prompt_tokens,
                                completionTokens: parsed.usage.completion_tokens,
                            });
                            hasCompleted = true;
                        }
                    } catch {
                        // Skip unparseable buffer data
                    }
                }
            }
        }

        // Always signal completion so VS Code's agent loop can finalize,
        // even if the API didn't send a usage chunk.
        if (!hasCompleted) {
            onComplete();
        }
    } finally {
        reader.releaseLock();
    }

    return { receivedContent, receivedToolCalls, finishReason: finalFinishReason };
}

/**
 * Stream a chat request through the DeepSeek Responses API (POST /responses).
 *
 * Differs from /chat/completions:
 * - Request body uses `input` items + top-level `instructions`/`reasoning`/`tools`.
 * - SSE events are semantic (`response.output_text.delta`, `response.output_item.done`, ...)
 *   and end with `response.completed` / `response.incomplete` / `response.failed`
 *   instead of `data: [DONE]`.
 * - Usage arrives on the final `response.completed` / `response.incomplete` event.
 *
 * Currently only `deepseek-v4-flash` is supported by this endpoint.
 */
export async function streamDeepSeekResponses(
    request: DeepSeekResponsesRequest,
    apiKey: string,
    signal: AbortSignal,
    onText: (text: string) => void,
    onToolCalls: (toolCalls: CompletedToolCall[]) => void,
    onComplete: (usage?: { promptTokens: number; completionTokens: number }) => void
): Promise<StreamResult> {
    const streamRequest: DeepSeekResponsesRequest = {
        ...request,
        stream: true,
    };

    logResponsesRequestDetails(streamRequest);

    let response: Response;
    try {
        // Network-level failures (DNS, TLS, connection refused, etc.) are
        // retried with backoff — see fetchWithRetry(). HTTP errors and aborts
        // are not retried.
        response = await fetchWithRetry(
            DEEPSEEK_RESPONSES_ENDPOINT,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'text/event-stream',
                },
                body: safeStringify(streamRequest),
                signal,
            },
            signal,
            { label: 'DeepSeek Responses API' }
        );
    } catch (fetchErr) {
        if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') {
            throw fetchErr; // Let the caller handle cancellation
        }
        const cause = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        log.error(
            `Network error connecting to DeepSeek Responses API (${DEEPSEEK_RESPONSES_ENDPOINT})`,
            fetchErr
        );
        // Provide more specific troubleshooting for common VS Code fetch issues
        const hint = fetchFailedTlsHint(cause);
        throw new Error(
            `Failed to connect to DeepSeek Responses API (${DEEPSEEK_RESPONSES_ENDPOINT}): ${cause}.` +
            hint
        );
    }

    if (!response.ok) {
        await handleErrorResponse(response);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('No response body reader available');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    // Function calls arrive as output_item.added (call_id/name) then
    // function_call_arguments.delta (args), keyed by output_index.
    const pendingCalls = new Map<number, PendingToolCall>();
    let hasCompleted = false;
    let receivedContent = false;
    let receivedToolCalls = false;
    let finalFinishReason: string | null | undefined;
    let failedMessage: string | undefined;

    /**
     * Process one `data:` payload (a single Responses SSE event).
     */
    const processEvent = (data: string): void => {
        if (!data || data === '[DONE]') return;

        let event: DeepSeekResponsesEvent;
        try {
            event = JSON.parse(data) as DeepSeekResponsesEvent;
        } catch {
            return; // Skip unparseable lines
        }

        switch (event.type) {
            case 'response.output_text.delta':
                if (event.delta) {
                    receivedContent = true;
                    onText(event.delta);
                }
                break;

            case 'response.output_item.added': {
                const item = event.item;
                if (item && item.type === 'function_call' && typeof event.output_index === 'number') {
                    pendingCalls.set(event.output_index, {
                        id: item.call_id ?? item.id ?? '',
                        name: item.name ?? '',
                        arguments: item.arguments ?? '',
                    });
                }
                break;
            }

            case 'response.function_call_arguments.delta': {
                if (typeof event.output_index === 'number' && event.delta) {
                    const existing = pendingCalls.get(event.output_index);
                    if (existing) {
                        existing.arguments += event.delta;
                    } else {
                        pendingCalls.set(event.output_index, { id: '', name: '', arguments: event.delta });
                    }
                }
                break;
            }

            case 'response.output_item.done': {
                const item = event.item;
                if (item && item.type === 'function_call') {
                    const idx = event.output_index ?? 0;
                    const pending = pendingCalls.get(idx);
                    const completed: CompletedToolCall = {
                        id: item.call_id ?? item.id ?? pending?.id ?? '',
                        name: item.name ?? pending?.name ?? '',
                        arguments: parseToolCallArguments(item.arguments ?? pending?.arguments ?? ''),
                    };
                    if (completed.id || completed.name) {
                        receivedToolCalls = true;
                        onToolCalls([completed]);
                    }
                    pendingCalls.delete(idx);
                }
                break;
            }

            case 'response.completed':
            case 'response.incomplete': {
                finalFinishReason = event.type === 'response.completed' ? 'stop' : 'length';
                const resp = event.response;
                if (resp) {
                    log.verbose(
                        `DeepSeek Responses response model identity: ` +
                        `model=${resp.model ?? 'unknown'}, ` +
                        `system_fingerprint=${resp.system_fingerprint ?? 'not provided'}`
                    );
                }
                const usage = resp?.usage;
                if (usage) {
                    hasCompleted = true;
                    onComplete({
                        promptTokens: usage.input_tokens,
                        completionTokens: usage.output_tokens,
                    });
                }
                break;
            }

            case 'response.failed': {
                finalFinishReason = 'failed';
                failedMessage =
                    event.response?.error?.message
                    ?? 'DeepSeek Responses API failed to generate a response.';
                break;
            }
        }
    };

    try {
        while (true) {
            let readResult;
            try {
                readResult = await reader.read();
            } catch (readErr) {
                const cause = readErr instanceof Error ? readErr.message : String(readErr);
                log.error('DeepSeek Responses stream interrupted', readErr);
                throw new Error(`DeepSeek Responses stream interrupted: ${cause}`);
            }
            const { done, value } = readResult;
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                processEvent(trimmed.slice(6));
            }
        }

        // Process any remaining data in the buffer after stream end
        if (buffer.trim()) {
            const trimmed = buffer.trim();
            if (trimmed.startsWith('data: ')) {
                processEvent(trimmed.slice(6));
            }
        }

        // Always signal completion so VS Code's agent loop can finalize,
        // even if the API didn't send a usage event.
        if (!hasCompleted) {
            onComplete();
        }

        if (failedMessage) {
            throw new Error(failedMessage);
        }
    } finally {
        reader.releaseLock();
    }

    return { receivedContent, receivedToolCalls, finishReason: finalFinishReason };
}

/** Parse tool call arguments JSON defensively (mirrors finalizeToolCalls). */
function parseToolCallArguments(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Log the Responses API request details for debugging (verbose only).
 */
function logResponsesRequestDetails(request: DeepSeekResponsesRequest): void {
    try {
        const bodyStr = safeStringify(request);
        const bodySize = new TextEncoder().encode(bodyStr).length;
        const truncatedBody = bodyStr.length > 10_000
            ? bodyStr.slice(0, 10_000) + `\n... [truncated, full body is ${bodyStr.length} chars / ${bodySize} bytes]`
            : bodyStr;

        log.verbose(
            `DeepSeek Responses API request:\n` +
            `  URL: ${DEEPSEEK_RESPONSES_ENDPOINT}\n` +
            `  Method: POST\n` +
            `  Body size: ${bodySize} bytes (${bodyStr.length} chars)\n` +
            `  Model: ${request.model}\n` +
            `  Input items: ${Array.isArray(request.input) ? request.input.length : '(string)'}\n` +
            `  Tools: ${request.tools?.length ?? 0}\n` +
            `  Stream: ${request.stream}\n` +
            `  Reasoning effort: ${request.reasoning?.effort ?? 'not set'}\n` +
            `  Max output tokens: ${request.max_output_tokens}\n` +
            `  Temperature: ${request.temperature}\n` +
            `  Tool choice: ${request.tool_choice ?? 'not set'}\n` +
            `  Body (first 10K chars):\n${truncatedBody}`
        );
    } catch (err) {
        log.warn('Failed to log Responses request details', err);
    }
}

// --- Tool Call State Management ---

interface PendingToolCall {
    id: string;
    name: string;
    arguments: string;
}

export interface CompletedToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

function mergeToolCallDelta(
    pending: Map<number, PendingToolCall>,
    delta: DeepSeekToolCallDelta
): void {
    const existing = pending.get(delta.index) ?? { id: '', name: '', arguments: '' };

    if (delta.id) existing.id = delta.id;
    if (delta.function?.name) existing.name += delta.function.name;
    if (delta.function?.arguments) existing.arguments += delta.function.arguments;

    pending.set(delta.index, existing);
}

function finalizeToolCalls(pending: Map<number, PendingToolCall>): CompletedToolCall[] {
    const results: CompletedToolCall[] = [];

    for (const [, tc] of pending) {
        try {
            results.push({
                id: tc.id,
                name: tc.name,
                arguments: JSON.parse(tc.arguments),
            });
        } catch {
            // Skip tool calls with invalid JSON arguments
        }
    }

    pending.clear();
    return results;
}

// --- Error Handling ---

/**
 * Log full response details for debugging API errors.
 * Returns the response body text so callers can reuse it.
 */
async function logResponseDetails(response: Response, label: string): Promise<string> {
    try {
        let bodyText: string;
        try {
            bodyText = await response.text();
        } catch {
            bodyText = '(could not read response body)';
        }
        const truncated = bodyText.length > 5_000
            ? bodyText.slice(0, 5_000) + `\n... [truncated, full body is ${bodyText.length} chars]`
            : bodyText;

        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });

        log.verbose(
            `${label} response details:\n` +
            `  Status: ${response.status} ${response.statusText}\n` +
            `  Headers: ${JSON.stringify(headers, null, 2)}\n` +
            `  Body:\n${truncated}`
        );

        return bodyText;
    } catch (err) {
        log.warn(`Failed to log response details for ${label}`, err);
        return `(failed to read body: ${err instanceof Error ? err.message : String(err)})`;
    }
}

async function handleErrorResponse(response: Response, request?: DeepSeekRequest): Promise<never> {
    let message = `DeepSeek API returned HTTP ${response.status}`;
    let detail = '';

    // Log full response details — this consumes the response body and returns it
    const bodyText = await logResponseDetails(response, `DeepSeek API HTTP ${response.status}`);

    // Try to parse the body as JSON for structured error info
    try {
        const parsed = JSON.parse(bodyText) as DeepSeekErrorResponse;
        if (parsed.error?.message) {
            detail = parsed.error.message;
        } else {
            detail = bodyText.slice(0, 500);
        }
    } catch {
        // Not JSON — use the raw text
        if (bodyText && !bodyText.startsWith('(failed')) {
            detail = bodyText.slice(0, 500);
        }
    }

    // Log request context for correlation
    if (request) {
        log.verbose(
            `Request context for failed response:\n` +
            `  Model: ${request.model}\n` +
            `  Messages: ${request.messages?.length ?? 0}\n` +
            `  Tools: ${request.tools?.length ?? 0}\n` +
            `  Thinking: ${request.thinking?.type ?? 'not set'}\n` +
            `  Reasoning effort: ${request.reasoning_effort ?? 'not set'}\n` +
            `  Max tokens: ${request.max_tokens}\n` +
            `  Tool choice: ${request.tool_choice ?? 'not set'}`
        );
    }

    switch (response.status) {
        case 400:
            message = `DeepSeek API bad request: ${detail || 'check your request parameters'}`;
            break;
        case 401:
            message = 'Invalid DeepSeek API key. Run "Nika: Input Deepseek userToken" to update it.';
            break;
        case 402:
            message = 'DeepSeek API: insufficient balance. Please top up your DeepSeek account.';
            break;
        case 429:
            message = 'DeepSeek API rate limit exceeded. Please wait and try again.';
            break;
        case 500:
        case 502:
        case 503:
            message = 'DeepSeek service is temporarily unavailable. Please try again later.';
            break;
    }

    if (detail && !message.includes(detail)) {
        message += ` (${detail})`;
    }

    log.error(`DeepSeek API HTTP ${response.status}`, new Error(message));
    throw new Error(message);
}

// --- Non-Streaming (for key validation) ---

export async function validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const response = await fetch(DEEPSEEK_CHAT_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'deepseek-v4-flash',
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 1,
                stream: false,
            }),
        });

        if (response.ok) {
            return { valid: true };
        }

        if (response.status === 401) {
            return { valid: false, error: 'Invalid API key' };
        }

        return { valid: false, error: `API returned status ${response.status}` };
    } catch (err) {
        return {
            valid: false,
            error: err instanceof Error ? err.message : 'Network error connecting to DeepSeek API',
        };
    }
}
