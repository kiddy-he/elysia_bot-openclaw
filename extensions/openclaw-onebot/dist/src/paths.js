import { join } from 'node:path';
import { homedir } from 'node:os';
// A separate root permits full integration simulations without touching live
// identities, sessions, modes, approvals, artifacts or business receipts.
export const onebotRoot = process.env.ONEBOT_CONFIG_ROOT || join(homedir(), '.openclaw');
export const onebotPath = (...parts) => join(onebotRoot, ...parts);
