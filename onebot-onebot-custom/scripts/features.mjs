import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { authorizeFeature, configuredAllowFrom, configuredRoleGroups, FEATURE_ACTIONS, loadFeatureConfig } from "../src/src/feature-policy.js";

const root = join(process.env.HOME ?? "/root", ".openclaw");
const command = process.argv[2] ?? "check";
const config = loadFeatureConfig();
const read = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
if (command === "check" || command === "sync") {
    const routing = read("onebot-role-routing.json");
    const core = read("openclaw.json");
    const drift = [];
    if (JSON.stringify(routing.groups) !== JSON.stringify(configuredRoleGroups(config))) drift.push("role groups");
    if (JSON.stringify(routing.adminIds) !== JSON.stringify(config.identities.adminIds)) drift.push("role admin IDs");
    for (const [accountId, account] of Object.entries(config.accounts)) {
        const channel = accountId === "default" ? core.channels.onebot : core.channels.onebot.accounts?.[accountId];
        if (!channel) throw new Error(`Unknown OneBot account ${accountId}`);
        if (JSON.stringify(channel.allowFrom) !== JSON.stringify(configuredAllowFrom(accountId, config))) drift.push(`${accountId} channel allowFrom`);
        for (const groupId of account.groupIds) {
            const roles = config.groups[groupId].roles.map((id) => routing.roles[id]);
            if (roles.some((role) => !role)) throw new Error(`Unknown role in group ${groupId}`);
        }
    }
    for (const [groupId, group] of Object.entries(config.groups)) {
        for (const roleId of group.roles) {
            const role = routing.roles[roleId];
            if (!role || !config.accounts[role.accountId]?.groupIds.includes(groupId)) throw new Error(`Role/account not allowed in group ${groupId}: ${roleId}`);
        }
    }
    const jobs = JSON.parse(execFileSync("openclaw", ["cron", "list", "--all", "--json"], { encoding: "utf8", timeout: 30000 }));
    const cronChanges = [];
    for (const [id, binding] of Object.entries(config.automationBindings)) {
        const job = jobs.jobs.find((job) => job.id === id);
        if (!job) throw new Error(`Missing declared automation ${binding.name}; inspect before synchronization`);
        const feature = config.features[binding.feature];
        const enabled = binding.enabled && feature.enabled && binding.deliveryGroupIds.every((id) => config.groups[id]?.enabled && feature.groupIds.includes(id));
        const actualTarget = String(job.delivery?.to ?? "").replace(/^onebot:/u, "");
        if (actualTarget.startsWith("group:") && !binding.deliveryGroupIds.includes(actualTarget.slice(6))) throw new Error(`Undeclared delivery destination for ${binding.name}`);
        if (job.enabled !== enabled) cronChanges.push({ id, name: binding.name, enabled });
    }
    if (command === "sync" && (drift.length || cronChanges.length)) {
        const backup = join(root, "state", "backups", `feature-config-sync-${Date.now()}`);
        mkdirSync(backup, { recursive: true, mode: 0o700 });
        writeFileSync(join(backup, "automation-snapshot.json"), `${JSON.stringify(jobs, null, 2)}\n`, { mode: 0o600 });
        const write = (name, value) => {
            copyFileSync(join(root, name), join(backup, name));
            chmodSync(join(backup, name), 0o600);
            const temp = join(root, `${name}.${process.pid}.tmp`);
            writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
            renameSync(temp, join(root, name));
        };
        routing.groups = configuredRoleGroups(config);
        routing.adminIds = [...config.identities.adminIds];
        for (const accountId of Object.keys(config.accounts)) {
            const channel = accountId === "default" ? core.channels.onebot : core.channels.onebot.accounts[accountId];
            channel.allowFrom = configuredAllowFrom(accountId, config);
        }
        write("onebot-role-routing.json", routing);
        write("openclaw.json", core);
        for (const change of cronChanges)
            execFileSync("openclaw", ["cron", change.enabled ? "enable" : "disable", change.id], { encoding: "utf8", timeout: 30000 });
        console.log(JSON.stringify({ valid: true, synchronized: drift, automations: cronChanges, backup, note: "Channel allowlist changes may require Gateway reload/restart" }));
    }
    else {
        console.log(JSON.stringify({ valid: true, features: Object.keys(config.features).length, groups: Object.keys(config.groups), accounts: Object.keys(config.accounts), compatibilityDrift: drift, automationChanges: cronChanges }));
        if (drift.length || cronChanges.length) process.exitCode = 1;
    }
}
else if (command === "matrix") {
    const rows = [];
    for (const scope of ["private", "group"]) {
        for (const [accountId, account] of Object.entries(config.accounts)) {
            for (const groupId of scope === "group" ? account.groupIds : [undefined]) {
                for (const senderId of [config.identities.adminIds[0], "0"]) {
                    const context = { scope, groupId, accountId, senderId, explicit: true, roleCount: 1 };
                    const allowed = Object.entries(FEATURE_ACTIONS).flatMap(([id, actions]) => actions.filter((action) => authorizeFeature(config, id, action, context).allowed).map((action) => `${id}.${action}`));
                    rows.push({ scope, groupId, accountId, identity: senderId === "0" ? scope === "group" ? "member" : "visitor" : "admin", allowed });
                }
            }
        }
    }
    console.log(JSON.stringify(rows, null, 2));
}
else throw new Error("Use features.mjs check|sync|matrix");
