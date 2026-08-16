import * as vscode from 'vscode';
import { formatCost, formatDuration, formatTokenCount, getDeepSeekRatePeriod } from './pricing.js';
import { NikaUsageTracker, toUtcDateKey } from './tracker.js';
import type { NikaDailySummary } from './tracker.js';

const PANEL_VIEW_TYPE = 'nika.usagePanel';
const PANEL_ID = 'nika.usagePanel';

/** How many days the chart / summaries cover. */
const DAILY_DAYS = 14;

let _panel: UsagePanel | undefined;

/**
 * A rich, GitHub-status-panel-style usage dashboard rendered as a webview
 * panel. Shows today's KPIs, the current DeepSeek rate period, an SVG bar
 * chart of the last 14 days, and session / workspace / request breakdowns.
 *
 * Stands in for the reference project's Nika Settings "Usage" section, but as
 * a popup panel instead of a settings webview.
 */
export class UsagePanel {
	private readonly _panel: vscode.WebviewPanel;
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _tracker: NikaUsageTracker;
	private _disposed = false;

	constructor(
		tracker: NikaUsageTracker,
		column: vscode.ViewColumn,
	) {		this._tracker = tracker;
		this._panel = vscode.window.createWebviewPanel(
			PANEL_VIEW_TYPE,
			'Nika Usage',
			column,
			{
				enableScripts: true,
				enableCommandUris: false,
				retainContextWhenHidden: true,
				localResourceRoots: [],
			}
		);
		this._panel.iconPath = vscode.Uri.joinPath(
			vscode.extensions.getExtension('nika.nika')?.extensionUri
				?? vscode.Uri.file(''),
			'logo.png'
		);

		this._disposables.push(
			this._panel.onDidDispose(() => {
				this._disposed = true;
				this._dispose();
			}),
			this._panel.webview.onDidReceiveMessage(async (message) => {
				if (message?.type === 'clear') {
					this._tracker.clear();
					this._render();
				} else if (message?.type === 'refresh') {
					this._render();
				}
			}),
			this._tracker.onDidChange(() => this._scheduleRender()),
		);

		this._render();
	}

	/** Debounce rapid live-stream updates so the webview isn't re-rendered hot. */
	private _renderTimer: ReturnType<typeof setTimeout> | undefined;
	private _scheduleRender(): void {
		if (this._disposed) {
			return;
		}
		if (this._renderTimer) {
			return;
		}
		this._renderTimer = setTimeout(() => {
			this._renderTimer = undefined;
			this._render();
		}, 300);
	}

	reveal(): void {
		this._panel.reveal(undefined, true);
	}

	/** Re-render with the latest ledger data. */
	private _render(): void {
		if (this._disposed) {
			return;
		}
		this._panel.webview.html = this._buildHtml();
	}

