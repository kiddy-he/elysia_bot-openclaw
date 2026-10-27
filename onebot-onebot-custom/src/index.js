import { registerScheduledConversationContext } from './src/destination-context.js';
import { registerConversationTranscriptHooks } from './src/conversation-transcript.js';
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { onebotPlugin } from "./src/channel.js";
import { setOneBotRuntime } from "./src/runtime.js";
import { registerFeatureToolGuard, registerFeatureOutboundGuard } from "./src/feature-tools.js";
import { registerBusinessTools } from "./src/features/tools.js";
import { registerDeliveryRecovery } from "./src/delivery/queue.js";
import { registerBilibiliWebhook } from "./src/features/bilibili.js";
import { registerScriptDelivery } from "./src/delivery/ingress.js";
import { registerTaskProgressHooks } from "./src/task-progress.js";
import { registerServiceSpeechHooks } from './src/features/speech-hooks.js';
import { registerReminderService } from './src/features/reminders.js';
import { startXhsService, stopXhsService } from './src/features/xhs.js';
const entry = defineChannelPluginEntry({
    id: "openclaw-onebot",
    name: "OneBot",
    description: "OneBot 11 channel plugin (NapCat/go-cqhttp)",
    plugin: onebotPlugin,
    setRuntime: setOneBotRuntime,
    registerFull: (api) => {
        registerConversationTranscriptHooks(api);
        registerScheduledConversationContext(api);
        registerFeatureToolGuard(api);
        registerFeatureOutboundGuard(api);
        registerTaskProgressHooks(api);
        registerServiceSpeechHooks(api);
        registerBusinessTools(api);
        registerDeliveryRecovery(api);
        registerReminderService(api);
        api.registerService({ id: 'onebot-xiaohongshu', start: startXhsService, stop: stopXhsService });
        registerBilibiliWebhook(api);
        registerScriptDelivery(api);
    },
});
export default entry;
export { onebotPlugin } from "./src/channel.js";
export { setOneBotRuntime, clearOneBotRuntime, getOneBotRuntime, tryGetOneBotRuntime } from "./src/runtime.js";
export * from "./src/types.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
