# 通用配置结构示例

本目录由 `scripts/prepare-sanitized-git.py` 的固定模板生成，不从现用配置导出。账号、群和服务端点均为虚构示例；任务及工作区路由留空，集成功能默认关闭。

这些文件用于了解字段位置，不是完整部署配置。`${EXAMPLE_*}` 是需要手动填写的占位符，不保证运行时会自动展开；端口等字段需要按实际 schema 改为正确类型。启用功能前应阅读对应业务文档、填写本地配置并完成权限与登录验证。

实际 `openclaw.json` 和根目录 `onebot-*.json` 只保留在本机，已由 Git 忽略。不要将其复制回本目录。新克隆请运行 `python3 onebot-onebot-custom/scripts/check-sanitized-index.py --install-hook` 安装提交前检查；创建源码快照仍通过 `prepare-sanitized-git.py --stage`。
