import * as vscode from 'vscode';
import { NikaChatProvider } from './provider.js';
import { chooseProvider } from './commands/chooseProvider.js';
import { checkForUpdates } from './commands/updateExtension.js';
import { VISION_MODELS, getConfig, getOllamaBaseUrl, getVisionModelKey, DEEPSEEK_MODELS, CONTEXT_WINDOW_PRESETS, getContextWindowPreset, MAX_TOKENS_PRESETS, getMaxTokensPreset, LOG_LEVELS, getLogLevelSetting } from './config.js';
import { setLogLevel } from './log.js';
import { visionLog } from './vision/log.js';
import { listVSCodeVisionModels } from './vision/sources/vscode-lm.js';
import { NikaUsageStatus } from './usage/status.js';
import { showUsagePanel } from './usage/panel.js';

/**
 * Nika VS Code Extension — language model provider for Copilot Chat.
 *
 * Provides under the single "Nika" vendor:
 * - DeepSeek V4 Flash & Pro (requires DeepSeek API key)
 * - Gemini 2.5 Flash & Flash-Lite (requires Gemini API key)
 * - Gemma 4 via Ollama (local, no key needed)
 * - Configurable vision preprocessing for images (Gemma 4 / Gemini)
 * - Commands: Nika: Choose Provider, Nika: Manage
 */
