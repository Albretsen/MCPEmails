const translation = {
  title: '将 Claude 连接到任意邮箱：iCloud、Apple Mail、Yahoo 与 IMAP',
  description:
    '如何通过 MCP 将 Claude 连接到 iCloud、Yahoo、Outlook 或任意 IMAP 收件箱，包括你在 Apple Mail 中阅读的账户。约两分钟，无需代码，不存储任何邮件。',
  coverAlt:
    '使用 MCPEmails 将 Claude 连接到 Gmail、Outlook、iCloud、Fastmail、Yahoo、Zoho 和 IMAP 邮箱',
  content: `Claude 可以读取、搜索、整理和发送你的电子邮件，但它需要一台 MCP 服务器才能访问真实收件箱。MCPEmails 就是这座桥梁：只需连接一次收件箱，将一个安全端点添加到 Claude，Claude 就能在 Gmail、Outlook 与 Microsoft 365、iCloud、Fastmail、Yahoo、Zoho 以及其他 IMAP 服务商之间使用一致的邮件工具。

通过 Claude 的 OAuth 流程连接时，无需编写代码、安装 SDK 或使用 API 密钥。每次请求都会从你的服务商实时获取邮件，MCPEmails 不会存储邮件。

**跳转到你的服务商：** [Gmail](#gmail-与-google-workspace) · [iCloud](#icloud-邮件) · [Apple Mail](#apple-mail) · [Fastmail](#fastmail) · [Outlook](#outlook-与-microsoft-365) · [Yahoo、Zoho、Yandex 或自定义 IMAP](#yahoozohoyandex-和自定义-imap)

## 你需要准备什么

- 网页版 **Claude**（claude.ai）或 Claude Desktop。所有 Claude 计划都可以添加自定义连接器：Free 最多一个，Pro 和 Max 不限数量。
- 一个免费的 **MCPEmails** 账户：[在此创建](/signup)。
- 一个邮件收件箱。Outlook 通过**使用 Microsoft 登录**连接。Gmail、iCloud、Fastmail、Yahoo、Zoho 以及多数其他服务商使用应用专用密码。

## 第 1 步：将收件箱连接到 MCPEmails

在 MCPEmails 控制台中，打开 **Inboxes → Connect Inbox**，然后选择你的服务商。

### Gmail 与 Google Workspace

选择 **Gmail**，在 myaccount.google.com/apppasswords 创建一个 Google 应用专用密码（只有开启两步验证后 Google 才会提供），然后把这 16 个字母连同完整的 Gmail 地址一起填入。常规 Google 密码在这里无法使用，你也可以随时撤销应用专用密码。如果 Workspace 管理员为你的域名关闭了应用专用密码，请参阅专门的 [Gmail 指南](/blog/connect-gmail-to-claude)。另见[Gmail 设置与限制](/connect/gmail)和[Google Workspace 设置页面](/connect/google-workspace)。

### iCloud 邮件

在 Apple 账户中创建应用专用密码，选择 **iCloud**，然后输入该密码，而不是你的常规 Apple 账户密码。[iCloud 和 IMAP 指南](/blog/connect-icloud-fastmail-imap-to-claude)包含各服务商的具体步骤。另见[将 iCloud 邮件连接到 Claude](/connect/icloud)。

### Apple Mail

Apple Mail 是一个邮件应用，所以 Claude 连接的是它背后的账户，而不是应用本身。iCloud 地址按上文方式连接。Gmail、Outlook、Yahoo 或工作邮箱通过各自的服务商连接。仅存放在“我的 Mac 上”的文件夹不在任何服务器上，因此 Claude 看不到。你的 Mac 上不需要运行任何东西。

### Fastmail

在 Fastmail 中创建具有邮件访问权限的应用密码，选择 **Fastmail**，然后粘贴到 MCPEmails。在连接测试成功之前，请保留生成的密码。另见[适用于 Claude 的 Fastmail 设置](/connect/fastmail)。

### Outlook 与 Microsoft 365

选择 **Outlook**，点击**使用 Microsoft 连接**并批准，无需应用专用密码。个人 Outlook.com、Hotmail、Live 和 MSN 账户可以直接连接。工作或学校的 Microsoft 365 账户可能需要 IT 管理员先为整个组织一次性批准该应用；控制台会给你一个可以发给管理员的链接。详情见 [Outlook 与 Microsoft 365 指南](/blog/connect-outlook-microsoft-365-ai-agent-mcp)。另见[Outlook 设置页面](/connect/outlook)或[Microsoft 365 设置页面](/connect/office365)。

### Yahoo、Zoho、Yandex 和自定义 IMAP

创建应用密码，选择 **IMAP**，然后输入地址和密码。常见的服务器设置会自动识别；自定义域名可能需要服务商提供的 IMAP/SMTP 主机、端口和加密方式。各服务的设置见[Yahoo Mail](/connect/yahoo)、[Zoho Mail](/connect/zoho)、[Yandex Mail](/connect/yandex)和[自定义 IMAP](/connect/imap)页面。你也可以查看[所有支持的服务商](/connect)。

你可以连接多个收件箱。Claude 会通过 \`inbox_list\` 发现它们，因此无需在提示词中粘贴邮箱 ID。

需要按服务商查看帮助？请阅读[两分钟多服务商设置指南](/blog/connect-email-to-ai-agent-under-2-minutes)、专门的 [Gmail 指南](/blog/connect-gmail-to-claude)，或 [iCloud、Fastmail 和 IMAP 指南](/blog/connect-icloud-fastmail-imap-to-claude)。

## 第 2 步：将 MCPEmails 添加到 Claude

在 claude.ai 或 Claude Desktop 中：

1. 打开 **Customize → Connectors**。
2. 点击 **+ Add**，然后选择 **Add custom connector**。
3. 将其命名为 MCPEmails，并粘贴此 URL：

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. 点击 **Continue**，检查 Claude 检测到的登录设置（保持默认即可），然后点击 **Add**。
5. 登录 MCPEmails，并批准所需范围：\`read:email\`、\`send:email\` 或两者。
6. 在对话中点击左下角的 **+**，选择 **Connectors**，然后打开 MCPEmails。

在 Team 或 Enterprise 计划中，由 Owner 在 **Organization settings → Connectors** 下添加一次连接器。之后成员打开 **Customize → Connectors**，找到 MCPEmails 并点击 **Connect**。

这就是 Claude 端的全部设置。OAuth 会将连接限制在你批准的范围内，你可以随时在 MCPEmails 中撤销它。如果你使用的客户端不支持 OAuth，请改用受限 API 密钥；[OAuth 与 API 密钥](/blog/oauth-vs-api-keys-ai-email-access)介绍了这种方式。如遇 Claude 端的问题，请参阅[Claude 设置页面](/docs/claude)。

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

MCPEmails 为 Claude 提供的是专用邮件工具，而不是密码或原始 IMAP 连接：

- **读取和搜索：** \`email_read\` 可以列出邮件、读取完整邮件以及按发件人、主题、日期、未读状态等结构化字段搜索邮件。在 Gmail 中，标签显示为文件夹。
- **发送、回复和转发：** \`email_compose\` 会通过你自己的服务商和地址发送。
- **整理：** \`email_organize\` 可以移动、添加标签、标记和归档邮件。
- **处理草稿、文件夹、日程和联系人：** \`draft\`、\`folder\`、\`schedule\` 和 \`contact_search\` 覆盖了实用邮件工作流的其余部分。

MCPEmails 采用轮询模式：Claude 会在你要求时检查新邮件，而不是在邮件到达的瞬间接收推送事件。

## 将 Claude 连接到邮件安全吗？

可以，前提是只授予连接所需的访问权限，并让人工参与对外操作。

- **邮件不会被存储。** MCPEmails 在每次调用时实时获取邮件内容，并在交付后丢弃。唯一保留的收件箱数据，是重新连接到服务商所需的加密凭证。
- **你的服务商仍控制身份验证。** Outlook 使用 OAuth，因此 MCPEmails 永远看不到你的 Microsoft 密码。对于 Gmail 和其他使用应用专用密码的服务商，应用专用密码是一个独立的凭据，不是你的账户密码，你可以随时撤销。
- **权限范围明确。** 如果 Claude 永远不应发送邮件，就只授予读取权限。仅在需要时添加发送权限，并可随时撤销。

请将每封邮件正文都视为不可信输入。要求 Claude 先起草再发送，审查对外邮件，并且不要让邮件中的指令取代你的真实意图。[邮件访问安全指南](/blog/is-it-safe-to-give-ai-agent-email-access)会更详细地说明威胁模型。

## 常见问题

**Claude 可以连接 Gmail、Outlook 或 iCloud 吗？**  
Gmail 通过 Google 应用专用密码连接，Outlook 通过使用 Microsoft 登录连接，iCloud 通过应用专用密码连接。工作或学校的 Microsoft 365 账户可能需要 IT 管理员先一次性批准该应用。MCPEmails 也支持 Fastmail 和通用 IMAP，因此覆盖 Yahoo、Zoho 等服务。

**我需要 API 密钥吗？**  
Claude 的 OAuth 连接器流程不需要。粘贴端点 URL 并登录即可。API 密钥用于没有内置 OAuth 的 MCP 客户端。

**Claude 可以发送邮件吗？**  
可以，前提是你授予 \`send:email\`。如果需要人工审核，请先使用只读权限，或要求 Claude 先起草。

**MCPEmails 会存储我的收件箱吗？**  
不会。邮件从你的服务商实时读取后即被丢弃。MCPEmails 只保存完成这些实时请求所需的加密凭证。

## 下一步

[免费开始](/signup)，连接收件箱，将 \`https://mcpemails.com/api/mcp\` 添加到 Claude，然后让它总结未读邮件。完整的 MCP 工具参考和服务商能力请见[文档](/docs)。`,
};

export default translation;
