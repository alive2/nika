# Nika — DeepSeek Token Usage Tracking: Implementation Plan

**Source:** [alive2/nika-code v1.3.0](https://github.com/alive2/nika-code/releases/tag/v1.3.0) (commit `aa5231a`, upstream commit `b8539477`), feature "Nika token usage tracking" — `docs/TOKEN-USAGE.md`.
**Goal:** Port the usage tracking (ledger, pricing, status-bar meter, session attribution) into this standalone Nika extension, **without** the Nika Settings webview "Usage" dashboard (rate card, SVG chart, tables, clear button, `nika.usage.enabled` UI toggle in settings is still included as a plain config setting).

---

## 1. What we're porting vs. what we're skipping

### Port (in scope)

| Piece | Reference file | Port to |
|---|---|---|
| DeepSeek peak/off-peak pricing + cost math + formatters | `nikaPricing.ts` | `src/usage/pricing.ts` |
| Persistent usage ledger (`globalState`, cap 5000, prune) + per-day/session/workspace aggregations + heuristic session ids | `nikaUsageTracker.ts` | `src/usage/tracker.ts` |
| `TokenTrackingProgress` (live char→token estimate + exact `usage` capture) | `nikaUsageTracker.ts` | `src/usage/tracker.ts` |
| Status-bar usage meter (live counter while streaming; idle: today totals + PEAK/OFF-PEAK countdown) | `nikaUsageStatus.ts` | `src/usage/status.ts` |
| Provider integration (wrap progress, record exact/fallback/error) | `nikaProvider.ts` DeepSeek branch | `src/provider.ts` |
| `nika.usage.enabled` setting | `package.json` + `package.nls.json` | `package.json` + `src/config.ts` |
| Enrich `onComplete` usage payload with cached + reasoning tokens | (implied by `APIUsage`) | `src/api/deepseek.ts` + `src/api/types.ts` |
| Unit tests | `test/nikaPricing.spec.ts`, `test/nikaUsageTracker.spec.ts` | `src/usage/*.test.ts` (node:test) |

### Skip (out of scope, per request)

- **Settings webview "Usage" dashboard** — `nikaSettingsEditor.ts` usage section (KPIs, 14-day SVG bar chart, sessions/workspaces/messages tables, *Clear usage data* button).
- Any UI wiring that requires opening the dashboard (the status-bar click in the reference calls `settingsEditor.open('usage')`; we replace that with a plain QuickPick summary — see §7).
- Fork-only core modifications for session threading (`extChatEndpoint.ts`, `byokLmProxyService.ts`) — see §6. We can't modify VS Code core from a standalone extension.

---

## 2. Grounding: how our architecture differs from the reference

The reference is a **fork of VS Code + the Copilot extension**. Ours is a **standalone extension** that directly calls the DeepSeek API. This changes a few things:

| Concern | Reference (fork) | Ours (standalone) |
|---|---|---|
| Streaming usage source | `CopilotLanguageModelWrapper` emits a `'usage'` data part (`APIUsage` with `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`) | `streamDeepSeekChat()` / `streamDeepSeekResponses()` parse the wire usage; we must forward cached/reasoning counts in `onComplete` (currently only `promptTokens`/`completionTokens`) |
| Progress part type | `vscode.LanguageModelResponsePart2` | `vscode.LanguageModelResponsePart` (our provider signature) — the `TokenTrackingProgress` wrapper must handle text/thinking/data parts on this union |
| Session id | Threaded from core via `_nikaSessionId` in `modelOptions` | Not available from core; read `modelOptions._nikaSessionId` defensively + use the reference's heuristic fallback (`workspace\|initiator` + 30-min window) |
| DI / lifecycle | `IInstantiationService`, `Disposable` | Plain constructor, `ExtensionContext.subscriptions`, explicit dispose |
| Settings | Webview `NikaSettingsEditor` | No webview; config-only (`package.json` `configuration`) |
| Status bar | Existing `NikaIndexingStatus` pattern | No status bar items exist yet — we create the first |

Pricing table is identical (DeepSeek peak/off-peak, effective 2026-08-16 16:00 UTC; off-peak = half of peak). Model ids already match ours: `deepseek-v4-flash`, `deepseek-v4-pro`, and `-responses` aliases bill at base rate — our `DEEPSEEK_RESPONSES_MODELS[].apiModel` already gives us the canonical key.

---

## 3. Data model (port from reference, adapted)

`src/usage/tracker.ts` exports:

```ts
export interface NikaUsageEvent {
  id: number;                 // monotonic, persisted
  t: number;                  // completion timestamp (ms)
  sessionId: string;          // real or heuristic
  title?: string;             // first user text, ≤80 chars
  workspace?: string;         // first workspace folder name
  model: string;              // wire model id (e.g. deepseek-v4-pro-responses)
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;       // input tokens served from context cache
  reasoningTokens: number;    // included in completionTokens
  peak: boolean;              // landed in a peak billing window
  cost: number;               // USD, off-peak adjusted; 0 when not computable
  error?: boolean;            // true when request failed pre-usage
}

export interface NikaDailySummary { date: string; requests: number; promptTokens: number; completionTokens: number; totalTokens: number; cost: number; }
export interface NikaSessionSummary { sessionId: string; title?: string; workspace?: string; start: number; end: number; requests: number; promptTokens: number; completionTokens: number; totalTokens: number; cost: number; }
export interface NikaWorkspaceSummary { workspace: string; sessions: number; requests: number; totalTokens: number; cost: number; }
```

`NikaUsageTracker` (class, no DI):

- Constructor takes `context: vscode.ExtensionContext`; reads `nika.usage.enabled` (default `true`), subscribes to config changes, `_load()`s from `globalState` (`nika.usage.events`, `nika.usage.nextId`).
- `record(options)` — resolves session id, computes cost via `getDeepSeekTokenCost`, pushes event, prunes to `MAX_EVENTS = 5000`, saves, fires `onDidChange`.
- `trackStream(progress): () => void` — registers a live stream; dispose handle removes it.
- `get liveTokenEstimate` / `get liveStreamCount` / `get events` / `get enabled`.
- `clear()` — wipe ledger (used by a future dashboard; keep the API).
- `getDailySummary(days)`, `getSessionSummaries(limit)`, `getWorkspaceSummaries()`, `getMessageHistory(limit)` — keep all aggregations so a dashboard can be added later without rework.
- `_resolveSessionId(sessionId, workspace, initiator, t)` — real id wins; else `heur:{workspace|initiator}:{YYYY-MM-DDTHH}` with a 30-min reuse window.
- `toUtcDateKey(t)` helper.

`TokenTrackingProgress` wraps `vscode.Progress<vscode.LanguageModelResponsePart>`:

- `report(part)` forwards verbatim; accumulates chars from `LanguageModelTextPart` and `LanguageModelThinkingPart` (string or array form) → `liveEstimateTokens = round(chars/4)`.
- Detects the `'usage'` data part (our provider already reports `LanguageModelDataPart` with mime `'usage'`), parses it, stores `exactUsage`.
- Getters: `liveEstimateTokens`, `exactUsage`.

---

## 4. `src/usage/pricing.ts` (port of `nikaPricing.ts`)

Exports (identical logic to reference):

```ts
export interface DeepSeekModelPricing { cacheHitPerMTok: number; cacheMissPerMTok: number; outputPerMTok: number; }
export const NIKA_DEEPSEEK_PEAK_PRICES = {
  'deepseek-v4-flash': { cacheHitPerMTok: 0.014, cacheMissPerMTok: 0.44, outputPerMTok: 1.32 },
  'deepseek-v4-pro':   { cacheHitPerMTok: 0.044, cacheMissPerMTok: 1.32,  outputPerMTok: 3.96 },
} as const;

export function isDeepSeekPeakHour(date = new Date()): boolean;      // (hour>=1&&hour<4)||(hour>=6&&hour<10) UTC
export function getDeepSeekRatePeriod(date = new Date()): NikaRatePeriodInfo; // { peak, endsAt, nextIsPeak }
export function formatDuration(ms: number): string;                  // '45m' | '1h' | '1h 23m' | '<1m'
export function deepSeekPricingKey(id: string): string | undefined;  // strips '-responses' suffix
export function getDeepSeekTokenCost(modelId, { inputTokens, outputTokens, cachedTokens }, date): DeepSeekTokenCostBreakdown | undefined;
export function formatCost(cost: number): string;                    // '$0' | '$0.0004' | '$1.24'
export function formatTokenCount(tokens: number): string;            // '1.2k' | '34k' | '1.4M'
```

Key points:
- `deepSeekPricingKey` strips `-responses` → maps `deepseek-v4-pro-responses` → `deepseek-v4-pro`.
- Cache split: `cacheHit = min(cached, input)`, `cacheMiss = input - cacheHit`, `output` as-is; cost = `(hit×$hit + miss×$miss + out×$out) × (peak ? 1 : 0.5)`.
- No dependency on `NikaModelId` (reference imports it from `nikaModels.ts`, which we don't have) — price keys are plain strings keyed off `deepSeekPricingKey`.

---

## 5. `src/usage/status.ts` (port of `nikaUsageStatus.ts`)

`NikaUsageStatus` (plain class; `dispose()` added to subscriptions):

- Creates `vscode.window.createStatusBarItem('nika.usageStatus', Right, 99)`, `name = 'Nika Usage'`, priority below nothing else (ours is the first status item).
- Subscribes to `tracker.onDidChange` → throttled re-render (`UPDATE_THROTTLE_MS = 250`).
- While `liveStreamCount > 0`: `showProgress = 'loading'`, text `Nika {formatTokenCount(estimate)} tok`, tooltip "Nika tokens streaming (N active request(s))...".
- Idle: `showProgress = false`, text `` `$(pulse) Nika today {tokens} tok · {cost} · {PEAK|OFF-PEAK} · {countdown}` ``; countdown refreshes on a 30s interval (`COUNTDOWN_REFRESH_MS`).
- Hidden when `!tracker.enabled`.
- **Click behavior (deviation):** reference registers `nika.openUsageSettings` → opens Settings `usage` section. Ours registers `nika.showUsage` → shows a QuickPick summary (today + last 14 days tokens/cost, per-session top 5) built from `tracker.getDailySummary(14)` / `getSessionSummaries(5)` — no webview, satisfies "no dashboard". (Swap this command for the dashboard open later if desired.)

---

## 6. Session id threading (deviation from reference)

Reference threads real chat session ids by **modifying VS Code core** (`extChatEndpoint.ts` path A, `byokLmProxyService.ts` path B). We cannot do that in a standalone extension.

Plan for attribution in `provider.ts`:

1. Read `options.modelOptions?._nikaSessionId` if a string (future-proof — if a future VS Code or fork supplies it, we pick it up for free).
2. Otherwise fall back to the reference's heuristic: `NikaUsageTracker._resolveSessionId(undefined, workspace, initiator, t)` → buckets by `workspace|initiator` within a 30-minute window.
3. `initiator`: use `options.requestInitiator` if present, else `'core'` (matches reference).
4. `workspace`: `vscode.workspace.workspaceFolders?.[0]?.name` fallback to active editor's first path segment, else `undefined` (port `currentWorkspaceName()`).
5. `title`: port `extractPromptTitle(messages)` — first non-empty user text, trimmed to 80 chars.

This means session grouping is coarser than the reference (conversation-bound), but nothing goes untracked, and the data model supports real ids the moment they're available.

---

## 7. Provider integration (`src/provider.ts`)

Changes are confined to the two DeepSeek handlers (chat-completions inline + `handleDeepSeekResponsesChat`). Gemini/Gemma stay untouched (tracker records DeepSeek-only; `getDeepSeekTokenCost` returns `undefined` for non-DeepSeek models anyway).

Per handler, mirror the reference `NikaLMProvider.provideLanguageModelChatResponse` DeepSeek branch:

1. **Construct** `const tracker = ...` once in the provider constructor (from `context`).
2. **Wrap progress:**
   ```ts
   const tracked = new TokenTrackingProgress(progress, () => tracker.notifyLiveChange());
   const disposeStream = tracker.trackStream(tracked);
   ```
3. **Meta:** `sessionId`, `title`, `workspace`, `initiator` (see §6).
4. **Success:** after `streamDeepSeekChat`/`streamDeepSeekResponses` resolves, call a ported `_recordUsage(modelId, tracked, meta)`:
   - If `tracked.exactUsage` → `tracker.record({ model, sessionId, initiator, title, workspace, promptTokens, completionTokens, totalTokens, cachedTokens, reasoningTokens })`.
   - Else if `liveEstimateTokens > 0` → record `{ promptTokens: 0, completionTokens: estimate, totalTokens: estimate, cachedTokens: 0, reasoningTokens: 0 }`.
   - Else (nothing) → record nothing (or a zeroed event with `error: true` only on failures).
5. **Failure:** in the existing `catch` blocks, call `tracker.record({ ...zeros, error: true })` before rethrowing (skip when user-cancelled).
6. **finally:** `disposeStream()`.

Because `TokenTrackingProgress` also forwards the `'usage'` data part we already emit, VS Code's agent loop behavior is unchanged.

---

## 8. API enrichment (`src/api/deepseek.ts` + `src/api/types.ts`)

Cost needs the cache/reasoning split. Extend the `onComplete` payload in both streamers:

- `streamDeepSeekChat`: `onComplete(usage?: { promptTokens; completionTokens; cachedTokens?; reasoningTokens? })`
  - Chat Completions: `cachedTokens = parsed.usage.prompt_cache_hit_tokens ?? 0`, `reasoningTokens = parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0` (fields already on `DeepSeekUsage`).
  - Responses: `cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0`, `reasoningTokens = resp.usage.output_tokens_details?.reasoning_tokens ?? 0` (fields already on the responses usage type).
- `totalTokens` is already `prompt + completion`; the tracker computes cost itself via `getDeepSeekTokenCost`.
- The `'usage'` data part emitted in `provider.ts` onComplete can optionally carry the richer fields too (so the exact usage parsed by `TokenTrackingProgress` is exact). Recommended: include `prompt_tokens_details.cached_tokens` + `completion_tokens_details.reasoning_tokens` in the JSON we report, mirroring `APIUsage` so `exactUsage` is complete.

---

## 9. Config contributions

`package.json` `configuration.properties`:
```json
"nika.usage.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Record DeepSeek token usage (today/last-14-days totals and estimated cost) and show the Nika usage meter in the status bar."
}
```
`src/config.ts`: add `export function getUsageEnabled(): boolean { return getConfig().get<boolean>('usage.enabled') ?? true; }`.

`src/extension.ts`: instantiate `new NikaUsageTracker(context)` and `new NikaUsageStatus(tracker)` in `activate`, push their dispose handles into `context.subscriptions`; register `nika.showUsage` command; add a `Nika: Show Usage` entry to the `nika.manage` QuickPick.

---

## 10. Testing strategy

Project has no test runner today (`scripts` = compile/watch/package only; devDeps = typescript, @types/vscode, vsce, @types/node). Reference used vitest.

Plan: use the **built-in `node:test` runner** (zero new deps) for pure-logic modules:

- `src/usage/pricing.test.ts` — peak boundaries (`01:00–04:00`, `06:00–10:00` UTC half-open), cost math (incl. the reference's example: flash peak 100k/50k/40k cached → $0.09296), `formatCost`/`formatTokenCount`/`formatDuration`, `deepSeekPricingKey` stripping `-responses`, off-peak halving.
- `src/usage/tracker.test.ts` — record/persist/prune (cap 5000), per-day/session/workspace aggregates, heuristic id reuse within 30 min and new id after, `TokenTrackingProgress` char counting + `'usage'` part capture + verbatim forwarding, `record` no-op when disabled.

`tsconfig` already includes `src/**/*`, so tests compile with the same config. Add `"test": "node --test out/usage/*.test.js"` (after `compile`) to `scripts`. The vscode-dependent parts (`NikaUsageStatus`, provider wiring) are exercised by the usual manual F5 flow.

---

## 11. Ordered rollout

1. **`src/usage/pricing.ts`** (+ tests) — pure logic, no deps. Compile + test.
2. **`src/api/types.ts` / `src/api/deepseek.ts`** — enrich `onComplete` with cached/reasoning; keep existing callers compiling (provider `onComplete` signature is inferred; update both handlers' usage data part).
3. **`src/usage/tracker.ts`** (+ tests) — ledger, heuristic ids, `TokenTrackingProgress`; depends on `pricing.ts`.
4. **`src/usage/status.ts`** — status bar meter; depends on `tracker.ts` + `pricing.ts`.
5. **`src/provider.ts`** — integrate tracker into both DeepSeek handlers (wrap progress, record success/error, dispose stream).
6. **`src/config.ts` + `package.json` + `src/extension.ts`** — `nika.usage.enabled`, `getUsageEnabled()`, instantiate + dispose tracker/status, `nika.showUsage` command + `Nika: Manage` entry.
7. **Verify** — `npm run compile` clean; `node --test out/usage/*.test.js` green; manual F5: stream a chat (status bar shows live counter), idle (today totals + rate period countdown), check `globalState` (`nika.usage.events`), toggle `nika.usage.enabled` off (meter hides, recording stops).

---

## 12. Risks & edge cases

- **Exact vs estimate:** if a request succeeds without a `'usage'` chunk (rare; we force `include_usage`), the live char estimate is recorded so the request is never lost. Estimate uses ~4 chars/token, consistent with our existing `provideTokenCount`.
- **Cancellation:** aborted requests are recorded as neither success nor error (silent), matching the reference.
- **Cost precision:** sub-cent values formatted with 4 decimals (`$0.0004`); totals keep full float precision internally.
- **globalState size:** cap 5000 events, prune oldest; each event is small (~200 B), ≈1 MB worst case — acceptable, same as reference.
- **Responses API thinking:** `output_tokens_details.reasoning_tokens` may be absent on `-responses` models — default 0.
- **Non-DeepSeek models:** `getDeepSeekTokenCost` returns `undefined` → `cost: 0`, `peak: false`; we simply don't record Gemini/Gemma requests (reference is DeepSeek-only too).
- **Status bar throttling:** `showProgress` spinner must stay on a stable DOM node; coalesce renders to 250 ms so the spin animation doesn't stutter (reference pattern).
- **`nika.manage` menu growth:** add "Show Usage" entry near the bottom; no reordering of existing items.
