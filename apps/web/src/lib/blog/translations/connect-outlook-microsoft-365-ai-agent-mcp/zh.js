const translation = {
  title: '通过 MCP 将 Outlook 和 Microsoft 365 连接到你的 AI 智能体',
  description:
    '通过 MCP 将 Outlook.com 或 Microsoft 365 连接到你的 AI 智能体。使用 Microsoft 登录，无需应用专用密码，底层使用 Microsoft Graph。工作账户可能需要 IT 管理员一次性批准。',
  coverAlt: '通过 MCP 将 Outlook 和 Microsoft 365 连接到 AI 智能体',
  content: `要把 Outlook 或 Microsoft 365 邮箱连接到你的 AI 智能体，你只需在 MCP Emails 控制台中通过**使用 Microsoft 登录**添加邮箱，然后把智能体指向一个 MCP 端点。无需应用专用密码，无需 IMAP 或 SMTP 设置，无需 Azure 门户，也无需自建 Graph 服务器。个人 Outlook.com 账户几分钟就能连好。工作或学校的 Microsoft 365 账户通常要先多走一步：由 IT 管理员为整个组织一次性批准该应用。

大多数“用 AI 处理邮件”的指南默认你用 Gmail，然后就到此为止。如果你的日常在 Outlook 里，这就是以 Outlook 为先的版本：哪些账户可以直接连接，管理员批准这一步是什么样子，连接后智能体能做什么，以及 Outlook 与 Gmail 表现不同的几个地方。

## 个人账户和工作账户是两种不同的情况

Microsoft 的邮箱并不是一种东西，这个区别决定了你的连接过程。

- **个人 Microsoft 账户**：Outlook.com、Hotmail、Live 和 MSN 地址。你使用 Microsoft 登录，自己批准权限，就连接好了。不需要任何管理员参与。
- **工作或学校的 Microsoft 365 账户**：这些账户位于你所在组织的 Microsoft Entra 租户中。很多组织要求 IT 管理员先批准第三方应用，其他人才能使用。Microsoft 的默认同意策略（自 2025 年底起）不允许员工自行批准邮箱读取权限，因此在很多租户中你无法独自完成连接。这是 Microsoft 租户的策略，不是 MCP Emails 能关闭的，而且对任何第三方邮件应用都一样适用。

管理员批准是整个组织只需做一次的步骤。完成之后，每位员工都可以按正常方式连接。

## 连接你的 Outlook 或 Microsoft 365 邮箱

分两部分：先连接邮箱，再连接智能体。这样分开是有意为之。邮箱连接让 MCP Emails 能访问你的邮箱，智能体连接让你的 AI 客户端能访问 MCP Emails。

### 第 1 步：添加邮箱

1. [免费开始](/signup)并打开控制台。
2. 进入 **Inboxes → Connect Inbox**，选择 **Outlook**。
3. 点击**使用 Microsoft 连接**。你会被带到 Microsoft 自己的登录页面。
4. 用你的 Microsoft 账户登录，如果账户启用了 MFA，请完成验证。
5. 查看同意页面并批准。Microsoft 会显示该应用来自已验证的发布者，并请求以下权限：读取和写入你的邮件、以你的身份发送邮件，以及在你断开连接之前保持访问。

MCP Emails 只加密保存由此获得的 OAuth 令牌，不保存你邮箱的其他任何内容。你永远不需要在 MCP Emails 中输入 Microsoft 密码，也不需要生成应用专用密码。这是与 IMAP 服务商的主要区别：[iCloud、Fastmail 和通用 IMAP 邮箱](/blog/connect-icloud-fastmail-imap-to-claude)改用应用专用密码。

### 如果你的组织需要先批准该应用

在工作或学校账户上，Microsoft 可能会在同意页面出现之前拦下你，并提示需要管理员批准。出现这种情况时，控制台会显示一条提示，附带**发送给你的 IT 管理员**链接：

1. 把这个链接发给你的 IT 管理员。
2. 管理员打开链接、登录，并为整个组织一次性批准 MCP Emails。
3. 回到控制台，按第 1 步连接 Outlook。现在它会像个人账户一样顺利完成。

管理员是为整个组织批准该应用，而每个人仍然用自己的账户登录，并且只连接自己的邮箱。

### 如果账户没有 Exchange 邮箱

有些 Microsoft 账户没有 Exchange Online 邮箱，例如没有 Exchange 许可证的管理员账户，或邮件托管在其他地方的组织。MCP Emails 会拒绝这类账户，因为没有可连接的邮箱，并会告诉你原因。如果你的邮件实际上在另一台服务器上，请改用 IMAP 连接该地址。

### 第 2 步：连接你的智能体

客户端只需连接一次，同一套设置适用于你账户中的所有邮箱。对于支持 OAuth 的客户端（claude.ai、Claude Desktop、Cursor），在 claude.ai 中的操作是：

**Customize → Connectors → Add connector → 粘贴 URL → Connect → 登录并批准。**

端点是：

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

点击 Connect 后，你登录自己的 MCP Emails 账户并批准权限范围：\`read:email\`、\`send:email\`，或两者都选。整个过程不需要交出任何 API 密钥。

对于不支持 OAuth 的客户端（Cline、JetBrains 插件、你自己的脚本、直接用 cURL），在 **Dashboard → API Keys** 中生成一个限定权限的密钥，并以 \`Authorization: Bearer <api-key>\` 的形式发送。这类客户端的完整步骤见[在 Cursor、Cline 和 VS Code 中为 AI 智能体接入邮件](/blog/email-for-ai-agents-cursor-cline-vscode)。如果你在权衡两种方式，[AI 访问邮件：OAuth 与 API 密钥对比](/blog/oauth-vs-api-keys-ai-email-access)列出了各自的利弊。

## 底层的 Microsoft Graph

Outlook 通过 Microsoft Graph 连接，而不是 IMAP。智能体的每次工具调用都会实时发往 Graph：读取一封邮件时，MCP Emails 从 Graph 取回邮件，把结果交给智能体，然后丢弃。发送邮件时，邮件通过 Graph 从你的真实地址发出，因此送达率和信誉始终属于你自己。MCP Emails 从不通过自己的域名转发邮件。

## 智能体能对 Outlook 邮箱做什么

- 读取和搜索邮件。
- 发送、回复和转发，附件最大 25 MB。
- 处理草稿，并安排稍后发送。
- 管理文件夹，包括嵌套文件夹。
- 移动、复制和归档邮件。
- 为邮件添加或取消旗标，并标记为已读或未读。
- 将邮件移到“已删除邮件”，或永久删除。
- 在智能体发送的每封邮件中使用你为该邮箱设置的签名。

### Outlook 与 Gmail 的不同之处

**文件夹，而不是标签。** Outlook 用文件夹整理邮件。标签工具仅适用于 Gmail，因此在 Outlook 邮箱上，智能体通过把邮件移入文件夹来归类。

**搜索。** Outlook 搜索使用 Microsoft Graph 自己的搜索。有一个 Graph 限制需要注意：文本搜索不能与未读、有附件、已加旗标或日期筛选条件同时使用。当查询包含文本时，这些筛选条件不会生效，结果会告诉智能体哪些条件被略过。如果两者都需要，先按文本搜索，再让智能体在返回的结果中进一步筛选。

**新的 Outlook.com 账户。** 对于刚注册、在短时间内大量发信的 Outlook.com 账户，Microsoft 可能会暂时阻止其发送。这是 Microsoft 的防滥用保护。如果新账户发送失败，请放慢发送节奏，稍后再试。

## 一个值得设置的工作流

下面是一个在 Outlook 邮箱上效果很好的分拣循环。每小时一到两次，智能体会：

1. 列出收件箱中的未读邮件。
2. 阅读看起来有时效性的邮件。
3. 汇总这一批邮件，并为你显然会回复的邮件起草回复。
4. 在你确认之前，所有邮件都保持未读。

MCP Emails 不会把新邮件主动推送给智能体，所以智能体按你设定的频率检查。对于分拣来说这就够了。关于可靠的轮询模式，请阅读[如何分拣和汇总收件箱](/blog/ai-agent-triage-summarize-inbox)。

## 与自建 Microsoft 365 服务器相比

GitHub 上那些自托管的 Outlook MCP 服务器都会撞上同一堵墙：在 Entra 中注册应用、管理员同意以及 Graph 令牌的生命周期才是真正的工作量，而且要由你永远维护下去。自托管版的 MCP Emails 只支持 IMAP 和 SMTP。Outlook 连接器只在托管产品中提供，所以想在自托管环境中使用它的人需要注册自己的 Microsoft Entra 应用。采用托管方式时，令牌在存储时加密，只在调用时解密，你也可以随时在控制台中断开该邮箱。[托管与自托管](/blog/hosted-vs-self-hosted-gmail-mcp-server)更深入地讨论了其中的取舍。

如果你想了解这一层为什么存在，可以从[让 AI 智能体访问邮件的完整指南](/blog/how-to-give-your-ai-agent-email-access)开始。否则，就[免费开始](/signup)，连接你的 Outlook 邮箱，把智能体指向端点，给它点东西读吧。`,
};

export default translation;
