import * as vscode from 'vscode';
import { formatCost, formatDuration, formatTokenCount, getDeepSeekRatePeriod } from './pricing.js';
import { NikaUsageTracker } from './tracker.js';

const usageStatusBarItemId = 'nika.usageStatus';

/**
 * Status bar item for Nika DeepSeek token usage. While a response streams it
 * shows a live token counter; when idle it shows today's totals plus the
 * current DeepSeek rate period (PEAK / OFF-PEAK). Clicking opens the Nika
 * Usage dashboard panel (`nika.showUsage`).
 *
 * Ported from alive2/nika-code v1.3.0 `nikaUsageStatus.ts` (MIT), with the
 * dashboard-open click wired to the usage webview panel.
 */
export class NikaUsageStatus {
	/**
	 * Live token counters update on every streamed chunk. Coalesce renders so
	 * the stable `showProgress` spinner keeps spinning smoothly.
	 */
	private static readonly UPDATE_THROTTLE_MS = 250;
	/** How often the idle rate-period countdown refreshes. */
	private static readonly COUNTDOWN_REFRESH_MS = 30_000;

	private readonly _statusItem: vscode.StatusBarItem;

	private _lastRender = 0;
	private _lastText = '';
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _countdownTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly _usageTracker: NikaUsageTracker,
	) {
		this._statusItem = vscode.window.createStatusBarItem(usageStatusBarItemId, vscode.StatusBarAlignment.Right, 99);
		this._statusItem.name = 'Nika Usage';
		this._statusItem.command = 'nika.showUsage';

		this._usageTracker.onDidChange(() => this._scheduleUpdate());
		// Keep the idle rate-period countdown fresh even when no events change.
		this._countdownTimer = setInterval(() => this._scheduleUpdate(), NikaUsageStatus.COUNTDOWN_REFRESH_MS);
		this._scheduleUpdate();
	}

	dispose(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		if (this._countdownTimer) {
			clearInterval(this._countdownTimer);
			this._countdownTimer = undefined;
		}
		this._statusItem.dispose();
	}

	private _scheduleUpdate(): void {
		if (this._timer) {
			// A render is already pending; coalesce this change into it.
			return;
		}
		const delay = Math.max(0, NikaUsageStatus.UPDATE_THROTTLE_MS - (Date.now() - this._lastRender));
		this._timer = setTimeout(() => {
			this._timer = undefined;
			this._render();
		}, delay);
	}

	private _render(): void {
		this._lastRender = Date.now();
		try {
			if (!this._usageTracker.enabled) {
				this._statusItem.hide();
				return;
			}

			const liveCount = this._usageTracker.liveStreamCount;
			if (liveCount > 0) {
				const estimate = this._usageTracker.liveTokenEstimate;
				// `$(sync~spin)` renders a spinning codicon that stays animated
				// across text updates (this API version has no `showProgress`).
				this._setText(`$(sync~spin) Nika ${formatTokenCount(estimate)} tok`);
				this._statusItem.tooltip = `Nika tokens streaming (${liveCount} active request${liveCount === 1 ? '' : 's'})...`;
				this._statusItem.show();
				return;
			}

			const totals = todayTotals(this._usageTracker);
			const rate = getDeepSeekRatePeriod();
			const countdown = formatDuration(rate.endsAt - Date.now());
			const rateLabel = rate.peak
				? `PEAK · ${countdown} left`
				: `OFF-PEAK · ${countdown} to PEAK`;
			this._setText(`$(pulse) Nika today ${formatTokenCount(totals.totalTokens)} tok · ${formatCost(totals.cost)} · ${rateLabel}`);
			this._statusItem.tooltip = 'Nika DeepSeek token usage. Click for usage options.';
			this._statusItem.show();
		} catch {
			this._statusItem.hide();
		}
	}

	private _setText(text: string): void {
		if (text !== this._lastText) {
			this._statusItem.text = text;
			this._lastText = text;
		}
	}
}

/**
 * Local-day totals for the status bar's idle state.
 */
function todayTotals(tracker: NikaUsageTracker): { totalTokens: number; cost: number; requests: number } {
	const now = new Date();
	let totalTokens = 0;
	let cost = 0;
	let requests = 0;
	for (const event of tracker.events) {
		const d = new Date(event.t);
		if (d.getFullYear() === now.getFullYear()
			&& d.getMonth() === now.getMonth()
			&& d.getDate() === now.getDate()) {
			totalTokens += event.totalTokens;
			cost += event.cost;
			requests += 1;
		}
	}
	return { totalTokens, cost, requests };
}

/**
 * The status bar click (`nika.showUsage`) opens the rich usage dashboard
 * directly, side-by-side with the active editor — see `showUsagePanel` in
 * `src/usage/panel.ts`. No intermediate popup/dialog is shown.
 */
