# Security Policy / 安全策略

## Supported versions / 支持版本

Security fixes are maintained for the latest `1.0.x` release and the current
`main` branch.

安全修复覆盖最新的 `1.0.x` 版本及当前 `main` 分支。

## Reporting a vulnerability / 报告安全问题

Use the repository's **Security → Report a vulnerability** form when it is
available. If the form is not visible, open an issue that only asks the
maintainer for a private contact channel; keep exploit details and user data out
of the public issue.

优先使用仓库中的 **Security → Report a vulnerability** 表单。若页面暂未显示该表单，
请仅创建一个请求私下沟通渠道的 Issue，并避免在公开 Issue 中附带利用细节或用户数据。

Please include:

- affected plugin and Harness versions;
- operating system and installation method;
- a minimal reproduction;
- expected impact and any suggested mitigation.

请附上受影响的插件与 Harness 版本、操作系统、安装方式、最小复现、影响范围以及可行的
缓解建议。

## Attachment boundary / 附件边界

The plugin treats browser-supplied names, MIME types, identifiers, and directory
member paths as untrusted input. Reports involving path traversal, unintended
workspace writes, attachment disclosure, or response-header injection are
especially useful.

插件会将浏览器传入的名称、MIME 类型、标识符及文件夹成员路径视为不可信输入。路径穿越、
非预期工作区写入、附件泄露与响应头注入等问题均属于重点关注范围。
