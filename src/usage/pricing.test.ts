import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isDeepSeekPeakHour,
    getDeepSeekRatePeriod,
    formatDuration,
    deepSeekPricingKey,
    getDeepSeekTokenCost,
    formatCost,
    formatTokenCount,
} from './pricing.js';

test('isDeepSeekPeakHour: peak windows 01:00–04:00 and 06:00–10:00 UTC, half-open boundaries', () => {
    assert.equal(isDeepSeekPeakHour(new Date('2026-08-16T00:59:59Z')), false);
    assert.equal(isDeepSeekPeakHour(new Date('2026-08-16T01:00:00Z')), true);
    assert.equal(isDeepSeekPeakHour(new Date('2026-08-16T03:59:59Z')), true);
    assert.equal(isDeepSeekPeakHour(new Date('2026-08-16T04:00:00Z')), false);
    assert.equal(isDeepSeekPeakHour(new Date('2026-08-16T05:59:59Z')), false);
    assert.equal(isDeepSeekPeakHour(new Date('2026-08-16T06:00:00Z')), true);
    assert.equal(isDeepSeekPeakHour(new Date('2026-08-16T09:59:59Z')), true);
    assert.equal(isDeepSeekPeakHour(new Date('2026-08-16T10:00:00Z')), false);
    assert.equal(isDeepSeekPeakHour(new Date('2026-08-16T23:59:59Z')), false);
});

test('getDeepSeekRatePeriod: inside a peak window ends at window end', () => {
    const date = new Date('2026-08-16T02:00:00Z');
    const period = getDeepSeekRatePeriod(date);
    assert.equal(period.peak, true);
    assert.equal(period.nextIsPeak, false);
    const dayStart = Date.UTC(2026, 7, 16); // 2026-08-16T00:00:00Z
    assert.equal(period.endsAt, dayStart + 4 * 60 * 60_000);
});

test('getDeepSeekRatePeriod: off-peak before first peak window ends at 01:00', () => {
    const date = new Date('2026-08-16T00:30:00Z');
    const period = getDeepSeekRatePeriod(date);
    assert.equal(period.peak, false);
    assert.equal(period.nextIsPeak, true);
    const dayStart = Date.UTC(2026, 7, 16);
    assert.equal(period.endsAt, dayStart + 1 * 60 * 60_000);
});

test('getDeepSeekRatePeriod: off-peak after last window ends at next day 01:00', () => {
    const date = new Date('2026-08-16T23:00:00Z');
    const period = getDeepSeekRatePeriod(date);
    assert.equal(period.peak, false);
    assert.equal(period.nextIsPeak, true);
    const dayStart = Date.UTC(2026, 7, 16);
    assert.equal(period.endsAt, dayStart + 24 * 60 * 60_000 + 1 * 60 * 60_000);
});

test('formatDuration', () => {
    assert.equal(formatDuration(30_000), '<1m');
    assert.equal(formatDuration(60_000), '1m');
    assert.equal(formatDuration(600_000), '10m');
    assert.equal(formatDuration(3_600_000), '1h');
    assert.equal(formatDuration(5_000_000), '1h 23m');
    assert.equal(formatDuration(-5_000), '<1m'); // negative → clamped
});

test('deepSeekPricingKey: strips -responses, rejects non-DeepSeek ids', () => {
    assert.equal(deepSeekPricingKey('deepseek-v4-flash'), 'deepseek-v4-flash');
    assert.equal(deepSeekPricingKey('deepseek-v4-pro-responses'), 'deepseek-v4-pro');
    assert.equal(deepSeekPricingKey('deepseek-v4-flash-responses'), 'deepseek-v4-flash');
    assert.equal(deepSeekPricingKey('gemini-2.5-flash'), undefined);
    assert.equal(deepSeekPricingKey('gemma4:31b'), undefined);
});

test('getDeepSeekTokenCost: flash peak example from the reference spec', () => {
    const breakdown = getDeepSeekTokenCost(
        'deepseek-v4-flash',
        { inputTokens: 100_000, outputTokens: 50_000, cachedTokens: 40_000 },
        new Date('2026-08-16T02:00:00Z') // peak
    );
    assert.ok(breakdown);
    assert.equal(breakdown.peak, true);
    assert.equal(breakdown.cacheHitTokens, 40_000);
    assert.equal(breakdown.cacheMissTokens, 60_000);
    assert.equal(breakdown.outputTokens, 50_000);
    // 0.04M*0.014 + 0.06M*0.44 + 0.05M*1.32 = 0.00056 + 0.0264 + 0.066 = 0.09296
    assert.equal(breakdown.cost, 0.09296);
    assert.equal(breakdown.rateLabel, 'PEAK');
});

test('getDeepSeekTokenCost: off-peak is half price', () => {
    const breakdown = getDeepSeekTokenCost(
        'deepseek-v4-flash',
        { inputTokens: 100_000, outputTokens: 50_000, cachedTokens: 40_000 },
        new Date('2026-08-16T12:00:00Z') // off-peak
    );
    assert.ok(breakdown);
    assert.equal(breakdown.peak, false);
    assert.equal(breakdown.cost, 0.09296 / 2);
    assert.equal(breakdown.rateLabel, 'OFF-PEAK');
});

test('getDeepSeekTokenCost: pro model prices', () => {
    const breakdown = getDeepSeekTokenCost(
        'deepseek-v4-pro-responses',
        { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0 },
        new Date('2026-08-16T02:00:00Z') // peak
    );
    assert.ok(breakdown);
    // 1M miss * 1.32 + 1M out * 3.96 = 5.28
    assert.equal(breakdown.cost, 5.28);
});

test('getDeepSeekTokenCost: clamps cached tokens to input tokens', () => {
    const breakdown = getDeepSeekTokenCost(
        'deepseek-v4-flash',
        { inputTokens: 1_000, outputTokens: 0, cachedTokens: 5_000 },
        new Date('2026-08-16T02:00:00Z')
    );
    assert.ok(breakdown);
    assert.equal(breakdown.cacheHitTokens, 1_000);
    assert.equal(breakdown.cacheMissTokens, 0);
});

test('getDeepSeekTokenCost: returns undefined for non-DeepSeek models', () => {
    assert.equal(
        getDeepSeekTokenCost('gemini-2.5-flash', { inputTokens: 10, outputTokens: 10, cachedTokens: 0 }),
        undefined
    );
});

test('formatCost', () => {
    assert.equal(formatCost(0), '$0');
    assert.equal(formatCost(-1), '$0');
    assert.equal(formatCost(0.00042), '$0.0004');
    assert.equal(formatCost(0.031), '$0.03');
    assert.equal(formatCost(0.01), '$0.01');
    assert.equal(formatCost(1.24), '$1.24');
    assert.equal(formatCost(123.45), '$123');
});

test('formatTokenCount', () => {
    assert.equal(formatTokenCount(0), '0');
    assert.equal(formatTokenCount(999), '999');
    assert.equal(formatTokenCount(1200), '1.2k');
    assert.equal(formatTokenCount(34_000), '34k');
    assert.equal(formatTokenCount(1_400_000), '1.4M');
});
