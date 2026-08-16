import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { NikaUsageTracker, TokenTrackingProgress, toUtcDateKey, isNikaUsagePayload } from './tracker.js';
import type { NikaUsageEvent } from './tracker.js';

/** Build a fake ExtensionContext with an inspectable in-memory globalState. */
function makeHarness(initial?: { events?: NikaUsageEvent[]; nextId?: number }): { context: vscode.ExtensionContext; store: Map<string, unknown> } {
    const store = new Map<string, unknown>();
    if (initial?.events) store.set('nika.usage.events', initial.events);
    if (initial?.nextId !== undefined) store.set('nika.usage.nextId', initial.nextId);
    const context = {
        globalState: {
            get: (key: string) => store.get(key),
            update: async (key: string, value: unknown) => { store.set(key, value); },
        },
    };
    return { context: context as unknown as vscode.ExtensionContext, store };
}

/** Seed the tracker's internal ledger directly (record() uses Date.now()). */
function seed(tracker: NikaUsageTracker, events: NikaUsageEvent[]): void {
    (tracker as unknown as { _events: NikaUsageEvent[] })._events = events;
}

function makeEvent(partial: Partial<NikaUsageEvent> & { id: number; t: number; sessionId: string; model: string }): NikaUsageEvent {
    return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        peak: false,
        cost: 0,
        ...partial,
    };
}

test('record persists a DeepSeek request with heuristic session id and cost', () => {
    const { context, store } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    tracker.record({
        model: 'deepseek-v4-flash',
        workspace: 'ws',
        initiator: 'core',
        title: 'Refactor parser',
        promptTokens: 100_000,
        completionTokens: 50_000,
        totalTokens: 150_000,
        cachedTokens: 40_000,
        reasoningTokens: 5_000,
    });

    assert.equal(tracker.events.length, 1);
    const event = tracker.events[0];
    assert.equal(event.model, 'deepseek-v4-flash');
    assert.equal(event.workspace, 'ws');
    assert.equal(event.title, 'Refactor parser');
    assert.equal(event.promptTokens, 100_000);
    assert.equal(event.cachedTokens, 40_000);
    assert.equal(event.reasoningTokens, 5_000);
    assert.ok(event.sessionId.startsWith('heur:ws|core:'));
    assert.equal(typeof event.cost, 'number');
    assert.ok(Number.isFinite(event.cost));
    assert.equal(typeof event.peak, 'boolean');
    // Persisted to globalState.
    const stored = store.get('nika.usage.events') as NikaUsageEvent[];
    assert.equal(stored.length, 1);
    assert.equal(store.get('nika.usage.nextId'), 2);
});

test('record honors a real session id over the heuristic', () => {
    const { context } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    tracker.record({
        model: 'deepseek-v4-pro-responses',
        sessionId: 'real-session-1',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedTokens: 0,
        reasoningTokens: 0,
    });
    assert.equal(tracker.events[0].sessionId, 'real-session-1');
});

test('record reuses heuristic id within the burst window, new id for different workspace', () => {
    const { context } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    const opts = {
        model: 'deepseek-v4-flash',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        cachedTokens: 0,
        reasoningTokens: 0,
    };
    tracker.record({ ...opts, workspace: 'ws', initiator: 'core' });
    tracker.record({ ...opts, workspace: 'ws', initiator: 'core' });
    assert.equal(tracker.events[0].sessionId, tracker.events[1].sessionId);

    tracker.record({ ...opts, workspace: 'other' });
    assert.notEqual(tracker.events[2].sessionId, tracker.events[0].sessionId);
});

test('record is a no-op when disabled', () => {
    const { context } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    (tracker as unknown as { _enabled: boolean })._enabled = false;
    tracker.record({
        model: 'deepseek-v4-flash',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedTokens: 0,
        reasoningTokens: 0,
    });
    assert.equal(tracker.events.length, 0);
});

