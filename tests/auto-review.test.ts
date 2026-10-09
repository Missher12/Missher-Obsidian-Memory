import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@mom/core';
import MissherMemoryPlugin from '../packages/plugin/src/plugin.js';
import { MemoryService } from '../packages/plugin/src/memory-service.js';
import { createFakeApp, FakeVault, requestUrlCalls, resetRequestUrlCalls } from './obsidian-stub.js';

async function setup() {
  const app = createFakeApp(new FakeVault());
  const settings = defaultSettings();
  settings.root = 'Brain';
  const service = new MemoryService({ app: app as never, memoryRoot: 'Brain', instanceId: 'auto-review-test', getSettings: () => settings });
  await service.load();
  const plugin = new MissherMemoryPlugin(app as never, {} as never);
  Object.assign(plugin, { service, momSettings: settings, refreshViews: async () => {} });
  // Exhaust model budgets: local maintenance must not need a model reservation.
  service.jobs.updateConfig({ maxCallsPerDay: 1, maxTokensPerDay: 1 });
  service.jobs.jobs.budget.calls = 1;
  service.jobs.jobs.budget.tokens = 1;
  return { plugin, service, settings };
}

afterEach(() => vi.useRealTimers());

describe('automatic local review uses the saved switch and no model budget', () => {
  it('disabled or paused scheduling creates no jobs; manual review remains available', async () => {
    const { plugin, service, settings } = await setup();
    settings.review.autoReview = false;
    await plugin.tickJobs();
    expect(service.jobs.jobs.snapshot.jobs).toHaveLength(0);
    expect(await plugin.runLocalReview()).toEqual([]);
    settings.review.autoReview = true;
    await service.jobs.setPaused(true, 'test');
    await plugin.tickJobs();
    expect(service.jobs.jobs.snapshot.jobs).toHaveLength(0);
  });

  it('due maintenance runs real review with exhausted model budget and never marks billable', async () => {
    resetRequestUrlCalls();
    const { plugin, service } = await setup();
    const review = vi.spyOn(plugin, 'runLocalReview');
    const before = structuredClone(service.jobs.jobs.snapshot.budget);
    await Promise.all([plugin.tickJobs(), plugin.tickJobs()]);
    const jobs = service.jobs.jobs.snapshot.jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.every(j => j.status === 'completed' && !j.billableRequestSent)).toBe(true);
    expect(jobs.every(j => j.error.includes('本地复盘建议'))).toBe(true);
    expect(review).toHaveBeenCalledTimes(2);
    expect(service.jobs.jobs.snapshot.budget).toEqual(before);
    expect(service.jobs.jobs.snapshot.reservations).toEqual({});
    expect(requestUrlCalls).toHaveLength(0);
    await plugin.tickJobs();
    expect(service.jobs.jobs.snapshot.jobs).toHaveLength(2);
  });

  it('new activity triggers one local idle review without a configured model', async () => {
    vi.useFakeTimers();
    const { plugin, service } = await setup();
    service.jobs.updateConfig({ dailyHours: 0, weeklyHours: 0, idleMinutes: 1 });
    await service.store.remember({ body: '合成新输入', sourceKind: 'user_explicit' });
    plugin.noticeActivity();
    await vi.advanceTimersByTimeAsync(61_000);
    await plugin.tickJobs();
    const jobs = service.jobs.jobs.snapshot.jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ trigger: 'idle', status: 'completed', billableRequestSent: false });
    await vi.advanceTimersByTimeAsync(120_000);
    await plugin.tickJobs();
    expect(service.jobs.jobs.snapshot.jobs).toHaveLength(1);
  });

  it('storage failures are reported as failed local jobs without model reservations', async () => {
    const { plugin, service } = await setup();
    vi.spyOn(service, 'load').mockRejectedValue(new Error('synthetic read failure'));
    const message = await plugin.runMaintenanceJob('periodic_daily', 'daily', 'test');
    expect(message).toContain('synthetic read failure');
    expect(service.jobs.jobs.snapshot.jobs[0]).toMatchObject({ status: 'failed', billableRequestSent: false });
    expect(service.jobs.jobs.snapshot.reservations).toEqual({});
  });
});
