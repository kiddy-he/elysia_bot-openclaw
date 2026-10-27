import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { uploadQzoneImage, publishQzoneMsg, deleteQzoneMsg } from "./qzone-client.mjs";
import { parseQzoneResponse } from "./qzone-response.mjs";
import { verifyQzonePicture } from "./qzone-daily.mjs";

const credentials = () => Response.json({ status: "ok", data: { cookies: "uin=o700000006; skey=old; p_skey=ticket" } });

test("upload builds an attachment from the actual returned image metadata", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qzone-upload-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, "fixture.jpg");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=pink:s=320x320", "-frames:v", "1", imagePath]);
  let uploadBody;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("get_cookies")) return credentials();
    assert.equal(new URL(url).hostname, "up.qzone.qq.com");
    uploadBody = new URLSearchParams(options.body);
    return new Response('frameElement.callback({ret:0,data:{albumid:"album",lloc:"large",sloc:"small",type:1,width:320,height:320,url:"https://photo.qq.com/a?bo=signature"}});');
  });
  const image = await uploadQzoneImage({ imagePath });
  assert.equal(image.richval, ",album,large,small,1,320,320,,320,320");
  assert.equal(image.pic_bo, "signature");
  assert.equal(image.account, "default");
  assert.ok(Buffer.from(uploadBody.get("picfile"), "base64").length > 100);
  assert.equal(uploadBody.get("refer"), "shuoshuo");
});

test("publish includes one image and the requested visibility; delete is scoped to the logged-in account", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("get_cookies")) return credentials();
    writes.push({ url: String(url), body: new URLSearchParams(options.body) });
    return Response.json({ code: 0, tid: "testpost123" });
  });
  await publishQzoneMsg({ content: "测试", ugcRight: 4, images: [{ account: "default", richval: "attachment", pic_bo: "signature" }] });
  assert.equal(writes[0].body.get("ugc_right"), "4");
  assert.equal(writes[0].body.get("richtype"), "1");
  assert.equal(writes[0].body.get("pic_bo"), "signature");
  await deleteQzoneMsg({ tid: "testpost123" });
  assert.match(writes[1].url, /emotion_cgi_delete_v6/);
  assert.equal(writes[1].body.get("hostuin"), "700000006");
  assert.equal(writes[1].body.get("tid"), "testpost123");
});

test("invalid visibility, mismatched image account, and invalid deletion IDs fail before network access", async () => {
  await assert.rejects(publishQzoneMsg({ content: "x", ugcRight: 2 }), /visibility/);
  await assert.rejects(publishQzoneMsg({ content: "x", images: [{ account: "yuexia", richval: "x", pic_bo: "x" }] }), /attachment/);
  await assert.rejects(deleteQzoneMsg({ tid: "../bad" }), /Invalid/);
  assert.throws(() => parseQzoneResponse('{ret:-1}', "upload"), /code -1/);
  assert.throws(() => parseQzoneResponse('{ret:0}', "publish"), /result code/);
});

test("published picture verification decodes real bytes and rejects wrong-size placeholders", async (t) => {
  const image = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=pink:s=320x320", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]);
  t.mock.method(globalThis, "fetch", async () => new Response(image, { headers: { "content-type": "image/jpeg" } }));
  const post = { pic: [{ url1: "https://photo.store.qq.com/a", width: 320, height: 320 }] };
  assert.deepEqual(await verifyQzonePicture(post), { width: 320, height: 320, codec: "mjpeg" });
  post.pic[0].width = 640; post.pic[0].height = 640;
  assert.equal((await verifyQzonePicture(post)).width, 320);
  post.pic[0].width = 1024;
  await assert.rejects(verifyQzonePicture(post), /placeholder/);
});