test('prunes to MAX_EVENTS keeping the newest', () => {
    const { context } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    const seedEvents: NikaUsageEvent[] = [];
    for (let i = 1; i <= NikaUsageTracker.MAX_EVENTS + 5; i++) {
        seedEvents.push(makeEvent({ id: i, t: i, sessionId: 's', model: 'deepseek-v4-flash' }));
    }
    seed(tracker, seedEvents);
    (tracker as unknown as { _nextId: number })._nextId = NikaUsageTracker.MAX_EVENTS + 6;
    tracker.record({
        model: 'deepseek-v4-flash',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        cachedTokens: 0,
        reasoningTokens: 0,
    });
    assert.equal(tracker.events.length, NikaUsageTracker.MAX_EVENTS);
    // The newest (recorded) event must survive pruning.
    assert.equal(tracker.events[tracker.events.length - 1].id, NikaUsageTracker.MAX_EVENTS + 6);
});

test('loads persisted events and nextId from globalState', () => {
    const stored = [
        makeEvent({ id: 7, t: 1000, sessionId: 's', model: 'deepseek-v4-flash', totalTokens: 123 }),
    ];
    const { context } = makeHarness({ events: stored, nextId: 8 });
    const tracker = new NikaUsageTracker(context);
    assert.equal(tracker.events.length, 1);
    assert.equal(tracker.events[0].id, 7);
    tracker.record({
        model: 'deepseek-v4-flash',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        cachedTokens: 0,
        reasoningTokens: 0,
    });
    assert.equal(tracker.events[1].id, 8); // nextId continued from storage
});

test('getDailySummary groups by UTC day and respects the cutoff window', () => {
    const { context } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    const now = Date.now();
    const yesterday = now - 24 * 60 * 60 * 1000;
    const longAgo = now - 40 * 24 * 60 * 60 * 1000;
    seed(tracker, [
        makeEvent({ id: 1, t: now, sessionId: 's', model: 'deepseek-v4-flash', totalTokens: 100, cost: 0.01 }),
        makeEvent({ id: 2, t: yesterday, sessionId: 's', model: 'deepseek-v4-flash', totalTokens: 50, cost: 0.005 }),
        makeEvent({ id: 3, t: longAgo, sessionId: 's', model: 'deepseek-v4-flash', totalTokens: 999, cost: 0.99 }),
    ]);

    const daily = tracker.getDailySummary(30);
    assert.equal(daily.length, 2);
    assert.equal(daily[0].date, toUtcDateKey(yesterday));
    assert.equal(daily[1].date, toUtcDateKey(now));
    assert.equal(daily[1].totalTokens, 100);
    assert.equal(daily[1].cost, 0.01);
});

test('getSessionSummaries groups per session, most recent first', () => {
    const { context } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    seed(tracker, [
        makeEvent({ id: 1, t: 1000, sessionId: 'a', model: 'deepseek-v4-flash', totalTokens: 10, cost: 0.001 }),
        makeEvent({ id: 2, t: 3000, sessionId: 'a', model: 'deepseek-v4-flash', totalTokens: 20, cost: 0.002 }),
        makeEvent({ id: 3, t: 2000, sessionId: 'b', model: 'deepseek-v4-flash', totalTokens: 30, cost: 0.003 }),
    ]);
    const sessions = tracker.getSessionSummaries();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, 'a'); // latest end (3000)
    assert.equal(sessions[0].requests, 2);
    assert.equal(sessions[0].totalTokens, 30);
    assert.equal(sessions[0].cost, 0.003);
    assert.equal(sessions[0].start, 1000);
    assert.equal(sessions[0].end, 3000);
    assert.equal(sessions[1].sessionId, 'b');
});

test('getWorkspaceSummaries counts distinct sessions per workspace', () => {
    const { context } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    seed(tracker, [
        makeEvent({ id: 1, t: 1, sessionId: 's1', workspace: 'alpha', model: 'deepseek-v4-flash', totalTokens: 10 }),
        makeEvent({ id: 2, t: 2, sessionId: 's2', workspace: 'alpha', model: 'deepseek-v4-flash', totalTokens: 20 }),
        makeEvent({ id: 3, t: 3, sessionId: 's2', workspace: 'alpha', model: 'deepseek-v4-flash', totalTokens: 30 }),
        makeEvent({ id: 4, t: 4, sessionId: 's3', workspace: 'beta', model: 'deepseek-v4-flash', totalTokens: 5 }),
    ]);
    const workspaces = tracker.getWorkspaceSummaries();
    assert.equal(workspaces.length, 2);
    const alpha = workspaces.find(w => w.workspace === 'alpha');
    assert.ok(alpha);
    assert.equal(alpha.sessions, 2);
    assert.equal(alpha.requests, 3);
    assert.equal(alpha.totalTokens, 60);
});

