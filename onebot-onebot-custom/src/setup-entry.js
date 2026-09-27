import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { onebotPlugin } from "./src/channel.js";
const setupEntry = defineChannelPluginEntry({
    id: "openclaw-onebot",
    name: "OneBot",
    description: "OneBot 11 channel plugin (NapCat/go-cqhttp)",
    plugin: onebotPlugin,
});
export default setupEntry;
