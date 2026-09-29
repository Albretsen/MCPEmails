const translation = {
  title: '在 Claude 和 ChatGPT 中使用多个邮箱账户：所有邮箱，一个连接器',
  description:
    '如何同时把多个邮箱账户接入 Claude 和 ChatGPT，包括放在 IONOS、Zoho、Namecheap、Google Workspace 或你自己服务器上的公司邮箱，只需一个在两者中都能用的 MCP 连接器。',
  coverAlt:
    '多个工作和个人邮箱账户通过一个 MCP 连接器接入 Claude 和 ChatGPT',
  content: `你希望只问一个问题，就能在你管理的每个邮箱里得到答案：你自己的地址、info@、sales@、收发票的邮箱，也许还有一个个人 Gmail。本指南介绍如何同时把多个邮箱账户接入 Claude 和 ChatGPT，内置连接器已经能做到什么，以及在哪些情况下你需要改用 MCP 服务器。

## 内置连接器能做什么

两个助手都自带邮件连接器，而且更新得很快，下面是撰写本文时（2026 年 9 月）的情况。

- **ChatGPT。** 自 2026 年 8 月下旬起，它自己的 Gmail、Google Calendar 和 Google Contacts 插件在 Plus、Pro、Business 和 Enterprise 上可以添加多个账户，所以个人 Gmail 和工作 Gmail 可以出现在同一个对话里。9 月，OpenAI 把多账户支持扩展到了其他插件。如果你的每个邮箱都是 Google 账户，ChatGPT 自己的插件可能就够用了。
- **Claude。** Anthropic 的帮助中心说明，Gmail 连接器访问的是 "the Google account you've connected"。每个连接只对应一个 Google 账户。

两者都不是为这类邮箱设计的：公司在自己域名上实际使用、但域名不在 Google 或 Microsoft 上的邮箱，例如 IONOS、Zoho Mail、Namecheap Private Email、STRATO、Migadu、cPanel 主机或你自己的服务器。这些邮箱使用 IMAP 和 SMTP，要访问它们，就需要一个支持 IMAP 的工具。

## 一个连接器，接入所有邮箱

MCP Emails 是一个托管 MCP 服务器。你把每个邮箱连接到它一次，你的 AI 客户端就能通过一个 URL 访问所有邮箱：

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **服务商可以任意组合。** Gmail 和 Google Workspace（应用专用密码或使用 Google 登录）、Outlook 和 Microsoft 365（使用 Microsoft 登录）、iCloud、Fastmail、Yahoo、Zoho、Yandex，以及任何支持 IMAP 和 SMTP 的邮箱。[connect](/connect) 下每家服务商都有独立页面，包括 [IONOS](/connect/ionos)、[Zoho Mail](/connect/zoho)、[Namecheap](/connect/namecheap)、[STRATO](/connect/strato)、[Migadu](/connect/migadu)、[Google Workspace](/connect/google-workspace) 和 [Microsoft 365](/connect/office365)。
- **两个助手用的是同一批邮箱。** 它是标准的 MCP 服务器，所以同一个连接既能在 Claude 中使用，也能在 ChatGPT 中使用，Cursor、VS Code 和其他 MCP 客户端同样可以。邮箱只需添加一次，每个客户端都能看到。
- **智能体知道哪个邮箱是哪个。** 它会调用 \`inbox_list\`，拿到每个已连接地址及其显示名称。其他每个工具都会指明它操作的是哪个邮箱，所以你只需用日常语言说“在 sales@ 里”就行。
- **回复从正确的地址发出。** 每个邮箱都通过自己的服务商或 SMTP 服务器发信，使用自己的发件人名称和签名。在 support@ 里回复一个邮件线程，回复就从 support@ 发出。

每次请求都会实时获取邮件，不做存储。唯一的例外是你安排稍后发送的邮件，它会保留到发出为止。

## 连接邮箱

在 MCP Emails 控制台中，打开 **Inboxes**，再点 **Connect Inbox**，每个邮箱操作一次：

- **使用自己域名的公司邮箱。** 选择 **IMAP** 并输入地址。常见的主机会根据地址自动识别，Google Workspace 域名则通过它的邮件记录识别，所以设置会自动填好。请使用你的主机要求的密码或应用专用密码。
- **Gmail 或 Google Workspace。** 使用应用专用密码，或使用 Google 登录。在 Workspace 上，是否允许应用专用密码和 IMAP 由你的管理员决定。
- **Outlook 或 Microsoft 365。** 使用 Microsoft 登录。工作或学校账户可能需要 IT 管理员为整个组织批准一次该应用。

给每个邮箱起一个清楚的显示名称，比如“Acme Sales”，而不是“work2”。智能体靠它区分各个邮箱，收件人看到的也是这个名称。

## 添加到 Claude

在 claude.ai 或 Claude Desktop 中：

1. 打开 **Settings**，再打开 **Connectors**。
2. 选择 **Add custom connector**，粘贴 \`https://mcpemails.com/api/mcp\`。
3. 选择 **Connect**，登录 MCP Emails 并批准。

你连接的每个邮箱现在都可以使用了。详细步骤见 [Claude 指南](/blog/connect-claude-to-email)。

## 添加到 ChatGPT

自定义连接器需要网页版的 ChatGPT Plus、Pro、Business、Enterprise 或 Edu，并开启开发者模式。在 Business 和 Enterprise 上，可能需要管理员先允许。

1. 在 ChatGPT 设置中打开**开发者模式**，位置在应用与连接器的高级设置里。
2. 新建一个连接器，粘贴 \`https://mcpemails.com/api/mcp\`，认证方式选择 **OAuth**，然后用 MCP Emails 完成授权。
3. 在每个新对话中，点击 **+**，选择 **Developer mode** 并选中 MCP Emails 应用。

[ChatGPT 指南](/blog/connect-chatgpt-to-email)介绍了各个菜单和常见错误。

## 跨多个邮箱的提示词

> 查看 sales@ 和 info@，列出本周所有还没人回复的询问。合并成一份列表，并标注每条来自哪个邮箱。不要发送或移动任何邮件。

> 找到 Hetzner 八月份的发票。在每个已连接的邮箱中搜索，并告诉我它在哪个邮箱里。

> 用 support@ 起草一封回复，回应最新的一条配送投诉。发送前先给我看。

一次调用只能到达一个邮箱，所以“搜索所有邮箱”实际上是智能体在每个邮箱里各搜索一次，再把结果合并起来。请要求它给出一份合并列表，否则你会得到每个账户各一份报告。[用 AI 管理多个邮箱账户](/blog/manage-multiple-email-accounts-with-ai)更深入地介绍了如何限定范围、发件人身份以及按邮箱设置的审核。

## 让人来按发送键

为任意邮箱开启**发送前审核**（Review before sending），该邮箱的每一次发送、回复、转发、草稿发送和定时发送，都会在控制台中等待你的批准。它是按邮箱设置的，所以可以扣下收发票的邮箱，同时让你自己的邮箱自由发送。所有套餐都包含这项功能，免费版也不例外。参见[AI 邮件发送的人工批准](/blog/approve-ai-agent-email-sends)。

## 每个套餐能连接多少个邮箱

- **免费版：** 一个邮箱。
- **Personal：** 三个邮箱。
- **Pro：** 你管理的所有邮箱，数量不限，只需一个登录账号。
- **Team：** 适用于第二个人需要自己的登录账号的情况。

一家公司有 info@、sales@ 和 invoices@，再加上你自己的地址，就是四个邮箱，对应 Pro。当前价格见[价格页面](/pricing)，[面向企业的 MCP Emails](/for/business) 介绍了一个人如何用一个智能体管理公司的所有邮箱。

## 常见问题

**Claude 能同时使用多个邮箱账户吗？**
能，通过 MCP 服务器。把每个邮箱连接到 MCP Emails，在 Claude 中添加一个自定义连接器，Claude 就能看到所有邮箱，并在每次调用时指明所用的邮箱。

**ChatGPT 能使用多个邮箱账户吗？**
它自己的 Gmail 插件现在可以添加多个 Google 账户。对于不在 Google 上的邮箱，例如放在 IONOS、Zoho 或 cPanel 主机上的公司地址，把 MCP Emails 添加为自定义连接器，所有已连接的邮箱就都能使用。

**每个邮箱都需要单独的连接器吗？**
不需要。一个连接器 URL 就能覆盖你 MCP Emails 工作区中的所有邮箱，同一个 URL 也适用于 Claude、ChatGPT 和其他 MCP 客户端。

**回复会从正确的地址发出吗？**
会。每个邮箱都通过自己的服务商或邮件服务器发信，使用自己的显示名称和签名。要用邮箱自身以外的地址发信，只有在通过使用 Google 登录连接的邮箱上、使用已验证的 Gmail Send As 地址时才可行，其他情况一律拒绝。

**所有这些账户的邮件会被存储吗？**
不会。每次请求都会从你的服务商实时获取邮件内容，用完即丢弃。保留的只是每个邮箱加密后的凭据。参见[安全](/security)。

## 下一步

[免费开始](/signup)，先连接你最繁忙的邮箱，把 MCP Emails 连接器添加到 Claude 或 ChatGPT，然后问问今天有哪些邮件需要回复。当你想要一个答案而不是好几个时，再添加其他邮箱。`,
};

export default translation;