test('getMessageHistory returns most recent first', () => {
    const { context } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    seed(tracker, [
        makeEvent({ id: 1, t: 1000, sessionId: 's', model: 'deepseek-v4-flash' }),
        makeEvent({ id: 2, t: 2000, sessionId: 's', model: 'deepseek-v4-flash' }),
    ]);
    const history = tracker.getMessageHistory();
    assert.equal(history[0].id, 2);
    assert.equal(history[1].id, 1);
});

test('clear wipes the ledger', () => {
    const { context } = makeHarness();
    const tracker = new NikaUsageTracker(context);
    seed(tracker, [makeEvent({ id: 1, t: 1, sessionId: 's', model: 'deepseek-v4-flash' })]);
    tracker.clear();
    assert.equal(tracker.events.length, 0);
});

test('TokenTrackingProgress forwards parts verbatim and counts live chars', () => {
    const forwarded: vscode.LanguageModelResponsePart[] = [];
    const delegate: vscode.Progress<vscode.LanguageModelResponsePart> = { report: p => forwarded.push(p) };
    let liveChanges = 0;
    const progress = new TokenTrackingProgress(delegate, () => { liveChanges++; });

    progress.report(new vscode.LanguageModelTextPart('hello world')); // 11 chars → ~3 tokens
    assert.equal(progress.liveEstimateTokens, 3);
    assert.equal(liveChanges, 1);
    progress.report(new vscode.LanguageModelTextPart('abcd')); // 15 chars total → ~4 tokens
    assert.equal(progress.liveEstimateTokens, 4);
    assert.equal(liveChanges, 2);
    assert.equal(forwarded.length, 2);
    assert.ok(forwarded[0] instanceof vscode.LanguageModelTextPart);
});

test('TokenTrackingProgress captures exact usage from the usage data part', () => {
    const forwarded: vscode.LanguageModelResponsePart[] = [];
    const delegate: vscode.Progress<vscode.LanguageModelResponsePart> = { report: p => forwarded.push(p) };
    const progress = new TokenTrackingProgress(delegate, () => { });

    const usage = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 5 },
    };
    progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(usage)), 'usage'));
    assert.deepEqual(progress.exactUsage, usage);
    assert.equal(forwarded.length, 1);
    assert.ok(forwarded[0] instanceof vscode.LanguageModelDataPart);
});

test('TokenTrackingProgress ignores malformed usage parts', () => {
    const forwarded: vscode.LanguageModelResponsePart[] = [];
    const delegate: vscode.Progress<vscode.LanguageModelResponsePart> = { report: p => forwarded.push(p) };
    const progress = new TokenTrackingProgress(delegate, () => { });

    progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode('not json'), 'usage'));
    progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode('{"prompt_tokens":"x"}'), 'usage'));
    assert.equal(progress.exactUsage, undefined);
    assert.equal(forwarded.length, 2); // still forwarded verbatim
});

test('isNikaUsagePayload validates shapes', () => {
    assert.equal(isNikaUsagePayload({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }), true);
    assert.equal(isNikaUsagePayload({ prompt_tokens: 1, completion_tokens: 2 }), false);
    assert.equal(isNikaUsagePayload(null), false);
    assert.equal(isNikaUsagePayload('usage'), false);
});

test('toUtcDateKey formats UTC YYYY-MM-DD', () => {
    assert.equal(toUtcDateKey(Date.UTC(2026, 7, 16, 23, 59, 59)), '2026-08-16');
    assert.equal(toUtcDateKey(Date.UTC(2026, 0, 5, 0, 0, 1)), '2026-01-05');
});