	private _buildHtml(): string {
		const nonce = getNonce();
		const daily = this._tracker.getDailySummary(DAILY_DAYS);
		const sessions = this._tracker.getSessionSummaries(10);
		const workspaces = this._tracker.getWorkspaceSummaries();
		const history = this._tracker.getMessageHistory(10);
		const rate = getDeepSeekRatePeriod();

		// KPIs
		const todayKey = toUtcDateKey(Date.now());
		let todayTokens = 0;
		let todayCost = 0;
		let totalTokens = 0;
		let totalCost = 0;
		let totalRequests = 0;
		for (const d of daily) {
			totalTokens += d.totalTokens;
			totalCost += d.cost;
			totalRequests += d.requests;
			if (d.date === todayKey) {
				todayTokens = d.totalTokens;
				todayCost = d.cost;
			}
		}

		const rateLabel = rate.peak ? 'PEAK' : 'OFF-PEAK';
		const countdown = formatDuration(rate.endsAt - Date.now());
		const rateDesc = rate.peak
			? `${countdown} left`
			: `${countdown} to PEAK`;

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${this._panel.webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nika Usage</title>
<style>
	:root {
		color-scheme: light dark;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 16px 20px;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size, 13px);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
	}
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}
	.title {
		font-size: 15px;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.title-icon {
		flex-shrink: 0;
		opacity: 0.9;
	}
	.failed {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--vscode-inputValidation-warningForeground, #e2c08d);
	}
	.failed svg {
		flex-shrink: 0;
	}
	.badge {
		font-size: 11px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 10px;
	}
	.badge.peak { background: var(--vscode-inputValidation-warningBackground, #5a2d0c); color: var(--vscode-inputValidation-warningForeground, #e2c08d); }
	.badge.offpeak { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.kpis {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
		margin-bottom: 20px;
	}
	.kpi {
		border: 1px solid var(--vscode-panel-border, #3c3c3c);
		border-radius: 6px;
		padding: 10px 12px;
		background: var(--vscode-editorWidget-background, #252526);
	}
	.kpi .value { font-size: 18px; font-weight: 600; }
	.kpi .label { font-size: 11px; opacity: 0.8; margin-top: 2px; }
	.section-title {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		opacity: 0.8;
		margin: 18px 0 8px;
	}
	.chart-wrap {
		border: 1px solid var(--vscode-panel-border, #3c3c3c);
		border-radius: 6px;
		background: var(--vscode-editorWidget-background, #252526);
		padding: 12px;
		overflow-x: auto;
	}
	table { width: 100%; border-collapse: collapse; font-size: 12px; }
	th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); white-space: nowrap; }
	th { opacity: 0.7; font-weight: 600; }
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
	.empty { opacity: 0.6; padding: 8px 0; }
	.btn-row { margin-top: 16px; display: flex; gap: 8px; }
	button {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none;
		padding: 5px 12px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
	.note { opacity: 0.6; font-size: 11px; margin-top: 12px; }
</style>
</head>
<body>
	<div class="header">
		<div class="title">
			<svg class="title-icon" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
				<rect x="1" y="9" width="2.5" height="6" rx="1" fill="currentColor"/>
				<rect x="4.5" y="6" width="2.5" height="9" rx="1" fill="currentColor"/>
				<rect x="8" y="3" width="2.5" height="12" rx="1" fill="currentColor"/>
				<rect x="11.5" y="7" width="2.5" height="8" rx="1" fill="currentColor"/>
			</svg>
			Nika DeepSeek Usage
		</div>
		<span class="badge ${rate.peak ? 'peak' : 'offpeak'}">${rateLabel} · ${rateDesc}</span>
	</div>

	<div class="kpis">
		<div class="kpi">
			<div class="value">${formatTokenCount(todayTokens)}</div>
			<div class="label">tokens today · ${formatCost(todayCost)}</div>
		</div>
		<div class="kpi">
			<div class="value">${formatTokenCount(totalTokens)}</div>
			<div class="label">tokens last ${DAILY_DAYS} days · ${formatCost(totalCost)}</div>
		</div>
		<div class="kpi">
			<div class="value">${totalRequests}</div>
			<div class="label">requests last ${DAILY_DAYS} days</div>
		</div>
	</div>

	<div class="section-title">Daily usage (last ${DAILY_DAYS} days)</div>
	<div class="chart-wrap">
		${daily.length === 0
			? '<div class="empty">No usage recorded yet — send a chat with a DeepSeek model to start tracking.</div>'
			: renderSvgChart(daily, todayKey)}
	</div>

	<div class="section-title">Sessions</div>
	${renderSessions(sessions)}

	<div class="section-title">Workspaces</div>
	${renderWorkspaces(workspaces)}

	<div class="section-title">Recent requests</div>
	${renderHistory(history)}

	<div class="btn-row">
		<button id="clearBtn" class="secondary">Clear usage data</button>
		<button id="refreshBtn" class="secondary">Refresh</button>
	</div>
	<div class="note">All data is stored locally in VS Code global storage — nothing is sent to any server.</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	document.getElementById('clearBtn').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
	document.getElementById('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
</script>
</body>
</html>`;
	}

	private _dispose(): void {
		this._renderTimer && clearTimeout(this._renderTimer);
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables.length = 0;
	}
}

/**
 * Open (or focus) the Nika usage dashboard panel. Opens SIDE-BY-SIDE with
 * the active editor (`ViewColumn.Beside`) so the dashboard shares the screen
 * instead of taking over as a full new page.
 */
export function showUsagePanel(tracker: NikaUsageTracker): void {
	if (_panel && !_panel['_disposed']) {
		_panel.reveal();
		return;
	}
	// Split-view: put the dashboard in the column beside the active editor.
	// Falls back to the active column when no editor is open.
	const column = vscode.window.activeTextEditor
		? vscode.ViewColumn.Beside
		: vscode.ViewColumn.Active;
	_panel = new UsagePanel(tracker, column);
}

/**
 * Render the last-14-days token usage as an inline SVG bar chart.
 * Uses the same day keys as the tracker's daily aggregation (UTC).
 */
function renderSvgChart(daily: NikaDailySummary[], todayKey: string): string {
	const days = lastUtcDays(DAILY_DAYS);
	const max = Math.max(1, ...days.map(k => daily.find(d => d.date === k)?.totalTokens ?? 0));

	const barWidth = 34;
	const barGap = 8;
	const chartWidth = days.length * (barWidth + barGap) + barGap;
	const chartHeight = 150;
	const labelHeight = 20;
	const plotHeight = chartHeight - labelHeight;

	const rows = days.map((key, i) => {
		const summary = daily.find(d => d.date === key);
		const tokens = summary?.totalTokens ?? 0;
		const barHeight = Math.max(1, Math.round((tokens / max) * plotHeight));
		const x = barGap + i * (barWidth + barGap);
		const y = plotHeight - barHeight;
		const isToday = key === todayKey;
		const fill = isToday
			? 'var(--vscode-charts-blue, #3794ff)'
			: 'var(--vscode-charts-foreground, #888)';
		const label = key.slice(5).replace('-', '/'); // MM-DD → MM/DD
		const title = summary
			? `${label}: ${formatTokenCount(tokens)} tok · ${formatCost(summary.cost)}`
			: `${label}: no usage`;
		return `
			<g>
				<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="${fill}">
					<title>${title}</title>
				</rect>
				<text x="${x + barWidth / 2}" y="${chartHeight - 5}" text-anchor="middle" font-size="9" fill="var(--vscode-descriptionForeground, #999)">${label}</text>
			</g>`;
	}).join('');

	return `
	<svg width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Daily token usage bar chart">
		${rows}
	</svg>`;
}

function renderSessions(sessions: { title?: string; sessionId: string; workspace?: string; requests: number; totalTokens: number; cost: number }[]): string {
	if (sessions.length === 0) {
		return '<div class="empty">No sessions yet.</div>';
	}
	const rows = sessions.map(s => `
		<tr>
			<td>${escapeHtml(s.title?.slice(0, 60) || s.sessionId.slice(0, 60))}</td>
			<td>${escapeHtml(s.workspace ?? '—')}</td>
			<td class="num">${s.requests}</td>
			<td class="num">${formatTokenCount(s.totalTokens)}</td>
			<td class="num">${formatCost(s.cost)}</td>
		</tr>`).join('');
	return `<table>
		<thead><tr><th>Session</th><th>Workspace</th><th class="num">Req</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
		<tbody>${rows}</tbody>
	</table>`;
}

function renderWorkspaces(workspaces: { workspace: string; sessions: number; requests: number; totalTokens: number; cost: number }[]): string {
	if (workspaces.length === 0) {
		return '<div class="empty">No workspaces yet.</div>';
	}
	const rows = workspaces.map(w => `
		<tr>
			<td>${escapeHtml(w.workspace)}</td>
			<td class="num">${w.sessions}</td>
			<td class="num">${w.requests}</td>
			<td class="num">${formatTokenCount(w.totalTokens)}</td>
			<td class="num">${formatCost(w.cost)}</td>
		</tr>`).join('');
	return `<table>
		<thead><tr><th>Workspace</th><th class="num">Sessions</th><th class="num">Req</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
		<tbody>${rows}</tbody>
	</table>`;
}

function renderHistory(history: { model: string; promptTokens: number; completionTokens: number; totalTokens: number; cost: number; error?: boolean }[]): string {
	if (history.length === 0) {
		return '<div class="empty">No requests yet.</div>';
	}
	const rows = history.map(h => `
		<tr>
			<td>${escapeHtml(h.model)}</td>
			<td class="num">${formatTokenCount(h.promptTokens)}</td>
			<td class="num">${formatTokenCount(h.completionTokens)}</td>
			<td class="num">${formatTokenCount(h.totalTokens)}</td>
			<td class="num">${h.error ? '<span class="failed"><svg width="11" height="11" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 1.5L15.5 14h-15L8 1.5zm0 4.2L3.4 12.7h9.2L8 5.7z"/><rect x="7.2" y="7" width="1.6" height="3.5" fill="currentColor"/><rect x="7.2" y="11.2" width="1.6" height="1.6" fill="currentColor"/></svg>failed</span>' : formatCost(h.cost)}</td>
		</tr>`).join('');
	return `<table>
		<thead><tr><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Total</th><th class="num">Cost</th></tr></thead>
		<tbody>${rows}</tbody>
	</table>`;
}

/** The last `count` UTC days as `YYYY-MM-DD` keys, oldest → newest. */
function lastUtcDays(count: number): string[] {
	const keys: string[] = [];
	const now = new Date();
	for (let i = count - 1; i >= 0; i--) {
		keys.push(toUtcDateKey(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)));
	}
	return keys;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
