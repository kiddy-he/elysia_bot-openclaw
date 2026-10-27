import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { readQzoneResponse } from "./qzone-response.mjs";

function qzoneFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
}

function positiveInteger(value, name, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
}

function validateUin(value) {
  if (!/^[1-9]\d{4,11}$/.test(String(value))) throw new Error("Invalid target QQ number");
}

function getAccountConfig(account = "default") {
  if (!["default", "700000006", "yuexia", "700000005"].includes(account)) {
    throw new Error("Unknown account; use default or yuexia");
  }
  if (account === "yuexia" || account === "700000005") {
    return {
      uin: "700000005",
      httpPort: 3012,
      token: null,
    };
  }
  let token = null;
  try {
    const raw = fs.readFileSync("/root/llbot/data/config_700000006.json", "utf-8");
    const cfg = JSON.parse(raw);
    token = cfg.ob11?.connect?.find((c) => c.type === "http")?.token || null;
  } catch {}
  return {
    uin: "700000006",
    httpPort: 3002,
    token,
  };
}

export function parseCookies(cookieStr) {
  const map = {};
  for (const part of cookieStr.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) map[k] = v.join("=");
  }
  return map;
}

export function cookieToString(cookieObj) {
  return Object.entries(cookieObj)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function calculateBkn(skey) {
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) {
    hash += (hash << 5) + skey.charCodeAt(i);
  }
  return String(hash & 0x7fffffff);
}

export async function getQzoneCredentials(account = "default") {
  const { uin, httpPort, token } = getAccountConfig(account);
  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await qzoneFetch(`http://127.0.0.1:${httpPort}/get_cookies?domain=qzone.qq.com`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch cookies from LLBot (port ${httpPort}): HTTP ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("LLBot get_cookies returned invalid JSON");
  }
  if (body.status !== "ok" || !body.data?.cookies) {
    throw new Error("LLBot get_cookies failed or returned no cookies");
  }
  const cookieObject = parseCookies(body.data.cookies);
  const skey = cookieObject.p_skey || cookieObject.skey;
  if (!skey) throw new Error("LLBot returned no Qzone login ticket");
  const bkn = calculateBkn(skey);
  return {
    uin,
    cookieObject,
    cookieString: body.data.cookies,
    bkn,
  };
}

