const translation = {
  title: '如何将 iCloud、Fastmail 或任意 IMAP 邮箱连接到 Claude',
  description:
    '用应用专用密码把 iCloud、Fastmail 或任意 IMAP 邮箱连接到 Claude。分步配置、MCP 端点，以及 IMAP 能做而 Gmail 做不到的事。',
  coverAlt: '通过 MCP 将 iCloud、Fastmail 及任意 IMAP 邮箱连接到 Claude',
  content: `把 iCloud、Fastmail 或任意 IMAP 邮箱连接到 Claude，只需要一样 Gmail 和 Outlook 不需要的东西：**应用专用密码**。你在邮件服务商那里生成它，在 MCP Emails 里粘贴一次，Claude 就能读取、搜索并通过这个邮箱发信。没有 OAuth 的来回授权，也不用记一堆 SMTP 服务器设置。

这条路适用于所有不是 Gmail 或 Microsoft 的服务商。iCloud、Fastmail、Yahoo、Zoho、Yandex，以及任何通用 IMAP 主机，都走相同的 IMAP/SMTP 传输方式，所以它们共享完全一致的功能集。只要你能从服务商那里拿到应用专用密码，就能连接它。相比 OAuth 服务商还有一个不错的好处：IMAP 让 Claude 拥有真正的、永久的删除能力。

## 为什么这些服务商用应用专用密码，而不是 OAuth

Gmail 和 Outlook 提供现代化的 OAuth API，所以 MCP Emails 用一次点击登录就能连上。iCloud 和 Fastmail 没有为第三方邮件工具提供这条路径。它们给你的是**应用专用密码**——一段随机生成的长密码，作用范围限定在单个应用，与你真正的账户密码相互独立，可以单独吊销。

有一点值得纠正，因为不少旧文章把它搞错了：**Fastmail 只支持应用专用密码。**Fastmail 过去对某些集成支持过 OAuth 流程，但如今要连接 MCP Emails，你得在 Fastmail 的设置里生成一个应用专用密码，跟 iCloud 一样。如果某篇指南让你通过 OAuth「用 Fastmail 登录」，那它已经过时了。

应用专用密码会成为 MCP Emails 为该邮箱存储的唯一凭据，[以 AES-256-GCM 加密保存于静态存储](/blog/why-email-never-stored-matters)，仅在调用时于隔离的 Edge Function 内部解密。你真正的邮件内容从不被存储——每次工具调用都从服务商那里实时获取，用完即弃。

## 为 iCloud 生成应用专用密码

1. 打开 [appleid.apple.com](https://appleid.apple.com)，用你的 Apple Account 登录。
2. 在 **Sign-In and Security** 区域，打开 **App-Specific Passwords**。
3. 点击 **+**（Generate an app-specific password），起一个像 \`MCP Emails\` 这样的标签，并用你的 Apple Account 密码确认。
4. Apple 会以 \`abcd-efgh-ijkl-mnop\` 的格式显示一个密码。现在就复制它，之后你无法再次查看。

你需要为 Apple Account 开启双重认证——没有它就用不了应用专用密码。iCloud 的 IMAP 主机是 \`imap.mail.me.com\`，SMTP 是 \`smtp.mail.me.com\`，但当你选择 iCloud 作为服务商时，MCP Emails 会帮你自动填好，所以通常你不用碰它们。

## 为 Fastmail 生成应用密码

1. 登录 Fastmail，打开 **Settings → Privacy & Security → Connected apps & API tokens**（较早的账户里标为 **App Passwords**）。
2. 点击 **New app password**。
3. 给它起个名字（\`MCP Emails\` 就行），访问权限选择 **Mail (IMAP/SMTP)**，这样它既能读取也能发送。
4. Fastmail 只会生成密码一次。在关闭对话框之前复制它。

Fastmail 的 IMAP 主机是 \`imap.fastmail.com\`，SMTP 是 \`smtp.fastmail.com\`。同样，在 MCP Emails 里选择 Fastmail 会自动设置好这些。

## 连接通用 IMAP 邮箱（其余所有情况）

对于 Yahoo、Zoho、Yandex、自托管邮件服务器，或任何其他带 IMAP 端点的邮箱，步骤的形态是一样的：从服务商那里拿到应用密码（大多支持双重认证的服务商都要求用它），然后把四样东西交给 MCP Emails：

- **IMAP 主机和端口**（TLS 通常是 \`993\`）
- **SMTP 主机和端口**（通常是 \`465\` 或 \`587\`）
- 用你的**电子邮件地址**作为用户名
- 用**应用密码**作为密码

如果你确实只有一个普通密码，而且服务商不提供应用密码，那个也能用——但应用密码才是正确的选择。它能限制波及范围。吊销它，只有这个连接失效，而不会牵连你的整个账户。

## 在 MCP Emails 中连接邮箱

复制好密码之后：

1. 打开 dashboard，进入 **Inboxes → Connect Inbox**。
2. 选择你的服务商——**iCloud**、**Fastmail** 或 **Generic IMAP**。
3. 粘贴你的电子邮件地址和应用专用密码。对于通用 IMAP，还要确认主机和端口。
4. 保存。不到一分钟，邮箱就上线了。

就这么简单。如果你想要适用于任意服务商的最快版本，[两分钟内完成连接的完整演示](/blog/connect-email-to-ai-agent-under-2-minutes)从头到尾都讲到了。

## 把 Claude 指向你的邮箱

连接邮箱和连接 Claude 是两个独立的步骤。邮箱存在于 MCP Emails 里；现在你要把 [MCP](https://modelcontextprotocol.io) 端点交给 Claude，让它能调用这些工具。

在 claude.ai 里：

1. 进入 **Customize → Connectors**。
2. 点击 **Add connector**，粘贴这个端点：\`https://www.mcpemails.com/api/mcp\`
3. 点击 **Connect**，用你的 MCP Emails 账户登录，并批准你想要的权限——\`read:email\`、\`send:email\` 或两者都要。

不用 API key，不用配置文件。claude.ai 在底层使用带 PKCE 的 OAuth，Claude 拿到的令牌恰好被限定在你批准的范围。如果你用的客户端无法做 OAuth——Cursor、Cline、一段 cURL 脚本——那就改为生成一个限定范围的密钥，这一点我在 [Cursor、Cline 和 VS Code 的邮件访问](/blog/email-for-ai-agents-cursor-cline-vscode)里有讲到。

连上之后，先让 Claude 运行 \`inbox_list\`。它会返回你的邮箱及其 \`inbox_id\`，这样你永远不用手动复制粘贴 UUID。从那里开始就是[核心工具](/docs)了——\`email_read\`（列出、读取并搜索邮件）、\`email_compose\`（发送、回复、转发）和 \`email_organize\`——外加几个用于文件夹、草稿、定时和联系人的工具。每个都通过一个 \`action\` 参数来调用。

一段用来确认它能跑通的提示词：

\`\`\`
Use inbox_list to find my iCloud inbox, then summarize my 5 most recent unread messages.
\`\`\`

## IMAP 能做而 Gmail 和 Outlook 做不到的那一件事

这是大家容易忽略的地方。当 Claude 在 Gmail 或 Outlook 上「删除」一封邮件时，它会进入回收站。这是 Gmail 和 Microsoft Graph API 的硬性限制——它们不向第三方应用开放永久删除。邮件会一直留在回收站，直到服务商的保留期满。

IMAP 不一样。Fastmail、iCloud、Yahoo、Zoho、Yandex 以及通用 IMAP 都支持**硬性清除（hard expunge）**——Claude 可以永久移除一封邮件，而不只是把它扔进回收站。如果你想要一个真正会替自己收拾干净的代理，IMAP 是唯一能让它做到的传输方式。这很有用，同时也是一个理由，让你慎重对待自己授予了哪些权限。清除是不可逆的。

搜索的行为也略有不同。Gmail 用的是它完整的操作符语法，Outlook 用 KQL，而 IMAP 服务商用 IMAP 文本搜索——能力够用，但不如 Gmail 的操作符那么富有表现力。如果你要写大量依赖搜索的提示词，这一点值得了解。

## 连接之后你能搭建什么

不论用哪个服务商，机制都是一样的，所以你见过的任何 Gmail 工作流，在你的 Fastmail 或 iCloud 邮箱上都行得通。几个特别值回票价的：

- 早间分拣：标记出需要人工处理的，并为其余的起草回复。参见[收件箱分拣与摘要](/blog/ai-agent-triage-summarize-inbox)。
- 近实时的自动回复器。一个老实话提醒：MCP Emails 是基于轮询的，而非推送——没有 webhook，所以代理是按计划检查新邮件的。[自动回复器搭建](/blog/build-email-auto-responder-mcp-agent)讲了如何把这件事做好。

如果你还在犹豫要不要把邮件接入代理，那就从纲领文章开始：[如何让你的 AI 代理访问邮件](/blog/how-to-give-your-ai-agent-email-access)。

## 小结

iCloud、Fastmail 和 IMAP 在这里绝非二等公民。生成一个应用密码，把它粘贴进 **Inboxes → Connect Inbox**，把 Claude 指向[端点](/docs)，你就拥有了一个具备完整读取/发送权限的代理，外加 OAuth 服务商给不了的永久删除。它[免费起步](/signup)，无需信用卡，可永久连接一个邮箱。`,
};

export default translation;
