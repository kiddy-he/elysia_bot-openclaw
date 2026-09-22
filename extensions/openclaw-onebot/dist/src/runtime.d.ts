import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
export declare const setOneBotRuntime: (next: PluginRuntime) => void;
export declare const clearOneBotRuntime: () => void;
export declare const tryGetOneBotRuntime: () => PluginRuntime | null;
export declare const getOneBotRuntime: () => PluginRuntime;
