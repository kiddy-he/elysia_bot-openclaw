import { onebotPath } from '../paths.js';
import { readFileSync } from 'node:fs';
export function deliverySettings() {
    const value = JSON.parse(readFileSync(onebotPath('onebot-delivery.json'), 'utf8'));
    const keys = ['version', 'minAccountGapMs', 'minTargetGapMs', 'maxInFlight', 'artifactRetentionDays', 'defaultTtlMs'];
    if (value.version !== 1 || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Number.isInteger(value[key]))) throw new Error('invalid delivery settings');
    if (value.minAccountGapMs < 0 || value.minAccountGapMs > 10000 || value.minTargetGapMs < 0 || value.minTargetGapMs > 30000
        || value.maxInFlight < 1 || value.maxInFlight > 4 || value.artifactRetentionDays < 1 || value.artifactRetentionDays > 365 || value.defaultTtlMs < 60000 || value.defaultTtlMs > 7 * 86400000) throw new Error('delivery setting outside bounds');
    return value;
}
export class DeliveryLimiter {
    constructor(settings = deliverySettings) { this.settings = settings; this.lanes = new Map(); this.accountNext = new Map(); this.targetNext = new Map(); this.running = 0; this.waiters = []; }
    async run(accountId, target, send) {
        const key = `${accountId}:${target}`, previous = this.lanes.get(key) ?? Promise.resolve();
        const work = previous.catch(() => {}).then(async () => {
            const config = this.settings();
            if (this.running >= config.maxInFlight) await new Promise(resolve => this.waiters.push(resolve));
            else this.running++;
            try {
                const time = Math.max(Date.now(), this.accountNext.get(accountId) ?? 0, this.targetNext.get(key) ?? 0);
                this.accountNext.set(accountId, time + config.minAccountGapMs); this.targetNext.set(key, time + config.minTargetGapMs);
                if (time > Date.now()) await new Promise(resolve => setTimeout(resolve, time - Date.now()));
                return await send();
            } finally { const next = this.waiters.shift(); if (next) next(); else this.running--; }
        });
        this.lanes.set(key, work);
        try { return await work; } finally { if (this.lanes.get(key) === work) this.lanes.delete(key); }
    }
}
export const deliveryLimiter = new DeliveryLimiter();
