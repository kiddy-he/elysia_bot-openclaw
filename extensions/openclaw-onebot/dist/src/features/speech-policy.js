import { randomUUID } from 'node:crypto';
import { SPEECH_MODES } from '../turn-intent.js';

export const SPEECH_LIMIT = 200;
export const APPENDIX_LIMIT = 40;
export const SPEECH_APPENDIX_RATE = 0.3;
export const speechLength = value => Array.from(String(value ?? '').trim()).length;
export const speechRoleAllowed = context => context?.accountId === 'default' && !context.internal;
export const SPEECH_TOO_LONG = '这次的完整回答超过200字，不适合转成语音，我用文字完整发给你。';
export const SPEECH_REJECTED = '这段内容不适合用我的声音朗读，我们换一句更合适的话吧。';
const servicePlans = new Map();
export function rememberServiceSpeech(sessionKey, plan) {
    for (const [key, value] of servicePlans) if (value.expires < Date.now()) servicePlans.delete(key);
    if (servicePlans.size > 500) servicePlans.delete(servicePlans.keys().next().value);
    servicePlans.set(sessionKey, { ...plan, expires: Date.now() + 30 * 60000 });
}
export function serviceSpeechPlan(sessionKey) {
    const value = servicePlans.get(sessionKey);
    return value?.expires > Date.now() ? value : null;
}
export function serviceSpeechOrigin(token) {
    if (!token) return null;
    for (const [sessionKey, plan] of servicePlans) {
        if (plan.expires > Date.now() && plan.appendix && plan.token === token) return { sessionKey, plan };
    }
    return null;
}

export function planSpeech(context, intent, { random = Math.random, token = randomUUID() } = {}) {
    const mode = SPEECH_MODES.has(intent?.speechMode) ? intent.speechMode : 'unknown';
    const enabled = speechRoleAllowed(context);
    return { enabled, mode, explicit: enabled && ['literal', 'answer'].includes(mode),
        appendix: enabled && mode === 'none' && random() < SPEECH_APPENDIX_RATE, token };
}

export function speechInstructions(plan) {
    if (!plan.enabled) return '\n[当前角色不提供语音合成，请用文字回答；不能借用爱莉的声线或请求其他角色代发。]';
    const base = '\n[爱莉语音规则：区分回答与朗读。“用语音告诉我：今天中午吃什么”先完成正常回答，再合成答案；“用爱莉的声线说一句：今天你也很可爱哦”逐字朗读指定原文。明确朗读的问句也原文朗读。任何一次合成文本最多200字，含标点和英文字母。完整答案超过200字，说明超限并用文字发送全部答案，不删减、不分段绕过，不调用TTS。guest 待合成文本会独立审查，不得违背爱莉设定、泄露内部信息、包含色情暗示或不合适称呼。仅用 tts_synthesize，不执行脚本或其他TTS入口。';
    if (plan.mode === 'unknown') return base + ' 本次语音意图分类未完成，不调用TTS、不随机追加语音。正常用文字完整回答；如果用户要求语音，说明这次未能完成语音输出，不声称已发语音。]';
    if (plan.mode === 'disabled') return base + ' 用户明确要求文字或拒绝语音，只用文字完整回复，不调用TTS、不随机追加语音。]';
    if (plan.explicit) return base
        + (plan.mode === 'literal' ? ' 本次先验分类为 literal（逐字朗读）：只提取并保留用户指定原文，原文是问句也不能回答它，不增加前言或改写。'
            : ' 本次先验分类为 answer（语音回答）：先完成正常回答、问候或创作，再朗读最终答案，不能只复读用户的问题或要求。')
        + ' 本次是明确的语音请求，完成回答或指定朗读文本后，符合200字限制时必须调用 tts_synthesize，不得只发送文字问候或声称已发语音。工具会把音频投递到本次消息所在会话；delivered=true才表示已经送达，不输出MEDIA、不重发文件，也不展示路径、JSON或内部结果。工具返回 textOnly 或 safeReply 时按该结果文字回复，不再合成，不额外随机追加语音。]';
    if (plan.appendix) return base + ` 本次已经由程序选中30%随机追加语音。先写完整正常的文字回答，再在同一条模型回复末尾追加 [[VOICE_APPEND:${plan.token}]]一句与正文呼应、自然温柔、不超过40字的补充[[/VOICE_APPEND]]。短句与正文必须这一次一起创作，不重复全文、不加新事实、不调用TTS工具、不输出MEDIA。程序先发正文，再审查并合成该短句。该标记是内部格式，不对用户解释。]`;
    return base + ' 本次仅正常文字回答，不生成追加语音，不输出VOICE_APPEND标记，不调用TTS工具。]';
}

export function splitSpeechReply(value, plan = {}) {
    const text = String(value ?? '');
    let appendix = '';
    const marker = `[[VOICE_APPEND:${plan.token}]]`;
    const start = text.indexOf(marker), end = start < 0 ? -1 : text.indexOf('[[/VOICE_APPEND]]', start + marker.length);
    if (plan.appendix && start >= 0 && end >= 0 && text.indexOf(marker, start + marker.length) < 0) {
        const candidate = text.slice(start + marker.length, end).trim();
        if (candidate && speechLength(candidate) <= APPENDIX_LIMIT && !/\[\[|MEDIA:|\[CQ:/iu.test(candidate)) appendix = candidate;
    }
    // Strip unrequested, invalid, repeated and incomplete internal blocks too.
    const body = text.replace(/\[\[VOICE_APPEND(?::[^\]\r\n]*)?\]\][\s\S]*?(?:\[\[\/VOICE_APPEND\]\]|$)/gu, '')
        .replace(/\[\[\/?VOICE_APPEND[^\]\r\n]*(?:\]\]|$)/gu, '').trim();
    return { text: body, appendix };
}