export async function activate(context: vscode.ExtensionContext) {
    const provider = new NikaChatProvider(context);

    // Nika usage meter (DeepSeek token tracking) — status bar + summary.
    const usageStatus = new NikaUsageStatus(provider.usageTracker);
    context.subscriptions.push({ dispose: () => usageStatus.dispose() });

    // Sync log level from settings on startup
    setLogLevel(getLogLevelSetting());

    // Listen for log level changes in settings
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('nika.logLevel')) {
                setLogLevel(getLogLevelSetting());
            }
        })
    );

    // Register the single language model chat provider — all models under "Nika"
    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('nika', provider)
    );

    // Check if DeepSeek API key is configured on startup
    const apiKey = await provider.getApiKey();
    if (!apiKey) {
        const setKeyNow = 'Set API Key';
        const response = await vscode.window.showWarningMessage(
            'Nika: DeepSeek API key not configured. The Nika models will not appear in the Copilot Chat model picker until you set your API key.',
            setKeyNow
        );
        if (response === setKeyNow) {
            inputDeepseekToken(context);
        }
    }

    // Pre-warm vision modules so the first chat request doesn't have to
    // cold-start dynamic imports (which can cause transient failures).
    prewarmVisionModules().catch(() => { /* non-fatal */ });

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('nika.chooseProvider', () => chooseProvider()),
        vscode.commands.registerCommand('nika.chooseVisionModel', () => chooseVisionModel()),
        vscode.commands.registerCommand('nika.setOllamaHost', () => setOllamaHost()),
        vscode.commands.registerCommand('nika.inputDeepseekToken', () => inputDeepseekToken(context)),
        vscode.commands.registerCommand('nika.inputGeminiToken', () => inputGeminiToken(context)),

        vscode.commands.registerCommand('nika.chooseMaxTokens', () => chooseMaxTokens()),
        vscode.commands.registerCommand('nika.chooseContextWindow', () => chooseContextWindow()),
        vscode.commands.registerCommand('nika.agentModelAssignments', () => agentModelAssignments()),
        vscode.commands.registerCommand('nika.setFlashForAllAgents', () => setFlashForAllAgents()),
        vscode.commands.registerCommand('nika.chooseLogLevel', () => chooseLogLevel()),
        vscode.commands.registerCommand('nika.checkForUpdates', () => checkForUpdates(context)),
        vscode.commands.registerCommand('nika.showUsage', () => showUsagePanel(provider.usageTracker)),
        vscode.commands.registerCommand('nika.manage', () => {
            vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) Input DeepSeek API Key',
                        description: 'Set your DeepSeek API key (required for Nika to work)',
                    },
                    {
                        label: '$(list-tree) Choose Provider',
                        description: 'Select which DeepSeek model to use',
                    },
                    {
                        label: '$(eye) Choose Vision Model',
                        description: 'Select which vision model preprocesses images',
                    },

                    {
                        label: '$(symbol-method) Max Output Tokens',
                        description: 'Set maximum response length (16K recommended for thinking mode)',
                    },
                    {
                        label: '$(window) Context Window',
                        description: 'Set maximum input context size (128K recommended)',
                    },
                    {
                        label: '$(output) Log Level',
                        description: 'Set logging verbosity (INFO is default, VERBOSE for debugging)',
                    },
                    {
                        label: '$(symbol-misc) Agent Model Assignments',
                        description: 'Configure which model each Copilot agent uses (Explore, Plan, etc.)',
                    },
                    {
                        label: '$(rocket) Apply Recommended Agent Models',
                        description: 'Explore/Utility/Inline → Flash, Plan → Pro',
                    },
                    {
                        label: '$(key) Input Gemini API Key',
                        description: 'Set Gemini API key for vision/image support',
                    },
                    {
                        label: '$(server) Set Ollama Host',
                        description: 'Change Ollama server URL (for Gemma 4 vision)',
                    },
                    {
                        label: '$(link-external) Get DeepSeek API Key',
                        description: 'Open DeepSeek Platform to create an API key',
                    },
                    {
                        label: '$(link-external) Get Gemini API Key',
                        description: 'Open Google AI Studio to get a free Gemini API key',
                    },
                    {
                        label: '$(cloud-download) Check for Updates',
                        description: 'Download and install the latest version from GitHub',
                    },
                    {
                        label: '$(pulse) Show Usage',
                        description: 'Today / last-14-days DeepSeek token usage and estimated cost',
                    },
                ],
                { title: 'Nika: Manage' }
            ).then(selection => {
                if (!selection) return;
                switch (selection.label) {
                    case '$(key) Input DeepSeek API Key':
                        inputDeepseekToken(context);
                        break;
                    case '$(list-tree) Choose Provider':
                        vscode.commands.executeCommand('nika.chooseProvider');
                        break;
                    case '$(eye) Choose Vision Model':
                        vscode.commands.executeCommand('nika.chooseVisionModel');
                        break;

                    case '$(symbol-method) Max Output Tokens':
                        vscode.commands.executeCommand('nika.chooseMaxTokens');
                        break;
                    case '$(window) Context Window':
                        vscode.commands.executeCommand('nika.chooseContextWindow');
                        break;
                    case '$(output) Log Level':
                        vscode.commands.executeCommand('nika.chooseLogLevel');
                        break;
                    case '$(symbol-misc) Agent Model Assignments':
                        vscode.commands.executeCommand('nika.agentModelAssignments');
                        break;
                    case '$(rocket) Apply Recommended Agent Models':
                        vscode.commands.executeCommand('nika.setFlashForAllAgents');
                        break;
                    case '$(key) Input Gemini API Key':
                        inputGeminiToken(context);
                        break;
                    case '$(server) Set Ollama Host':
                        setOllamaHost();
                        break;
                    case '$(link-external) Get DeepSeek API Key':
                        vscode.env.openExternal(
                            vscode.Uri.parse('https://platform.deepseek.com/api_keys')
                        );
                        break;
                    case '$(link-external) Get Gemini API Key':
                        vscode.env.openExternal(
                            vscode.Uri.parse('https://aistudio.google.com/apikey')
                        );
                        break;
                    case '$(cloud-download) Check for Updates':
                        vscode.commands.executeCommand('nika.checkForUpdates');
                        break;
                    case '$(pulse) Show Usage':
                        showUsagePanel(provider.usageTracker);
                        break;
                }
            });
        })
    );
}

/**
 * Prompt for DeepSeek API key (required for Nika to work).
 */
async function inputDeepseekToken(context: vscode.ExtensionContext): Promise<void> {
    const key = await vscode.window.showInputBox({
        title: 'Nika: DeepSeek API Key',
        prompt: 'Enter your DeepSeek API key (from https://platform.deepseek.com/api_keys)',
        password: true,
        placeHolder: 'sk-...',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value.trim()) {
                return 'API key cannot be empty';
            }
            return null;
        },
    });

    if (!key) return;

    await context.secrets.store('nika.deepseek.apiKey', key.trim());
    vscode.window.showInformationMessage(
        'Nika: DeepSeek API key saved! The Nika models should now appear in the Copilot Chat model picker.'
    );
}

/**
 * Ollama host setter — lets user configure remote Ollama instances.
 */
