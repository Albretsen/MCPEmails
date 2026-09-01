const translation = {
  title: '如何让 AI 智能体访问邮箱（2026 完整指南）',
  description:
    '通过 MCP 让你的 AI 智能体读取并发送真实邮箱的邮件——支持 Gmail、Outlook、iCloud、Fastmail 或 IMAP。原理、工具、安全机制与配置一文讲清。',
  coverAlt: '如何通过 MCP 让你的 AI 智能体访问邮箱——MCPEmails',
  content: `要让 AI 智能体访问邮箱，你需要把邮箱连接到一台 MCP 服务器，再把智能体指向一个端点 URL。智能体随后就能拿到一小组工具，用来读取、搜索和发送邮件。难点其实不在智能体本身——而在于如何做到这一点，又不让你的密码泄露到提示词、日志或向量库里。这"最后一公里"正是本指南要讲的内容。

如果你只想走最快的路径：在仪表盘里连接一个邮箱，把 MCP 端点粘贴到 [claude.ai](https://claude.ai)、Claude Desktop、Cursor 或你自己的智能体里，然后先调用一次 \`inbox_list\`。本文余下部分会解释背后实际发生了什么、为什么安全模型至关重要，以及如何接入每一个受支持的服务商。

## "通过 MCP 收发邮件"到底意味着什么

[Model Context Protocol](https://modelcontextprotocol.io) 是一种通过 HTTP 向语言模型暴露工具的标准方式。一台 MCP 邮件服务器不会把你的邮箱当作原始 IMAP 暴露出来，而是呈现为智能体可以调用的几个带类型的动词：列出邮件、读取某封、搜索、发送、回复。智能体围绕这些动词进行推理。它从不接触底层的邮箱协议，也从不看到你的凭据。

这正是 [MCP Emails](/) 的核心理念。一个端点，一组工具，适配任何兼容 MCP 的客户端。如果你想从头理解整个架构，配套文章 [什么是 MCP 邮件服务器](/blog/what-is-an-mcp-email-server) 用通俗的语言做了讲解。

## 为什么"最后一公里"这么难

把模型接到邮箱看上去稀松平常，真正动手做时才会发现没那么简单。有三件事会让你头疼：

1. **每个服务商的鉴权方式都不一样。** Gmail 需要带特定 scope 的 OAuth。Outlook 需要 Microsoft 身份认证。iCloud 和 Fastmail 需要专用应用密码。每一种都有自己的 token 刷新周期，也有各自的失败模式。
2. **凭据是高危品。** 一个躺在聊天记录或日志行里的邮箱密码，就是一次随时会引爆的数据泄露。你不能让模型持有这个密钥。
3. **邮件的结构对智能体很不友好。** MIME、线程头、HTML 与纯文本之争、附件、其实是标签的文件夹。模型需要的是干净的响应，而不是 RFC 5322。

那种最朴素的 DIY 做法——丢给模型一个 IMAP 库再加上你的密码——这三关一关都过不了。GitHub 上大多数"Gmail MCP 服务器"仓库恰恰就止步于此。

## MCP Emails 是如何解决的

四个设计决策挑起了大梁。它们正是我敢用它来管自己邮箱的原因。

### 邮件实时拉取，从不存储

每一次工具调用都会实时打到你的服务商：Gmail API、Microsoft Graph 或 IMAP/SMTP。邮件正文、主题和附件交给智能体后即刻丢弃。没有任何东西被缓存、建索引或落库存档。每个邮箱唯一被持久化的，只有发起下一次调用所需的凭据。如果你想看为什么这一点很重要的详细版本，请读 [为什么"邮件从不存储"很重要](/blog/why-email-never-stored-matters)。

### 凭据以 AES-256-GCM 静态加密

每个邮箱的 OAuth token 或应用密码在写入数据库之前都会先加密。解密只在一个隔离的 Edge Function 内部、于调用时进行，使用的密钥作为环境密钥存放，与数据库相互独立。所以即便数据库泄露，攻击者拿到的也只是密文，而不是你的邮箱。

### 发送走你自己的服务商

当智能体发送或回复时，邮件是通过你的 Gmail、你的 Microsoft 365 或你的 SMTP 服务器发出去的。MCP Emails 从不用自己的域名做中转。你的送达率和域名信誉完全归你所有——不必再玩共享 IP 那种"进不进垃圾箱看运气"的轮盘赌。

### 它就是基于 HTTP 的标准 MCP

服务器按照 MCP 2025-06-18 规范说 Streamable HTTP。无需安装 SDK，无需自定义客户端。任何会说 MCP 的东西都能直接接入。

## 你的智能体能拿到哪些工具

一小组整合后的、基于动作（action）的工具覆盖了全部能力面：读取、撰写、整理，另有若干用于文件夹、定时和联系人的工具。智能体总是先调用 \`inbox_list\` 来发现连接了哪些账户、并取得每个邮箱的 ID——它从不把 UUID 写死在代码里。

- \`inbox_list\` —— 发现已连接的账户及其能力
- \`email_read\`（动作 \`list\`）—— 分页、按最新优先、按邮箱列出
- \`email_read\`（动作 \`read\`）—— 解析后的纯文本，可选经过净化的 HTML，可选附件
- \`email_read\`（动作 \`search\`）—— 服务商原生语法（Gmail 操作符、Outlook KQL、IMAP 文本搜索）
- \`email_compose\`（动作 \`send\`）—— 撰写邮件，支持 CC/BCC、HTML 以及总计不超过 10 MB 的附件
- \`email_compose\`（动作 \`reply\`）—— 同上，并且会替你设置好线程头（In-Reply-To、References）
- \`email_organize\` —— 移动、删除、标记或归档（每次调用一个动作）

有一个值得开门见山说清楚的局限：这是**轮询，而非推送**。没有 webhook。要对新邮件做出反应，你的智能体需要按计划轮询，例如带 \`unread_only: true\` 的 \`email_read\`（动作 \`list\`）。你搭建的任何自动回复器都靠定时器运转，而不是即时触发。[自动回复器搭建指南](/blog/build-email-auto-responder-mcp-agent) 展示了如何把这件事做好。

一次早间整理流程读起来是这样的：

\`\`\`json
{
  "step1": "inbox_list                  → finds your work Gmail",
  "step2": "email_read (action list)    → last 24h, unread_only",
  "step3": "email_read (action read)    → full body for anything urgent",
  "step4": "email_compose (action reply) → draft, or just summarize and wait"
}
\`\`\`

没有任何密码在网络上传输过。智能体持有的是能力，而非凭据。想要更多点子，可以看 [AI 智能体拥有邮箱权限后能做的 7 件事](/blog/7-things-ai-agent-can-do-with-inbox-access) 以及更深入的 [整理与摘要收件箱实战](/blog/ai-agent-triage-summarize-inbox)。

## 受支持的服务商及各自的连接方式

你只需在 **Dashboard → Inboxes → Connect Inbox** 里把邮箱连接一次。具体如何鉴权取决于服务商。

### OAuth 服务商（一键搞定）

- **Gmail** —— 通过 Google 登录走 OAuth 2.0。
- **Outlook / Microsoft 365** —— 通过 Microsoft 登录走 OAuth 2.0。配置细节见 [将 Outlook 和 Microsoft 365 连接到 AI 智能体](/blog/connect-outlook-microsoft-365-ai-agent-mcp)。

### 应用密码服务商

iCloud、Fastmail、Yahoo、Zoho、Yandex 以及任何通用 IMAP 邮箱，都用专用应用密码而非 OAuth 来连接。你在服务商的安全设置里生成密码，再粘贴到 MCP Emails 中。iCloud 密码来自 appleid.apple.com；Fastmail **只支持应用密码**（在 Fastmail 设置里创建一个）。它们都跑在同一套 IMAP/SMTP 传输之上，共享一套完全相同的功能集。完整教程见 [将 iCloud、Fastmail 或任意 IMAP 邮箱连接到 Claude](/blog/connect-icloud-fastmail-imap-to-claude)。

## 连接你的 AI 客户端

同一个端点、同一组工具，根据你的客户端是否会说 OAuth，有两种接入方式。

### 支持 OAuth 的客户端（无需 API key）

claude.ai、Claude Desktop、Cursor 等同类客户端，通过 OAuth 2.0 授权码 + PKCE 以及 RFC 7591 动态客户端注册来连接。在 claude.ai 里依次是 **Customize → Connectors → Add connector**，粘贴 MCP 端点 URL，点击 Connect，登录你的 MCP Emails 账户，然后授权。Token 的范围严格限定在你所批准的内容上：\`read:email\`、\`send:email\` 或两者皆有。

### 不支持 OAuth 的客户端（API key）

Cline、JetBrains、自定义脚本以及裸 cURL 使用带 scope 的 API key。在 **Dashboard → API Keys** 里创建一个，挑选它的 scope，然后复制（它只会显示一次）。以 \`Authorization: Bearer <api-key>\` 的形式传入。这些客户端的完整配置见 [在 Cursor、Cline 和 VS Code 中为 AI 智能体接入邮件](/blog/email-for-ai-agents-cursor-cline-vscode)，两种方式之间的取舍则在 [AI 邮件访问：OAuth 与 API key 之争](/blog/oauth-vs-api-keys-ai-email-access) 中有详述。

无论哪种方式，你都可以在仪表盘里一键吊销任意连接。请从 [文档](/docs) 里取得准确的端点 URL——直接从那里复制，别手动敲。

## 这样安全吗？以及速率限制

简短的回答：安全，而 [让 AI 智能体访问邮箱安全吗](/blog/is-it-safe-to-give-ai-agent-email-access) 这篇文章把完整的论证讲透了。模型持有的是受限的能力，而不是你的密码；凭据经过加密；什么都不存储；发送始终留在你自己的服务商；访问权一键即可吊销。

关于速率限制，在所有套餐上，每个 API key 都被限制在每分钟 100 次请求、每小时 1,000 次、每天 10,000 次。此外还有一个按工作区计算的突发上限，会随你的套餐递增：免费版为 60/min，Personal 为 120/min，Pro 为 300/min，Team 为 1,000/min。当你触及上限时，服务器会返回一个可重试的错误，并附带一个以秒为单位的 \`retry_after\` 值。请遵守它。另外，绝不要盲目地自动重试 \`email_compose\` 的发送，那样你会发出重复邮件。

## 价格

套餐按连接的收件箱数量定价。API key 在所有档位都不限量，各档之间还在突发速率、分析数据保留时长、团队功能和技术支持上有差别。

- **免费版，永久 $0。** 无需信用卡。一个已连接收件箱，60 req/min，30 天分析数据，社区支持。
- **Personal，每月 5 美元**（或每年 48 美元，合每月 4 美元）。最多连接三个收件箱，120 req/min，30 天分析数据，邮件支持。
- **Pro，每月 15 美元**（或每年 144 美元，合每月 12 美元）。无限量连接收件箱，300 req/min，90 天分析数据，邮件支持。
- **Team，每月 79 美元**（或每年 756 美元，合每月 63 美元）。包含 Pro 的全部内容，另加带角色的成员、每个客户或业务一个独立工作区、支持 SAML/OIDC 的 SSO 外加审计日志，1,000 req/min，1 年分析数据，优先支持。

完整明细见 [价格页面](/pricing)。

## 开始上手

连接一个邮箱，把端点粘贴进你的智能体，然后调用 \`inbox_list\`。整个上手过程就这么多。[免费开始](/signup) 或浏览一下 [快速上手](/docs#quickstart)——几分钟内你就能让一个智能体读取真实的邮件了。`,
};

export default translation;
