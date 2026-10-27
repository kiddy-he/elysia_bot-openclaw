#!/usr/bin/env node
import {
  getQzoneCredentials,
  getQzoneFeeds,
  getQzoneMsgList,
  publishQzoneMsg,
  commentQzoneMsg,
  replyQzoneMsg,
  setQzoneLike,
  uploadQzoneImage,
  deleteQzoneMsg,
} from "./qzone-client.mjs";

function printHelp() {
  console.log(`
Usage: node qzone-cli.mjs <command> [options]

Commands:
  creds [--account <default|yuexia>]
      Check and display current Qzone auth credentials info (safe, hides secret values).

  feeds [--account <default|yuexia>] [--page <1>] [--count <10>]
      Fetch recent friend feed stream.

  msglist [--account <default|yuexia>] [--target <uin>] [--num <10>]
      Fetch 说说 (messages) list of own or target space.

  publish --content <text> [--image <local-path>] [--account <default|yuexia>] [--right <1|4|16>]
      Publish a 说说 (1: public, 4: friends only, 16: private).

  delete --tid <own-post-tid> [--account <default|yuexia>]
      Delete one explicitly selected post belonging to the logged-in account.

  comment --host <uin> --tid <feed_tid> --content <text> [--account <default|yuexia>]
      Add a comment to a target 说说.

  reply --host <uin> --tid <feed_tid> --comment-id <commentlist.tid> --reply-uin <commentlist.uin> --content <text> [--account <default|yuexia>]
      Reply directly under the selected original comment, without an @ mention.

  like --target <uin> --tid <feed_tid> [--abstime <timestamp>] [--unlike] [--account <default|yuexia>]
      Like (or unlike) a target 说说.
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "-h" || command === "--help") {
    printHelp();
    process.exit(0);
  }

  function getArg(flag, defaultValue = null) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return defaultValue;
  }

  const account = getArg("--account", "default");

  try {
    switch (command) {
      case "creds": {
        const creds = await getQzoneCredentials(account);
        console.log(
          JSON.stringify(
            {
              ok: true,
              uin: creds.uin,
              cookieKeys: Object.keys(creds.cookieObject),
              hasPskey: Boolean(creds.cookieObject.p_skey),
              hasSkey: Boolean(creds.cookieObject.skey),
            },
            null,
            2
          )
        );
        break;
      }
      case "feeds": {
        const page = Number(getArg("--page", "1"));
        const count = Number(getArg("--count", "10"));
        const res = await getQzoneFeeds({ account, pageNum: page, count });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "msglist": {
        const target = getArg("--target", null);
        const num = Number(getArg("--num", "10"));
        const res = await getQzoneMsgList({ account, targetUin: target, num });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "publish": {
        const content = getArg("--content");
        if (!content) {
          console.error("Error: --content is required");
          process.exit(1);
        }
        const right = Number(getArg("--right", "1"));
        const imagePath = getArg("--image");
        const images = imagePath ? [await uploadQzoneImage({ account, imagePath })] : [];
        const res = await publishQzoneMsg({ account, content, ugcRight: right, images });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "delete": {
        const res = await deleteQzoneMsg({ account, tid: getArg("--tid") });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "reply":
      case "comment": {
        if (command === "comment" && (args.includes("--comment-id") || args.includes("--reply-uin"))) {
          throw new Error("回复已有评论必须使用 reply；comment 不接受回复目标参数");
        }
        const host = getArg("--host");
        const tid = getArg("--tid");
        const content = getArg("--content");
        if (!host || !tid || !content) {
          console.error("Error: --host, --tid and --content are required");
          process.exit(1);
        }
        const res = command === "reply"
          ? await replyQzoneMsg({ account, hostUin: host, tid, content, commentId: getArg("--comment-id"), replyUin: getArg("--reply-uin") })
          : await commentQzoneMsg({ account, hostUin: host, tid, content });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "like": {
        const target = getArg("--target");
        const tid = getArg("--tid");
        if (!target || !tid) {
          console.error("Error: --target and --tid are required");
          process.exit(1);
        }
        const unlike = process.argv.includes("--unlike");
        const abstime = Number(getArg("--abstime", "0"));
        const res = await setQzoneLike({ account, targetUin: target, tid, like: !unlike, abstime });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: err.message,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

main();