async function setOllamaHost(): Promise<void> {
    const config = getConfig();
    const current = getOllamaBaseUrl();

    const url = await vscode.window.showInputBox({
        title: 'Nika: Ollama Host URL',
        prompt: 'Enter the Ollama server URL (e.g., http://192.168.1.100:11434)',
        value: current,
        placeHolder: 'http://localhost:11434',
        ignoreFocusOut: true,
        validateInput: (value) => {
            try {
                const u = new URL(value);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                    return 'URL must start with http:// or https://';
                }
                return null;
            } catch {
                return 'Invalid URL format';
            }
        },
    });

    if (!url) return;

    await config.update('ollamaBaseUrl', url.trim().replace(/\/$/, ''), vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Nika: Ollama host set to ${url.trim().replace(/\/$/, '')}`);
}

/**
 * Vision model picker — lets user choose between Nika-native models
 * (Gemini, Gemma4) and Copilot-provided models (GPT-4o, Claude, etc.).
 *
 * - Nika-native models → set `visionModel`, clear `visionModelKey`
 * - Copilot models    → set `visionModelKey` (vendor/id), clear `visionModel`
 */
async function chooseVisionModel(): Promise<void> {
    const config = getConfig();
    const currentVisionModel = config.get<string>('visionModel');
    const currentVisionModelKey = getVisionModelKey();

    // Phase 1: Pick category — Nika Native or Copilot
    const categoryItems: vscode.QuickPickItem[] = [
        {
            label: 'Nika Native',
            description: 'Gemini, Gemma4 — requires API key or local Ollama',
        },
        {
            label: 'Copilot Models',
            description: 'GPT-4o, Claude, Gemini (via Copilot) — uses Copilot quota',
        },
    ];

    const category = await vscode.window.showQuickPick(categoryItems, {
        title: 'Nika: Choose Vision Model — Source',
        placeHolder: 'Select a source for image descriptions',
    });

    if (!category) return;

    if (category.label === 'Nika Native') {
        // Phase 2a: Nika-native models
        const items: vscode.QuickPickItem[] = VISION_MODELS.map(m => ({
            label: m.id === currentVisionModel ? `$(check) ${m.name}` : `$(blank) ${m.name}`,
            description: m.description,
            detail: m.requiresApiKey ? 'Requires Gemini API key' : 'Runs locally via Ollama — no API key needed',
        }));

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Nika: Choose Vision Model — Nika Native',
            placeHolder: 'Select a vision model for image preprocessing',
            matchOnDescription: true,
        });

        if (!selected) return;

        const modelId = VISION_MODELS.find(m => selected.label.endsWith(m.name))?.id;
        if (modelId) {
            // Set visionModel, clear visionModelKey
            await config.update('visionModel', modelId, vscode.ConfigurationTarget.Global);
            await config.update('visionModelKey', undefined, vscode.ConfigurationTarget.Global);
            const modelName = VISION_MODELS.find(m => m.id === modelId)?.name ?? modelId;
            vscode.window.showInformationMessage(`Nika: Selected ${modelName} for vision`);
        }
    } else {
        // Phase 2b: Copilot models — fetch live from selectChatModels
        const copilotModels = await listVSCodeVisionModels();

        if (copilotModels.length === 0) {
            vscode.window.showWarningMessage(
                'Nika: No Copilot vision models available. Ensure you have a Copilot subscription and vision-capable models enabled.'
            );
            return;
        }

        const items: vscode.QuickPickItem[] = copilotModels.map(m => ({
            label: m.key === currentVisionModelKey ? `$(check) ${m.label}` : `$(blank) ${m.label}`,
            description: m.description,
            detail: 'Uses your Copilot quota — no extra API keys needed',
        }));

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Nika: Choose Vision Model — Copilot',
            placeHolder: 'Select a vision-capable Copilot model',
            matchOnDescription: true,
        });

        if (!selected) return;

        const modelKey = copilotModels.find(m => selected.label.endsWith(m.label))?.key;
        if (modelKey) {
            // Set visionModelKey, clear visionModel
            await config.update('visionModelKey', modelKey, vscode.ConfigurationTarget.Global);
            await config.update('visionModel', undefined, vscode.ConfigurationTarget.Global);
            const parts = modelKey.split('/');
            const modelName = parts[1] ?? modelKey;
            vscode.window.showInformationMessage(`Nika: Selected Copilot model "${modelName}" for vision`);
        }
    }
}

/**
 * Prompt for Gemini API key (for vision preprocessing).
 */
async function inputGeminiToken(context: vscode.ExtensionContext): Promise<void> {
    const key = await vscode.window.showInputBox({
        title: 'Nika: Gemini API Key (for vision)',
        prompt: 'Enter your Gemini API key (free at https://aistudio.google.com/apikey)',
        password: true,
        placeHolder: 'AIza...',
        ignoreFocusOut: true,
    });

    if (!key) return;

    await context.secrets.store('nika.gemini.apiKey', key.trim());
    vscode.window.showInformationMessage(
        'Nika: Gemini API key saved! Image/vision support is now enabled.'
    );
}

/**
 * Context window selector — lets user cap input tokens for cost/speed control.
 */
async function chooseContextWindow(): Promise<void> {
    const config = getConfig();
    const current = getContextWindowPreset();

    const items: vscode.QuickPickItem[] = CONTEXT_WINDOW_PRESETS.map(p => {
        const check = p.id === current ? '$(check)' : '$(blank)';
        const recommended = p.recommended ? ' $(star) Recommended' : '';
        return {
            label: `${check} ${p.label}`,
            description: `${p.tokens.toLocaleString()} tokens${recommended}`,
            detail: p.description,
        };
    });

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Nika: Context Window',
        placeHolder: 'Select maximum input context size (tokens)',
        matchOnDescription: true,
    });

    if (!selected) return;

    const preset = CONTEXT_WINDOW_PRESETS.find(p => selected.label.endsWith(p.id))?.id;
    if (preset) {
        await config.update('contextWindow', preset, vscode.ConfigurationTarget.Global);
        const found = CONTEXT_WINDOW_PRESETS.find(p => p.id === preset);
        vscode.window.showInformationMessage(
            `Nika: Context window set to ${preset} (${found?.tokens.toLocaleString()} tokens)`
        );
    }
}

/**
 * Max output tokens picker — controls how long responses can be.
 *
 * Thinking mode consumes tokens just on reasoning. The 16K preset is the
 * sweet spot: ~8K for reasoning + ~8K for visible output. Without thinking,
 * the full budget goes to visible text.
 */
async function chooseMaxTokens(): Promise<void> {
    const config = getConfig();
    const current = getMaxTokensPreset();

    const items: vscode.QuickPickItem[] = MAX_TOKENS_PRESETS.map(p => {
        const check = p.id === current ? '$(check)' : '$(blank)';
        let badges = '';
        if (p.recommended) badges += ' $(star) Recommended';
        if (p.thinkingRecommended) badges += ' $(chip) Best for thinking';
        return {
            label: `${check} ${p.label}`,
            description: `${p.tokens.toLocaleString()} tokens${badges}`,
            detail: p.description,
        };
    });

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Nika: Max Output Tokens',
        placeHolder: 'Select maximum output length. 16K+ recommended when thinking mode is on.',
        matchOnDescription: true,
    });

    if (!selected) return;

    const preset = MAX_TOKENS_PRESETS.find(p => selected.label.endsWith(p.id))?.id;
    if (preset) {
        await config.update('maxTokens', preset, vscode.ConfigurationTarget.Global);
        const found = MAX_TOKENS_PRESETS.find(p => p.id === preset);
        const thinkingNote = found?.thinkingRecommended ? ' Good for thinking mode.' : '';
        vscode.window.showInformationMessage(
            `Nika: Max output tokens set to ${preset} (${found?.tokens.toLocaleString()}).${thinkingNote}`
        );
    }
}

/**
 * Open VS Code settings to configure which model each agent uses.
 *
 * Native VS Code settings available:
 *   - chat.exploreAgent.defaultModel  → Explore subagent
 *   - chat.planAgent.defaultModel     → Plan agent
 *   - chat.utilityModel               → Utility flows (commit messages, etc.)
 *   - chat.utilitySmallModel          → Small/fast utility flows
 *   - inlineChat.defaultModel         → Inline chat (Ctrl+I)
 *
 * Subagents inherit the model of their parent agent by default.
 * To force a specific model for a subagent, set the agent's defaultModel above.
 */
async function agentModelAssignments(): Promise<void> {
    const items: (vscode.QuickPickItem & { setting: string; isCommand?: boolean })[] = [
        { label: '$(search) Explore Agent', description: 'chat.exploreAgent.defaultModel — Model used by the Explore subagent', setting: 'chat.exploreAgent.defaultModel' },
        { label: '$(list-plan) Plan Agent', description: 'chat.planAgent.defaultModel — Model used by the Plan agent', setting: 'chat.planAgent.defaultModel' },
        { label: '$(tools) Utility Model', description: 'chat.utilityModel — Model for built-in utility flows', setting: 'chat.utilityModel' },
        { label: '$(rocket) Utility Small Model', description: 'chat.utilitySmallModel — Small/fast model for utility flows', setting: 'chat.utilitySmallModel' },
        { label: '$(edit) Inline Chat', description: 'inlineChat.defaultModel — Model used by inline chat (Ctrl+I)', setting: 'inlineChat.defaultModel' },
        { label: '$(git-commit) Generate Commit Message', description: 'Generate a commit message from staged changes using Copilot', setting: 'github.copilot.git.generateCommitMessage', isCommand: true },
        { label: '$(github) Build Codebase Semantic Index', description: 'Build remote codebase index for faster @workspace searches', setting: 'github.copilot.buildRemoteWorkspaceIndex', isCommand: true },
        { label: '$(trash) Delete External Ingest Index', description: 'Delete the external ingest codebase index', setting: 'github.copilot.deleteExternalIngestWorkspaceIndex', isCommand: true },
        { label: '$(settings-gear) All Chat Settings', description: 'Open all chat-related settings', setting: '@ext:github.copilot-chat' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Nika: Agent Model Assignments',
        placeHolder: 'Select which agent model to configure',
        matchOnDescription: true,
    });

    if (!pick) return;

    if (pick.isCommand) {
        await vscode.commands.executeCommand(pick.setting);
    } else if (pick.setting === '@ext:github.copilot-chat') {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:github.copilot-chat');
    } else {
        await vscode.commands.executeCommand('workbench.action.openSettings', pick.setting);
    }
}

/**
 * Quick-set agents to recommended models with one click.
 *   - Explore, Utility, Inline Chat → DeepSeek V4 Flash (fast)
 *   - Plan Agent                   → DeepSeek V4 Pro  (deep reasoning)
 */
async function setFlashForAllAgents(): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const target = vscode.ConfigurationTarget.Global;

    const settings = [
        { key: 'chat.exploreAgent.defaultModel', label: 'Explore Agent', model: 'nika/deepseek-v4-flash' },
        { key: 'chat.planAgent.defaultModel', label: 'Plan Agent', model: 'nika/deepseek-v4-pro' },
        { key: 'chat.utilityModel', label: 'Utility Model', model: 'nika/deepseek-v4-flash' },
        { key: 'inlineChat.defaultModel', label: 'Inline Chat', model: 'nika/deepseek-v4-flash' },
    ];

    const confirm = await vscode.window.showInformationMessage(
        `Apply recommended agent models?\n\n` +
        settings.map(s => `  • ${s.label} → ${s.model}`).join('\n'),
        { modal: true },
        'Apply'
    );

    if (confirm !== 'Apply') return;

    let success = 0;
    let failed = 0;
    for (const s of settings) {
        try {
            await config.update(s.key, s.model, target);
            success++;
        } catch {
            failed++;
        }
    }

    if (failed === 0) {
        vscode.window.showInformationMessage(
            `Nika: Agent models updated. Reload window to apply.`
        );
    } else {
        vscode.window.showWarningMessage(
            `Nika: Set ${success}/${settings.length} settings. ${failed} failed.`
        );
    }
}

/**
 * Log level picker — lets user control logging verbosity.
 */
async function chooseLogLevel(): Promise<void> {
    const config = getConfig();
    const current = getLogLevelSetting();

    const items: vscode.QuickPickItem[] = LOG_LEVELS.map(l => ({
        label: l.id === current ? `$(check) ${l.label}` : `$(blank) ${l.label}`,
        description: l.description,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Nika: Log Level',
        placeHolder: 'Select logging verbosity (writes to nika.log)',
        matchOnDescription: true,
    });

    if (!selected) return;

    const level = LOG_LEVELS.find(l => selected.label.endsWith(l.label))?.id;
    if (level) {
        await config.update('logLevel', level, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Nika: Log level set to ${level}`);
    }
}

/**
 * Pre-warm vision modules so dynamic imports are cached before the
 * first chat request arrives. This prevents transient failures caused
 * by cold-started module loading or secret store lookups.
 */
async function prewarmVisionModules(): Promise<void> {
    try {
        // Warm the Gemini vision module
        await import('./vision/gemini.js');
        visionLog.info('Prewarmed Gemini vision module');
    } catch {
        // Non-fatal: Gemini may not be configured
    }

    try {
        // Warm the Gemma4 vision module
        await import('./vision/gemma4.js');
        visionLog.info('Prewarmed Gemma4 vision module');
    } catch {
        // Non-fatal: Gemma4/Ollama may not be available
    }

    try {
        // Warm the replay and pipeline modules (used in every chat request)
        await import('./vision/replay.js');
        await import('./vision/pipeline.js');
        visionLog.info('Prewarmed replay/pipeline modules');
    } catch {
        // Non-fatal
    }
}

export function deactivate() {
    // Cleanup handled by disposables in context.subscriptions
}
