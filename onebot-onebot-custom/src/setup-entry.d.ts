import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { onebotPlugin } from "./src/channel.js";
declare const setupEntry: {
    id: string;
    name: string;
    description: string;
    configSchema: NonNullable<typeof onebotPlugin.configSchema>;
    register: (api: OpenClawPluginApi) => void;
    channelPlugin: typeof onebotPlugin;
};
export default setupEntry;