export async function getQzoneFeeds({ account = "default", pageNum = 1, count = 10, cursor = null } = {}) {
  positiveInteger(pageNum, "page", 10000);
  positiveInteger(count, "count", 100);
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 16000)) throw new Error('Invalid feed cursor');
  const continuation = new URLSearchParams(cursor ?? '');
  const cursorPage = Number(continuation.get('pagenum') ?? pageNum);
  positiveInteger(cursorPage, 'cursor page', 10000);
  const baseTime = continuation.get('basetime') ?? '0';
  if (!/^\d{1,15}$/u.test(baseTime)) throw new Error('Invalid feed basetime');
  const creds = await getQzoneCredentials(account);
  const url = `https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${new URLSearchParams({
    uin: creds.uin,
    scope: "0",
    view: "1",
    filter: "all",
    flag: "1",
    applist: "all",
    pagenum: String(cursorPage),
    count: String(count),
    refresh: cursor ? '0' : '1',
    useutf8: '1', outputhtmlfeed: '1', dayspac: '5', sidomain: 'qzonestyle.gtimg.cn',
    ...(cursor ? { externparam: cursor } : {}),
    aisortEndTime: "0",
    aisortOffset: "0",
    aisortBeginTime: "0",
    begintime: baseTime,
    g_tk: creds.bkn,
    format: "json",
  }).toString()}`;

  const res = await qzoneFetch(url, {
    headers: {
      Cookie: creds.cookieString,
      Referer: `https://user.qzone.qq.com/${creds.uin}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  return readQzoneResponse(res, "feeds");
}

export async function getQzoneMsgList({ account = "default", targetUin = null, pos = 0, num = 10 } = {}) {
  if (targetUin !== null) validateUin(targetUin);
  positiveInteger(num, "num", 100);
  if (!Number.isInteger(pos) || pos < 0) throw new Error("Invalid pos");
  const creds = await getQzoneCredentials(account);
  const hostUin = targetUin || creds.uin;
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?${new URLSearchParams({
    uin: String(hostUin),
    ftype: "0",
    sort: "0",
    pos: String(pos),
    num: String(num),
    g_tk: creds.bkn,
    code_version: "1", replynum: "100",
    format: "json",
  }).toString()}`;

  const res = await qzoneFetch(url, {
    headers: {
      Cookie: creds.cookieString,
      Referer: `https://user.qzone.qq.com/${hostUin}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  return readQzoneResponse(res, "msglist");
}

export function prepareQzoneImage(imagePath) {
  const stat = fs.statSync(imagePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > 64 * 1024 * 1024) throw new Error("Invalid image file size");
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", imagePath], { timeout: 15000, maxBuffer: 65536 }));
  const stream = probe.streams?.[0];
  if (probe.streams?.length !== 1 || !["png", "mjpeg", "webp"].includes(stream?.codec_name) || stream.width < 200 || stream.height < 200) {
    throw new Error("Expected one valid PNG, JPEG or WebP image");
  }
  const bytes = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", imagePath, "-vf", "scale=w='min(2048,iw)':h=-2", "-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { timeout: 30000, maxBuffer: 12 * 1024 * 1024 });
  return { bytes, filename: `${path.parse(imagePath).name}.jpg`, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function findUploadValue(value, names) {
  if (!value || typeof value !== "object") return undefined;
  for (const name of names) if (Object.hasOwn(value, name) && value[name] !== "") return value[name];
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const result = findUploadValue(child, names);
      if (result !== undefined) return result;
    }
  }
}

export async function uploadQzoneImage({ account = "default", imagePath } = {}) {
  const image = prepareQzoneImage(imagePath);
  const creds = await getQzoneCredentials(account);
  const url = `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${creds.bkn}`;
  const referrer = `https://user.qzone.qq.com/${creds.uin}`;
  const body = new URLSearchParams({
    filename: image.filename, uin: creds.uin, skey: creds.cookieObject.skey || "", p_skey: creds.cookieObject.p_skey || "",
    zzpaneluin: creds.uin, p_uin: creds.uin, qzonetoken: "", zzpanelkey: "", uploadtype: "1", albumtype: "7", exttype: "0",
    refer: "shuoshuo", output_type: "json", charset: "utf-8", output_charset: "utf-8", upload_hd: "1",
    hd_width: "2048", hd_height: "10000", hd_quality: "96", base64: "1", picfile: image.bytes.toString("base64"), qzreferrer: referrer,
  });
  const res = await fetch(url, {
    method: "POST", signal: AbortSignal.timeout(60000),
    headers: { Cookie: creds.cookieString, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Referer: referrer, Origin: "https://user.qzone.qq.com", "User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest" },
    body: body.toString(),
  });
  const data = await readQzoneResponse(res, "upload");
  const get = (...names) => String(findUploadValue(data, names) ?? "");
  const album = get("albumid", "album_id"), lloc = get("lloc"), sloc = get("sloc");
  const width = get("width", "w"), height = get("height", "h"), type = get("type", "phototype") || "1";
  let picBo = get("pic_bo", "picbo", "bo");
  if (!picBo) {
    for (const name of ["url", "origin_url", "pre", "raw_url"]) {
      const value = get(name);
      try { picBo = new URL(value).searchParams.get("bo") || ""; } catch {}
      if (picBo) break;
    }
  }
  if (![album, lloc, sloc, width, height, picBo].every(Boolean)) throw new Error("upload: incomplete image attachment metadata");
  return { account, sha256: image.sha256, width: Number(width), height: Number(height), richval: ["", album, lloc, sloc, type, height, width, "", height, width].join(","), pic_bo: picBo };
}

export async function publishQzoneMsg({ account = "default", content, ugcRight = 1, images = [] } = {}) {
  if (!content) throw new Error("content is required");
  if (![1, 4, 16].includes(ugcRight)) throw new Error("Invalid visibility");
  if (!Array.isArray(images) || images.length > 9 || images.some((x) => !x.richval || !x.pic_bo || x.account !== account)) throw new Error("Invalid image attachment");
  const creds = await getQzoneCredentials(account);
  const pBkn = creds.cookieObject?.p_skey ? calculateBkn(creds.cookieObject.p_skey) : creds.bkn;
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${pBkn}`;
  const body = new URLSearchParams({
    syn_tweet_verson: "1",
    paramstr: "1",
    pic_template: "",
    richtype: "",
    richval: "",
    special_url: "",
    subrichtype: "",
    con: content,
    feedversion: "1",
    ver: "1",
    ugc_right: String(ugcRight),
    to_sign: "0",
    who: "1",
    hostuin: creds.uin,
    code_version: "1",
    format: "json",
    qzreferrer: `https://user.qzone.qq.com/${creds.uin}`,
  });

  if (images.length) {
    body.set("richtype", "1"); body.set("subrichtype", "1");
    body.set("richval", images.map((x) => x.richval).join("\t"));
    body.set("pic_bo", images.map((x) => x.pic_bo).join(","));
  }

  const res = await qzoneFetch(url, {
    method: "POST",
    headers: {
      Cookie: creds.cookieString,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `https://user.qzone.qq.com/${creds.uin}`,
      Origin: "https://user.qzone.qq.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    body: body.toString(),
  });
  return readQzoneResponse(res, "publish");
}

export async function deleteQzoneMsg({ account = "default", tid } = {}) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(String(tid || ""))) throw new Error("Invalid own-post tid");
  const creds = await getQzoneCredentials(account);
  const body = new URLSearchParams({ hostuin: creds.uin, tid, topicId: `${creds.uin}_${tid}__1`, code_version: "1", format: "json", qzreferrer: `https://user.qzone.qq.com/${creds.uin}` });
  const res = await qzoneFetch(`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${creds.bkn}`, {
    method: "POST", headers: { Cookie: creds.cookieString, "Content-Type": "application/x-www-form-urlencoded", Referer: `https://user.qzone.qq.com/${creds.uin}`, Origin: "https://user.qzone.qq.com", "User-Agent": "Mozilla/5.0" }, body: body.toString(),
  });
  return readQzoneResponse(res, "delete");
}

export function validateQzoneComment({ hostUin, tid, content, commentId, replyUin } = {}) {
  validateUin(hostUin);
  if (!/^[a-zA-Z0-9_-]{5,100}$/.test(String(tid || ""))) throw new Error("Invalid post tid");
  if (typeof content !== "string" || !content.trim() || content.length > 1000 || content.includes("\0")) throw new Error("Invalid comment content");
  // A mention is not a native reply. Do not silently post it at the root.
  if (/@\s*\{|\[CQ:at\b|<at\b|(?:^|\s)@[^\s@]+/iu.test(content)) throw new Error("不要用艾特代替回复；请用 reply 并指定原评论 commentId 和 replyUin，正文只写回复内容");
  if (commentId !== undefined || replyUin !== undefined) {
    if (!/^[1-9]\d{0,19}$/.test(String(commentId || ""))) throw new Error("Invalid commentId; use commentlist[].tid");
    validateUin(replyUin);
  }
}

async function sendQzoneComment({ account, hostUin, tid, content, commentId, replyUin }, creds) {
  const pBkn = creds.cookieObject?.p_skey ? calculateBkn(creds.cookieObject.p_skey) : creds.bkn;
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${pBkn}`;
  const body = new URLSearchParams({
    qzreferrer: `https://user.qzone.qq.com/${creds.uin}`,
    inCharset: "utf-8",
    outCharset: "utf-8",
    hostUin: String(hostUin),
    format: "json",
    ref: "feeds",
    topicId: `${hostUin}_${tid}__1`,
    feedsType: "100",
    private: "0",
    paramstr: commentId === undefined ? "1" : "2",
    richtype: "",
    richval: "",
    isSignIn: "",
    uin: creds.uin,
    content,
    plat: "qzone",
    source: "ic",
    platformid: "52",
    ...(commentId === undefined ? {} : {
      commentId: String(commentId), commentUin: String(replyUin),
      t1_uin: String(hostUin), t1_tid: tid, t2_uin: String(replyUin), t2_tid: String(commentId),
    }),
  });

  const res = await qzoneFetch(url, {
    method: "POST",
    headers: {
      Cookie: creds.cookieString,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `https://user.qzone.qq.com/${creds.uin}`,
      Origin: "https://user.qzone.qq.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    body: body.toString(),
  });
  return readQzoneResponse(res, "comment");
}

export async function commentQzoneMsg(params = {}) {
  validateQzoneComment(params);
  if (params.commentId !== undefined || params.replyUin !== undefined) throw new Error("Use replyQzoneMsg for native replies");
  const account = params.account ?? "default";
  return sendQzoneComment({ ...params, account }, await getQzoneCredentials(account));
}

// One durable claim per recipient comment, independent of wording, tool-call id,
// incoming message and process lifetime. A crash or lost receipt never retries a
// possibly accepted POST. Account aliases resolve to the same logged-in UIN.
export async function replyQzoneMsg(params = {}, { stateDir = process.env.QZONE_REPLY_STATE_DIR || "/root/.openclaw/state/qzone-interactions/replies", getParent, trigger } = {}) {
  const { hostUin, tid, content, commentId, replyUin } = params;
  validateQzoneComment({ hostUin, tid, content, commentId, replyUin });
  if (commentId === undefined || replyUin === undefined) throw new Error("commentId and replyUin are required for a native reply");
  const account = params.account ?? "default";
  const creds = await getQzoneCredentials(account);
  const target = { botUin: creds.uin, hostUin: String(hostUin), tid, commentId: String(commentId), replyUin: String(replyUin) };
  // Scheduled follow-ups remain in the native root thread. A trusted caller
  // supplies the exact newly observed comment/reply event, never model text.
  if (trigger !== undefined) {
    if (typeof trigger !== 'string' || !/^[a-f0-9]{64}$/u.test(trigger)) throw new Error('Invalid reply trigger');
    target.trigger = trigger;
  }
  const key = crypto.createHash("sha256").update(JSON.stringify(target)).digest("hex");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, `${key}.json`);
  const prior = () => {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.state === "succeeded") return { ...record.receipt, alreadyReplied: true };
    throw new Error(`该原评论的回复已有记录（${record.state}），请先核对空间；未重复发送`);
  };
  if (fs.existsSync(file)) return prior();
  // Validate the selected root against fresh, read-only data before any write.
  const lookup = async () => {
    if (getParent) return getParent({ account, hostUin, tid, commentId, replyUin });
    const listing = await getQzoneMsgList({ account, targetUin: hostUin, num: 20 });
    return listing.msglist?.find(item => String(item.tid) === tid)?.commentlist
      ?.find(item => String(item.tid) === String(commentId) && String(item.uin) === String(replyUin));
  };
  const parent = await lookup();
  if (!parent || String(parent.tid) !== String(commentId) || String(parent.uin) !== String(replyUin)) throw new Error("未在最新 commentlist 中找到该原评论及作者，未发送；请重新读取目标评论，不能降级为艾特或一级评论");
  // An existing native reply is sufficient to prevent re-sending after state loss.
  if (!trigger && parent.list_3?.some(item => String(item.uin) === String(creds.uin))) throw new Error("该原评论已有本账号的原生回复，未重复发送");
  const beforeReplies = new Set((parent.list_3 ?? []).map(item => JSON.stringify([item.tid, item.uin, item.create_time, item.content])));
  const record = { version: 1, target, state: "sending", contentHash: crypto.createHash("sha256").update(content).digest("hex"), created: new Date().toISOString() };
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") return prior(); throw error; }
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const persist = value => {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  try {
    await sendQzoneComment({ account, hostUin, tid, content, commentId, replyUin }, creds);
    // code=0 alone cannot prove the server attached the reply to the parent.
    const verifiedParent = await lookup();
    const plain = value => String(value ?? "").replace(/@\{[^}]*\}/gu, "").replace(/\s+/gu, "");
    const delivered = verifiedParent?.list_3?.find(item => String(item.uin) === String(creds.uin) && plain(item.content) === plain(content)
      && !beforeReplies.has(JSON.stringify([item.tid, item.uin, item.create_time, item.content])));
    if (!delivered) throw new Error("接口返回成功，但回读未确认原评论下的原生回复；请先核对，不能补发一级评论");
    const receipt = { code: 0, subcode: 0, nativeReply: true, target, alreadyReplied: false };
    persist({ ...record, state: "succeeded", completed: new Date().toISOString(), receipt });
    return receipt;
  } catch (error) {
    persist({ ...record, state: "uncertain", updated: new Date().toISOString() });
    throw new Error(`原生回复未确认成功，已阻止自动重发：${error.message}`);
  }
}

export async function setQzoneLike({ account = "default", targetUin, tid, like = true, abstime = 0, appid = 311, typeid = 0, unikey, curkey } = {}) {
  validateUin(targetUin);
  if (!/^[a-zA-Z0-9_-]{5,100}$/u.test(String(tid ?? ''))) throw new Error('Invalid like tid');
  positiveInteger(appid, 'like appid', 99999);
  if (!Number.isInteger(typeid) || typeid < 0 || typeid > 100) throw new Error('Invalid like typeid');
  for (const key of [unikey, curkey]) if (key !== undefined && (typeof key !== 'string' || key.length > 4096 || /[\r\n\0]/u.test(key))) throw new Error('Invalid like key');
  const creds = await getQzoneCredentials(account);
  const pBkn = creds.cookieObject?.p_skey ? calculateBkn(creds.cookieObject.p_skey) : creds.bkn;
  const cgi = like ? "internal_dolike_app" : "internal_unlike_app";
  const url = `https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/${cgi}?g_tk=${pBkn}`;
  unikey ??= `http://user.qzone.qq.com/${targetUin}/mood/${tid}`;
  curkey ??= unikey;
  const body = new URLSearchParams({
    qzreferrer: `https://user.qzone.qq.com/${creds.uin}`,
    opuin: creds.uin,
    unikey,
    curkey,
    appid: String(appid),
    typeid: String(typeid),
    abstime: String(abstime || 0),
    fid: tid,
    from: "1",
    active: "0",
    fupdate: "1",
    format: "json",
  });

  const res = await qzoneFetch(url, {
    method: "POST",
    headers: {
      Cookie: creds.cookieString,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `https://user.qzone.qq.com/${creds.uin}`,
      Origin: "https://user.qzone.qq.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    body: body.toString(),
  });
  return readQzoneResponse(res, like ? "like" : "unlike");
}
