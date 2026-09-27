import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { onebotPlugin } from "./src/channel.js";
import { setOneBotRuntime } from "./src/runtime.js";
const entry = defineChannelPluginEntry({
    id: "openclaw-onebot",
    name: "OneBot",
    description: "OneBot 11 channel plugin (NapCat/go-cqhttp)",
    plugin: onebotPlugin,
    setRuntime: setOneBotRuntime,
});
export default entry;
export { onebotPlugin } from "./src/channel.js";
export { setOneBotRuntime, clearOneBotRuntime, getOneBotRuntime, tryGetOneBotRuntime } from "./src/runtime.js";
export * from "./src/types.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
