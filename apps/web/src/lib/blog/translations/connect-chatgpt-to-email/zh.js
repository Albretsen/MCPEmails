const translation = {
  title: '用 MCP 把 ChatGPT 连接到你的邮箱（Gmail、iCloud 和 IMAP）',
  description:
    '分步指南：用自定义 MCP 连接器把 Gmail、iCloud、Fastmail 或任意 IMAP 收件箱接入 ChatGPT，并用受限密钥接入 OpenAI Codex。不存储任何邮件。',
  coverAlt:
    '使用 MCP Emails 将 ChatGPT 和 OpenAI Codex 连接到 Gmail、iCloud、Fastmail 与 IMAP 邮箱',
  content: `ChatGPT 无法自行访问邮箱。它需要在你的邮件前面有一台 MCP 服务器，而 MCP Emails 就是这台服务器：连接一次收件箱，把 ChatGPT 指向一个 URL，无论邮件存放在 Gmail、iCloud、Fastmail、Yahoo、Zoho 还是自建的 IMAP 服务器上，它拿到的都是同一套邮件工具。

这里涉及两个 OpenAI 平台，它们的认证方式不同。ChatGPT 在浏览器里走 OAuth 流程，所以没有 API 密钥需要粘贴。OpenAI Codex 运行在终端里，因此改用一个受限的 bearer 密钥。端点相同，工具相同。

## 你需要准备什么

- **网页版的 ChatGPT Plus、Pro、Business、Enterprise 或 Edu。** 自定义 MCP 连接器位于开发者模式之后，OpenAI 在 chatgpt.com 上向这些方案提供该模式。Free 和 Go 账户无法添加，移动端和桌面端应用也不显示该选项。在 Business 和 Enterprise 上，可能需要管理员先允许开发者模式。
- **一个免费的 MCP Emails 账户。** [在此创建](/signup)。免费方案可连接一个收件箱，无需信用卡。
- **一个邮箱。** Gmail、Outlook 或 Microsoft 365、iCloud、Fastmail、Yahoo、Zoho、Yandex，或任何支持 IMAP 与 SMTP 的邮箱。

如果你使用的是 Free 或 Go，同一个邮箱和同一个 URL 已经可以在 [Claude](/docs/claude)、[Cursor](/docs/cursor)、[VS Code](/docs/vscode) 以及其他[支持的客户端](/docs/clients)中使用。

## 第 1 步：把收件箱连接到 MCP Emails

在 MCP Emails 控制台中，打开 **Inboxes**，再点 **Connect Inbox**，然后选择你的服务商。

### Gmail 与 Google Workspace

Gmail 默认通过 Google 应用专用密码以 IMAP 方式连接，同时也支持 Google OAuth 登录。如果 Workspace 管理员限制了第三方应用访问，请使用应用专用密码。[Gmail 操作指南](/blog/connect-gmail-to-claude)列出了具体步骤。

### iCloud、Fastmail、Yahoo 与 Zoho

这些服务商要求应用专用密码，而不是你在网页上输入的登录密码。先在服务商处生成一个，在 MCP Emails 中选择对应服务商，然后粘贴进去。[iCloud、Fastmail 与 IMAP 指南](/blog/connect-icloud-fastmail-imap-to-claude)给出了准确步骤。

### Outlook 与 Microsoft 365

Outlook 通过使用 Microsoft 登录连接，而不是应用专用密码：选择 **Outlook**，点击**使用 Microsoft 连接**并批准。个人 Outlook.com、Hotmail、Live 和 MSN 账户可以直接连接。工作或学校的 Microsoft 365 账户可能需要 IT 管理员先为整个组织一次性批准该应用；控制台会给你一个可以发给管理员的链接。详情见 [Outlook 与 Microsoft 365 指南](/blog/connect-outlook-microsoft-365-ai-agent-mcp)。

### 其他任意 IMAP 邮箱

选择 **IMAP**，填入邮箱地址和应用专用密码。常见设置会被自动识别；自定义域名可能需要你从服务商处获取主机、端口和加密方式。[服务商对照表](/docs/providers)列出了每家支持的功能，[connect](/connect) 下每家服务商还有独立页面，包括 [Gmail](/connect/gmail)、[iCloud](/connect/icloud) 和[通用 IMAP](/connect/imap)。

如果你的方案允许，可以连接多个邮箱。ChatGPT 会通过 \`inbox_list\` 发现它们，所以你永远不需要把邮箱 id 粘进提示词里。

## 第 2 步：在 ChatGPT 中添加连接器

1. 在 ChatGPT 设置中打开**开发者模式**，位置在应用与连接器的高级设置里。
2. 新建一个连接器并为它命名。
3. 粘贴这个连接器 URL：

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. 认证方式选择 **OAuth**，创建连接器，然后用 MCP Emails 完成授权。
5. 打开一个新对话，点击 **+**，选择 **Developer mode** 并选中 MCP Emails 应用。ChatGPT 只在完成这一步的对话中看得到这些工具，所以每个新对话都要重复。

请选择 OAuth，不要选"无需认证"。本服务器会拒绝匿名调用，因此一个在创建时未配置认证的连接器，设置阶段看起来一切正常，却会在第一次工具调用时失败，这种先后顺序最容易让人困惑。使用 OAuth 时，ChatGPT 会自行注册并完成带 PKCE 的授权码流程：不需要创建 client id，任何地方都不需要客户端密钥。OpenAI 在测试期间会不断调整菜单措辞，因此请查看 [ChatGPT 设置页](/docs/chatgpt)获取当前路径。

## 第 3 步：只授予你需要的权限

同意授权页面来自我们，而不是 OpenAI。首次授权从 \`read:email\` 开始，这已经足以做分拣、摘要和查找，并且在你决定要放开多少权限之前，它把所有不可撤销的操作都排除在外。其他权限分别是 \`send:email\`、\`search:email\` 和 \`manage:automations\`。

授权给得太少是可以补救的：当某次调用需要令牌所缺的权限时，会返回 403 和一个权限不足的错误，客户端可以针对该权限重新请求授权并重试。收件箱所有者还可以在控制台中要求[人工审批](/blog/approve-ai-agent-email-sends)，它会把每一次发送、回复、转发、草稿发送和定时发送都扣住，直到有人放行。

## 第 4 步：给 ChatGPT 一个安全的首个任务

从只读开始：

> 总结我最新的三封未读邮件，并标出今天需要回复的内容。不要发送、移动或删除任何东西。

ChatGPT 会先找到收件箱，然后只读取它需要的邮件。这一步跑通后，可以再试试：

- "找到上个月来自 Stripe 的账单，并告诉我金额。"
- "给 Alex 最新的那封邮件写一份回复，但只存为草稿。"
- "列出本周可以归档的新闻订阅邮件，等我确认后再处理。"

如果要做可复用的例行流程，可以从[收件箱分拣手册](/blog/ai-agent-triage-summarize-inbox)或[工作流提示词合集](/blog/ai-agent-email-workflows-and-prompts)开始。

## 连接完成后 ChatGPT 能做什么

MCP Emails 交给 ChatGPT 的是一组聚焦的邮件工具，而不是一个密码或一条原始的 IMAP 连接：

- **读取与搜索：** \`email_read\` 涵盖 list、read、read_batch、search 和 attachment。Gmail 搜索支持 \`from:\`、\`is:unread\` 等操作符。
- **发送、回复与转发：** \`email_compose\` 通过你自己的服务商和地址发送。
- **整理：** \`email_organize\`、\`email_search_and_move\` 和 \`email_delete\`。
- **草稿、文件夹与定时：** \`draft\`、\`draft_list\`、\`folder\`、\`folder_list\`、\`schedule\` 和 \`schedule_list\`。
- **其余：** \`contact_search\`、\`signature_get\`、\`signature_set\`，以及用于周期性规则的 \`automation\` 和 \`automation_read\`。

有一个限制需要提前考虑：MCP Emails 基于轮询。没有 webhook，也没有服务器主动发起的事件，所以 ChatGPT 只在你要求时才去查看新邮件，而不是邮件一到就知道。

## 终端里的 OpenAI Codex

Codex 与 ChatGPT 连接器是不同的平台，浏览器 OAuth 流程在这里不适用。终端客户端改用 bearer 令牌认证：

1. 在控制台中打开 **API Keys** 并创建一个密钥。只勾选这个智能体确实需要的权限。
2. 立即复制密钥。它形如 \`mcpe_\` 后跟 64 位十六进制字符，并且只显示一次。
3. 在 Codex 自己的 MCP 服务器配置中，把 \`https://mcpemails.com/api/mcp\` 注册为可流式传输的 HTTP MCP 服务器，并通过 \`Authorization: Bearer\` 请求头传入该密钥。

密钥连接与 OAuth 连接访问的是同一个端点，看到的也是同一份工具清单。唯一的区别在于令牌从哪里来。如果想先验证端点，[原始 HTTP 指南](/docs/curl)提供了一行 \`tools/list\` 调用，而 [OAuth 与 API 密钥的对比](/blog/oauth-vs-api-keys-ai-email-access)解释了两条路径各自适用的场景。

请把密钥权限收紧。对编码智能体来说，只读通常是正确的选择：一个能总结支持工单的智能体很有用，一个能在无人看管时发邮件的智能体则属于完全不同的风险等级。

## 常见问题排查

- **没有创建自定义连接器的选项。** 开发者模式需要在浏览器中使用 chatgpt.com，并且是 Plus、Pro、Business、Enterprise 或 Edu。Free 和 Go 账户没有该模式。在 Business 或 Enterprise 工作区中，需要管理员允许。
- **连接器在第一次工具调用时失败。** 它多半是在未配置认证的情况下创建的。删除它，用 OAuth 重新创建。
- **连接器已创建，但 ChatGPT 回答时没有读取你的邮件。** 它在这个对话中没有开启。点击 **+**，选择 **Developer mode** 并选中 MCP Emails 应用，然后再问一次。
- **服务商拒绝你的密码。** 请使用服务商生成的应用专用密码，而不是网页登录密码。部分服务商只有在开启双重验证后才会签发。
- **自定义 IMAP 连接超时。** 确认主机、端口和 TLS 模式。993 端口通常使用隐式 TLS，143 端口通常使用 STARTTLS。
- **ChatGPT 连上了却看不到邮件。** 检查该收件箱在控制台中是否处于启用状态，确认连接拥有 \`read:email\` 权限，并让 ChatGPT 先调用 \`inbox_list\`。

## 常见问题

**ChatGPT 能读取并发送我的邮件吗？**
通过自定义 MCP 连接器可以：读取、搜索、发送、回复、转发、整理和定时发送，全部受限于你在设置时批准的权限范围。

**用 ChatGPT 需要 API 密钥吗？**
不需要。选择 OAuth，ChatGPT 会自行注册并完成流程。API 密钥面向无法运行浏览器流程的客户端，例如 Codex 和脚本。

**Codex 的设置方式相同吗？**
不同。Codex 是终端平台，所以它用 \`Authorization: Bearer\` 请求头里的受限 API 密钥，而不是浏览器 OAuth 流程。端点相同，工具相同。

**我的邮件会存在你们的服务器上吗？**
不会。每封邮件都是为发起该请求的那次调用从你的服务商实时获取，随后即被丢弃。只有加密后的服务商凭据会被保留。[为什么"不存储邮件"很重要](/blog/why-email-never-stored-matters)解释了背后的理由。

**价格是多少？**
免费方案包含一个已连接收件箱，以及每个 UTC 自然月 150 次计费邮件操作，前 7 天不计入。该月度上限适用于 2026 年 9 月 13 日及之后创建的工作区，更早创建的工作区不受此限制。Personal 每月 $5，可连接 3 个收件箱，没有月度操作上限；Pro 每月 $15，收件箱数量不限。详见[价格](/pricing)。

## 下一步

[免费开始](/signup)，连接一个收件箱，把 \`https://mcpemails.com/api/mcp\` 添加到 ChatGPT，然后让它总结你的未读邮件。[ChatGPT 设置页](/docs/chatgpt)有当前的操作路径，[文档](/docs)提供完整的工具参考。`,
};

export default translation;
