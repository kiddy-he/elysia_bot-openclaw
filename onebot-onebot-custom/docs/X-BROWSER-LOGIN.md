# X 浏览器登录桌面

2026-10-23 已启动独立 X11 桌面 `:17`，Chromium 窗口已进入 X 登录页。该桌面最多运行两小时，三个用户服务分别是 `openclaw-x-login-display`、`openclaw-x-login-wm`、`openclaw-x-login-browser`，不设置开机启用。

VNC 当前仅监听局域网地址 `192.0.2.10:5917`，已关闭该VNC监听器的IPv6；密码保持不变。在同一局域网用VNC查看器连接地址 `192.0.2.10`、端口5917。TigerVNC Viewer 命令行可用：

```bash
vncviewer 192.0.2.10::5917
```

需要经SSH隧道访问时（替换服务器地址）：

```bash
ssh -N -L 5917:192.0.2.10:5917 root@服务器地址
```

隧道建立后连接本机5917端口。在服务器已有SSH终端读取临时桌面密码：

```bash
cat /root/.openclaw/state/x-media/x11/vnc-password.txt
```

在窗口中由用户输入 X 用户名、密码及验证信息。浏览器使用独立 profile `/root/snap/chromium/common/openclaw-x-login/browser-profile` 和既有本机代理，不读取其他浏览器资料。登录凭据不需要发送到聊天。

查看 Cookie 是否已就绪，仅输出状态：

```bash
cd /root/.openclaw/onebot-onebot-custom
node integrations/x-media/browser-session.mjs status
```

登录完成后导入（正常情况下自动从个人资料入口取用户名；若提示需要用户名，将实际 X 用户名作为最后一个参数）：

```bash
node integrations/x-media/browser-session.mjs import
# 或
node integrations/x-media/browser-session.mjs import YOUR_USERNAME
```

该命令只从本次独立浏览器读取 X/Twitter 的 `auth_token` 和 `ct0`，选择同一域的完整会话，通过权限600的临时文件交给既有 `accounts.py`，完成后删除临时文件。Cookie 值不出现在输出中。正式账号库为 `/root/.openclaw/state/x-media/accounts.db`；导入后仍需实际搜索检查是否可用。2026-10-23 已完成本机导入与真实搜索、媒体下载验证，结果见 [X-MEDIA-WORKFLOW.md](X-MEDIA-WORKFLOW.md)；导入后的业务调用不依赖浏览器继续运行。

桌面 Xauthority 位于 `/root/snap/chromium/common/openclaw-x-login/Xauthority`。管理员在该显示上运行图形命令时设置：

```bash
export DISPLAY=:17
export XAUTHORITY=/root/snap/chromium/common/openclaw-x-login/Xauthority
```

结束时停止显示服务，会同时停止窗口管理器和浏览器；保留独立 profile 与已导入账号数据库：

```bash
systemctl --user stop openclaw-x-login-display.service
```

若两小时后桌面过期，可以依次重启 display、wm、browser 三个服务。重新开放远程桌面前可轮换本机VNC密码文件。远程调试端口9227只监听本机，用于本机导入，不需要转发给查看器。
