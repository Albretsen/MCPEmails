const translation = {
  title: '如何将 Gmail 连接到 Claude（2 分钟搞定，无需写代码）',
  description:
    '通过 MCP 大约两分钟即可将 Gmail 连接到 Claude：一个 Google 应用专用密码（或使用 Google 登录）、一个端点 URL，无需 API 密钥，无需写代码。Claude 实时读取、搜索并发送你的邮件，而你的邮件从不被存储。',
  coverAlt: '如何通过 MCP 在两分钟内将 Gmail 连接到 Claude：一个 Google 应用专用密码、一个端点 URL，邮件不被存储',
  content: `要将 Gmail 连接到 Claude，你只需做两件事：在 MCP Emails 控制台中用 Google 应用专用密码连接一次你的 Gmail 收件箱，然后把单个端点 URL 粘贴进 Claude 的连接器设置并批准一次登录。这就是全部工作：无需写代码，无需 SDK，无需 API 密钥。大约只要两分钟，而且 Claude 从不存储你的邮件：每一次读取和发送都实时访问 Gmail，并在 Claude 拿到后立即丢弃。

这是聚焦于 Gmail 的专项教程。如果你管理多个邮箱或使用非 Gmail 的服务商，[两分钟内连接任意邮箱](/blog/connect-email-to-ai-agent-under-2-minutes)指南还涵盖了 Outlook、iCloud、Fastmail 和 IMAP。

## 你需要准备

- 一个 **Gmail 或 Google Workspace** 账户。
- 一个**支持自定义连接器的 Claude** 版本：付费方案下的 claude.ai，或 Claude Desktop。（连接器是 Claude 与 MCP 服务器对话的方式。）
- 一个免费的 **MCP Emails** 账户。无需信用卡，可永久连接一个邮箱。[免费开始](/signup)，并保持此标签页打开。

MCP Emails 是中间的桥梁：它一侧用 Model Context Protocol 与 Claude 对话，另一侧与 Gmail 通信，默认通过 IMAP，如果你使用 Google 登录则通过 Gmail API。如果你想了解这意味着什么的背景知识，请参阅[MCP 邮件服务器究竟是什么](/blog/what-is-an-mcp-email-server)。

## 第 1 步：连接你的 Gmail 收件箱

在 MCP Emails 控制台中，打开 **Inboxes → Connect Inbox**，选择 **Gmail**。Gmail 默认通过 Google 应用专用密码连接：

1. 如果你的 Google 账户尚未开启两步验证，请先开启。Google 只为开启了两步验证的账户提供应用专用密码。
2. 前往 **myaccount.google.com/apppasswords** 创建一个。它由 16 个小写字母组成，分为四组，空格无关紧要。
3. 回到 MCP Emails，输入完整的 Gmail 地址，粘贴应用专用密码，然后点击**连接收件箱**。连接会先在 Gmail 上测试，通过后才会保存。搞定。

你的常规 Google 密码从不会被使用。应用专用密码是一个独立的凭据，MCP Emails 使用 AES-256-GCM 对其加密，你也可以随时在同一个 Google 页面上吊销它。在底层，收件箱通过 IMAP 和 SMTP（\`imap.gmail.com\`）连接。

### 更想用 Google 登录？

连接窗口还提供第二种方式：展开**更想用 Google 登录？**，然后点击**使用 Google 连接**。你在 Google 自己的页面上选择账户，并批准读取和发送权限。Google 会先显示一个警告页面，因为该应用尚未经过 Google 验证。要继续，请点击**高级（Advanced）**，然后点击**前往 mcpemails.com（Go to mcpemails.com）**。

### 该选哪种方式

两种方式都能继续使用，而你的选择决定了之后 Claude 能做什么：

- **应用专用密码（IMAP）：** Gmail 标签会显示为文件夹，搜索使用 IMAP 文本搜索，Claude 可以复制邮件，也可以永久删除邮件。
- **使用 Google 登录（Gmail API）：** Claude 使用真正的 Gmail 标签，并能用 \`from:\`、\`is:unread\` 和 \`after:\` 等 Gmail 运算符搜索。删除会把邮件移到回收站。

在 Google Workspace 账户上，管理员可以为整个域关闭应用专用密码，也可以在 Google 登录这条路径上屏蔽第三方应用。如果一种方式被屏蔽，可以试试另一种，或者询问你的管理员。

## 第 2 步：将 MCP Emails 添加到 Claude

现在把 Claude 指向同一个端点。由于 Claude 是一个 OAuth 客户端，你完全不需要 API 密钥：只需粘贴一个 URL 并批准一次登录。

1. 在 **claude.ai 或 Claude Desktop** 中，打开**设置 → 连接器（Settings → Connectors）**。
2. 点击**添加自定义连接器（Add custom connector）**。
3. 把以下内容粘贴为连接器 URL，然后点击**添加（Add）**：

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. 点击**连接（Connect）**，用你的 MCP Emails 账户登录，并批准你想要的范围：\`read:email\`、\`send:email\`，或两者都选。

这就是客户端的全部工作。该连接的范围严格限定于你所批准的内容，你可以在控制台中一键撤销。如果你更想了解 API 密钥的方式（适用于没有内置 OAuth 的客户端，如 Cline 或自定义脚本），请阅读[AI 邮件访问中 OAuth 与 API 密钥的对比](/blog/oauth-vs-api-keys-ai-email-access)。

## 第 3 步：向 Claude 发出你的第一条提示

用一个小任务来测试它。让 Claude：

> “帮我总结一下我最近三封未读邮件。”

在幕后，Claude 会调用 \`inbox_list\` 来发现你已连接的 Gmail，然后调用 \`email_read\` 来列出并读取这些邮件。如果它能回答，说明你的连接已经生效。接下来，可以试试：

- “找出上个月来自 Stripe 的发票，并告诉我金额。”
- “为我房东的最后一封邮件起草一封礼貌的回复，但先别发送。”
- “归档我收件箱中本周的所有新闻通讯。”
- “我在与 Acme 的邮件往来中同意了什么？”

想了解更深入的一整套用法（每日分流、自动摘要和清理例程），请参阅[让 Claude 管理收件箱的最佳方式](/blog/best-ways-to-let-claude-manage-your-inbox)和[分流与摘要实战手册](/blog/ai-agent-triage-summarize-inbox)。

## Claude 可以用你的 Gmail 做什么

连接完成后，Claude 通过一小套整合工具来工作，因此它能做的远不止读取：

- **读取与搜索：** \`email_read\`（列出、读取、全文搜索；如果你用 Google 登录连接，还可以使用 Gmail 运算符）。
- **发送与回复：** \`email_compose\`（发送、回复、转发）。邮件通过 Gmail 以来自你自己地址的普通邮件形式发出，因此你的域名声誉仍然归你所有。
- **整理：** \`email_organize\`（移动、标记、归档；使用 Google 登录时还支持标签）。
- **草稿、文件夹、定时发送、联系人：** \`draft\`、\`folder\`、\`schedule\` 和 \`contact_search\` 让整套工具更加完整。

有一点要事先说明：MCP Emails 是基于轮询的。没有推送 webhook，所以 Claude 是在你让它检查时才对新邮件作出反应，而不是在邮件抵达的那一刻。对于几乎所有助手类工作流而言，这正是恰到好处的模型。

## 把 Gmail 连接到 Claude 安全吗？

简短回答：安全，而且整个设计就是围绕这一点构建的。

- **你的邮件从不被存储。** 正文、主题和附件在每次调用时实时获取，交给 Claude，随后立即丢弃。每个收件箱唯一被持久化的，是加密后的凭据：你的应用专用密码，或者在你使用 Google 登录时的 OAuth 令牌。这里讲了[为什么“邮件从不被存储”真正重要](/blog/why-email-never-stored-matters)。
- **范围由你掌控。** 只批准只读权限，Claude 就根本无法发送。两者都批准后，你仍可随时撤销其中任意一个。
- **不共享密码。** 你的常规 Google 密码永远不会到达 MCP Emails。应用专用密码是一个独立的凭据，你可以在 myaccount.google.com/apppasswords 吊销它；使用 Google 登录则走 OAuth。无论哪种方式，你都可以在控制台中断开该收件箱。

完整的威胁模型（哪些内容被加密、攻击者能看到什么、又看不到什么）都在[给 AI 智能体邮件访问权限安全吗？](/blog/is-it-safe-to-give-ai-agent-email-access)中作了说明。

## 常见问题

**把 Gmail 连接到 Claude 需要 API 密钥吗？**
不需要。Claude 支持 OAuth，所以你只需粘贴端点 URL 并批准一次登录。API 密钥仅用于没有内置 OAuth 的客户端。

**Claude 会存储我的 Gmail 邮件吗？**
不会。邮件在每次请求时从 Gmail 实时获取，并在 Claude 读取后立即丢弃。除了你加密后的凭据（应用专用密码，或在你使用 Google 登录时的访问令牌）外，什么都不保留。

**Claude 能从我的 Gmail 发送邮件吗？**
可以，前提是你授予了 \`send:email\` 范围。发送通过 Gmail 以来自你自己账户的普通邮件形式进行。如果你更希望 Claude 永不发送，可只授予只读权限。

**这在免费版 Claude 方案下能用吗？**
自定义连接器需要一个支持它们的 Claude 方案（付费版 claude.ai 或 Claude Desktop）。MCP Emails 这一侧是免费的，无需信用卡。

**MCP Emails 会看到我的 Google 密码吗？**
不会。你粘贴的是应用专用密码，这是 Google 生成、可以随时吊销的独立凭据；或者你通过 OAuth 使用 Google 登录。你的常规 Google 密码从不会在 MCP Emails 的任何地方输入。

## 总结

这就是全部内容：一个 Google 应用专用密码、一个端点 URL，Claude 就能读取、搜索并发送你真实的邮件，而且从不存储它们。免费层不收任何费用、无需信用卡，可连接一个邮箱；Personal 每月 5 美元，最多可连接三个；Pro 可连接你拥有的每一个邮箱（请查看[价格](/pricing)）。

准备好了吗？[免费连接你的 Gmail](/signup)，把端点粘贴进 Claude，让它帮你总结未读邮件。`,
};

export default translation;
