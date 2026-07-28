export default {
  title: '通过 MCP 将 Claude 连接到你的邮箱（Gmail、Outlook、iCloud 和 IMAP）',
  description:
    '实用指南：通过 MCP 将 Claude 连接到 Gmail、Outlook、iCloud、Fastmail、Yahoo、Zoho 和任何 IMAP 收件箱——无需编写代码，也不存储邮件。',
  coverAlt:
    '使用 MCP Emails 将 Claude 连接到 Gmail、Outlook、iCloud、Fastmail、Yahoo、Zoho 和 IMAP 邮箱',
  content: `Claude 可以读取、搜索、整理和发送你的电子邮件，但它需要一台 MCP 服务器才能访问真实收件箱。MCP Emails 就是这座桥梁：只需连接一次收件箱，将一个安全端点添加到 Claude，Claude 就能在 Gmail、Outlook、iCloud、Fastmail、Yahoo、Zoho 以及其他 IMAP 服务商之间使用一致的邮件工具。

通过 Claude 的 OAuth 流程连接时，无需编写代码、安装 SDK 或使用 API 密钥。每次请求都会从你的服务商实时获取邮件，MCP Emails 不会存储邮件。

## 你需要准备什么

- 支持自定义连接器的 **Claude 计划或应用**。
- 一个免费的 **MCP Emails** 账户——[在此创建](/signup)。
- 一个邮件收件箱。Gmail 和 Outlook 使用 OAuth；iCloud、Fastmail、Yahoo、Zoho 以及多数其他服务商使用应用专用密码。

## 第 1 步：将收件箱连接到 MCP Emails

在 MCP Emails 控制台中，打开 **Inboxes → Connect Inbox**，然后选择你的服务商。

- **Gmail / Google Workspace：** 使用 Google 登录并授权访问。
- **Outlook / Microsoft 365：** 使用 Microsoft 登录并授权访问。
- **iCloud 和 Fastmail：** 在服务商处创建应用专用密码，再将其输入 MCP Emails。
- **Yahoo、Zoho、Yandex 和其他 IMAP 邮箱：** 创建应用密码，选择 **IMAP**，然后输入地址和密码。常见的服务器设置会自动识别。

你可以连接多个收件箱。Claude 会通过 \`inbox_list\` 发现它们，因此无需在提示词中粘贴邮箱 ID。

需要按服务商查看帮助？请阅读[两分钟多服务商设置指南](/blog/connect-email-to-ai-agent-under-2-minutes)、专门的 [Gmail 指南](/blog/connect-gmail-to-claude)，或 [iCloud、Fastmail 和 IMAP 指南](/blog/connect-icloud-fastmail-imap-to-claude)。

## 第 2 步：将 MCP Emails 添加到 Claude

在 claude.ai 或 Claude Desktop 中：

1. 打开 **Settings → Connectors**。
2. 选择 **Add custom connector**。
3. 粘贴此 URL：

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. 选择 **Connect**，登录 MCP Emails，并批准所需范围：\`read:email\`、\`send:email\` 或两者。

这就是 Claude 端的全部设置。OAuth 会将连接限制在你批准的范围内，你可以随时在 MCP Emails 中撤销它。如果你使用的客户端不支持 OAuth，请改用受限 API 密钥；[OAuth 与 API 密钥](/blog/oauth-vs-api-keys-ai-email-access)介绍了这种方式。

## 第 3 步：给 Claude 一个安全的首个任务

先从只读请求开始：

> 总结我最新的三封未读邮件，并标记今天需要回复的内容。

Claude 会先找到已连接的收件箱，再列出并读取相关邮件。成功后，你可以尝试：

- “找到上个月 Stripe 的发票，并告诉我金额。”
- “为 Alex 最新的一封邮件起草回复，但不要发送。”
- “显示本周我可以归档的新闻邮件。”
- “我在与 Acme 的邮件线程中同意了什么？”

如需可重复使用的流程，请使用[收件箱分流指南](/blog/ai-agent-triage-summarize-inbox)或[让 Claude 管理收件箱的方法](/blog/best-ways-to-let-claude-manage-your-inbox)。

## 连接后 Claude 能做什么

MCP Emails 为 Claude 提供的是专用邮件工具，而不是密码或原始 IMAP 连接：

- **读取和搜索：** \`email_read\` 可以列出邮件、读取完整邮件以及搜索邮件。Gmail 搜索还支持 \`from:\` 和 \`is:unread\` 等 Gmail 运算符。
- **发送、回复和转发：** \`email_compose\` 会通过你自己的服务商和地址发送。
- **整理：** \`email_organize\` 可以移动、添加标签、标记和归档邮件。
- **处理草稿、文件夹、日程和联系人：** \`draft\`、\`folder\`、\`schedule\` 和 \`contact_search\` 覆盖了实用邮件工作流的其余部分。

MCP Emails 采用轮询模式：Claude 会在你要求时检查新邮件，而不是在邮件到达的瞬间接收推送事件。

## 将 Claude 连接到邮件安全吗？

可以，前提是只授予连接所需的访问权限，并让人工参与对外操作。

- **邮件不会被存储。** MCP Emails 在每次调用时实时获取邮件内容，并在交付后丢弃。唯一保留的收件箱数据，是重新连接到服务商所需的加密凭证。
- **你的服务商仍控制身份验证。** Gmail 和 Outlook 使用 OAuth，因此 MCP Emails 永远不会收到你的密码。对于 IMAP 服务商，请使用可撤销的应用专用密码，而不是常规密码。
- **权限范围明确。** 如果 Claude 永远不应发送邮件，就只授予读取权限。仅在需要时添加发送权限，并可随时撤销。

请将每封邮件正文都视为不可信输入。要求 Claude 先起草再发送，审查对外邮件，并且不要让邮件中的指令取代你的真实意图。[邮件访问安全指南](/blog/is-it-safe-to-give-ai-agent-email-access)会更详细地说明威胁模型。

## 常见问题

**Claude 可以连接 Gmail、Outlook 或 iCloud 吗？**  
可以。Gmail 和 Outlook 通过 OAuth 连接。iCloud 通过应用专用密码连接。MCP Emails 也支持 Fastmail 和通用 IMAP，因此覆盖 Yahoo、Zoho 等服务。

**我需要 API 密钥吗？**  
Claude 的 OAuth 连接器流程不需要。粘贴端点 URL 并登录即可。API 密钥用于没有内置 OAuth 的 MCP 客户端。

**Claude 可以发送邮件吗？**  
可以，前提是你授予 \`send:email\`。如果需要人工审核，请先使用只读权限，或要求 Claude 先起草。

**MCP Emails 会存储我的收件箱吗？**  
不会。邮件从你的服务商实时读取后即被丢弃。MCP Emails 只保存完成这些实时请求所需的加密凭证。

## 下一步

[免费开始](/signup)，连接收件箱，将 \`https://mcpemails.com/api/mcp\` 添加到 Claude，然后让它总结未读邮件。完整的 MCP 工具参考和服务商能力请见[文档](/docs)。`,
};
