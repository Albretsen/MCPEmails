export default {
  title: '如何在 2 分钟内把邮箱连接到 AI 智能体（Gmail、Outlook、iCloud、Fastmail 与 IMAP）',
  description: '在 2 分钟内把邮箱连接到 AI 智能体。手把手教你通过 MCP 接入 Gmail、Outlook、iCloud、Fastmail 以及任意 IMAP 邮箱，且邮件从不存储。',
  coverAlt: '在 2 分钟内把邮箱连接到 AI 智能体——通过 MCP 接入 Gmail、Outlook、iCloud、Fastmail 与 IMAP',
  content: `把邮箱连接到 AI 智能体只需两步：在 MCP Emails 控制台连接邮箱，然后把智能体指向一个 endpoint URL。如果用的是像 claude.ai 这样支持 OAuth 的客户端，到这里就完成了。无需写代码、无需 SDK，而且你的邮件从不存储在任何地方——每一次读取和发送都实时打到你的邮件服务商，智能体拿到后就立即丢弃。

这是一份快速指南。在下面选择你的邮件服务商，跟着四到五个步骤走，你就能让 Claude（或者 Cursor，或者一个自定义脚本）读取和发送真实邮件，所花的时间大约只够你把这一段读两遍。如果想看更深入的“这是什么、安不安全”版本，请从[让 AI 智能体访问邮箱的完整指南](/blog/how-to-give-your-ai-agent-email-access)开始。

## 每个服务商都共有的一步：连接你的客户端

在动手连接服务商之前，先决定你的 AI 智能体如何与 MCP Emails 通信。有两条路径，它们都使用同一个 endpoint 和同一套工具。

**路径 A——OAuth 客户端（claude.ai、Claude Desktop、Cursor）。** 不需要 API 密钥。你粘贴一个 URL 并批准一次登录：

1. 在 claude.ai 中，进入 **Customize → Connectors → Add connector**。
2. 粘贴 endpoint：\`https://www.mcpemails.com/api/mcp\`
3. 点击 **Connect**，登录你的 MCP Emails 账户，并批准你想要的权限范围（\`read:email\`、\`send:email\`，或者两者都要）。

客户端这边就这些了。令牌严格限定在你批准的范围内，而且你可以在控制台一键撤销连接。如果想把利弊讲清楚，请看 [OAuth 与 API 密钥在 AI 邮件访问中的对比](/blog/oauth-vs-api-keys-ai-email-access)。

**路径 B——API 密钥客户端（Cline、JetBrains、cURL、自定义智能体）。** 适用于任何不内置 OAuth 的工具：

1. 进入 **Dashboard → API Keys** 并创建一个密钥。
2. 选择它的权限范围（\`read:email\`、\`send:email\`）。
3. 复制一次（它只显示一次），并作为请求头传入：\`Authorization: Bearer <your-api-key>\`，同样打到 \`https://www.mcpemails.com/api/mcp\`。

如果你常驻在编辑器里，[为 Cursor、Cline 和 VS Code 配置邮件](/blog/email-for-ai-agents-cursor-cline-vscode)从头到尾覆盖了这条路径。

现在来连接邮箱。下面每个服务商的起点都一样：**Dashboard → Inboxes → Connect Inbox**，然后选择你的服务商。

## 逐个连接服务商

### Gmail（OAuth）

其中最快的一个，因为活儿都让 Google 干了。

1. **Dashboard → Inboxes → Connect Inbox → Gmail。**
2. 你会被转到 Google 的登录页。选择账户。
3. 在授权页面上批准读取和发送权限。
4. 你会回到控制台，邮箱已连接。完成。

整个过程从不交换密码。MCP Emails 持有一个加密的 OAuth 令牌，直接调用 Gmail API。搜索使用 Gmail 的原生操作符（\`from:\`、\`is:unread\`、\`after:\`），所以你的智能体可以非常精确。

### Outlook / Microsoft 365（OAuth）

形式和 Gmail 一样，只是换了身份提供商。

1. **Dashboard → Inboxes → Connect Inbox → Outlook / Microsoft 365。**
2. 在 Microsoft 的页面上用你的 Microsoft 账户登录。
3. 批准权限。
4. 邮箱显示为已连接。发送通过 Microsoft Graph 发出，所以这是一封从你自己账户发出的普通邮件。

如果你的租户有条件访问或管理员同意规则，[Outlook 与 Microsoft 365 配置指南](/blog/connect-outlook-microsoft-365-ai-agent-mcp)会带你走一遍管理员侧的那些坑。

### iCloud（应用专用密码）

iCloud 不向第三方提供 OAuth，所以你要生成一个应用专用密码。这会多花一分钟。

1. 前往 [appleid.apple.com](https://appleid.apple.com)，登录后打开 **Sign-In and Security** 部分。
2. 在 **App-Specific Passwords** 下创建一个新密码，并将其命名为“MCP Emails”。
3. 复制生成的密码（它的形式类似 \`xxxx-xxxx-xxxx-xxxx\`）。
4. 在 **Dashboard → Inboxes → Connect Inbox → iCloud** 中，输入你的 iCloud 地址并粘贴那个应用密码。

iCloud 底层走 IMAP/SMTP，所以你能用到和其他人完全相同的工具集。

### Fastmail（应用专用密码——不是 OAuth）

如果你读过旧文档，这里有一个快速纠正：**Fastmail 用应用密码连接，而不是 OAuth。** 别去找什么“用 Fastmail 登录”的按钮——这里没有。

1. 在 Fastmail 中，打开 **Settings → Privacy & Security → Integrations**（或 **App Passwords**）。
2. 创建一个新的应用密码。给它邮件（IMAP/SMTP）访问权限，并命名为“MCP Emails”。
3. 复制 Fastmail 生成的密码。
4. 在 **Dashboard → Inboxes → Connect Inbox → Fastmail** 中，输入你的 Fastmail 地址并粘贴。

就这样——从智能体的角度看，Fastmail 的表现和其他 IMAP 服务商完全一致。

### 通用 IMAP（Yahoo、Zoho、Yandex 等等）

任何支持 IMAP/SMTP 的服务都能通过同一个连接器接入。流程和 iCloud、Fastmail 完全相同：在你的服务商那里生成一个应用密码，然后粘贴进来。

1. 在你的服务商的安全设置里，创建一个**应用密码**（Yahoo、Zoho 和 Yandex 都把它藏在账户安全里）。要用真正的应用密码，而不是你的登录密码——反正现在大多数服务商也已经屏蔽了用普通密码登录 IMAP。
2. **Dashboard → Inboxes → Connect Inbox → IMAP。**
3. 输入你的邮箱地址和应用密码。MCP Emails 会自动检测常见的服务器；如果你的比较特殊，就填入你服务商列出的 IMAP 和 SMTP 主机/端口。
4. 保存。邮箱即连接完成，随时可用。

关于 iCloud、Fastmail 以及那一长串 IMAP 主机各自的特殊之处，[iCloud、Fastmail 与 IMAP 深度解析](/blog/connect-icloud-fastmail-imap-to-claude)是排查问题的参考资料。

## 第一次调用：先发现，再行动

不管你选了哪个服务商，智能体的第一步永远一样。让它调用 \`inbox_list\` 来发现有哪些邮箱已连接，并取得每个邮箱的 \`inbox_id\`——智能体从不去复制粘贴 UUID。从这里开始，它使用一小组整合后的工具：\`email_read\`（\`action\` 取 \`list\`、\`read\` 或 \`search\`）、\`email_compose\`（\`send\`、\`reply\` 或 \`forward\`），以及用于移动、标记和归档的 \`email_organize\`，再加上 \`folder\`、\`draft\`、\`schedule\` 和 \`contact_search\`：

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose",
    "email_organize"
  ]
}
\`\`\`

一个不错的冒烟测试：让你的智能体“总结我最近的三封未读邮件”。它会先运行 \`inbox_list\`，然后带上 \`action: "list"\` 和 \`unread_only: true\` 运行 \`email_read\`，再对每一封带上 \`action: "read"\` 运行 \`email_read\`。如果这能跑通，你的连接就已经生效了。

有一个值得先讲明白的实话提醒：MCP Emails 是基于轮询的。没有 webhook，也没有推送事件，所以智能体是按计划定期检查来对新邮件做出反应，而不是被实时通知。对大多数工作流来说这才是正确的模型，[收件箱分类与摘要](/blog/ai-agent-triage-summarize-inbox)的那些模式也正是这么工作的。

## 为什么可以放心地快速完成

这里的快不是靠在安全上偷工减料换来的。邮件在每次调用时实时获取、从不存储——正文、主题和附件交给智能体后会立即丢弃。每个邮箱唯一被持久化的东西，是你的 OAuth 令牌或应用密码，它用 AES-256-GCM 加密，只在调用时于一个隔离的函数内部被解密。发送始终经由你自己的服务商，所以你的域名信誉依旧属于你。如果想了解架构细节，请阅读[为什么“邮件从不存储”真的很重要](/blog/why-email-never-stored-matters)。

## 总结

整件事就这么简单：一次邮箱连接、一个 endpoint、寥寥数个工具。每一种套餐对邮箱、调用次数和密钥都是无限量，而 Free 套餐分文不取、无需绑卡——如果你需要更高的突发限额或 SSO，去看看[价格](/pricing)。准备好试一试了吗？[免费开始](/signup)，连接你的邮箱，把 endpoint 粘贴进你的智能体。`,
};
