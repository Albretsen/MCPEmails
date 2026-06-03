export default {
  title: '通过 MCP 将 Outlook 和 Microsoft 365 连接到你的 AI 智能体',
  description:
    '几分钟内通过 MCP 将 Outlook 或 Microsoft 365 连接到你的 AI 智能体。Microsoft 登录 OAuth，底层用 Graph，读取／搜索／发送／回复——无需自建服务器。',
  coverAlt: '通过 MCP 将 Outlook 和 Microsoft 365 连接到 AI 智能体',
  content: `> **即将推出。** Outlook 和 Microsoft 365 支持已开发完成，但尚未全面开放。目前你还无法在生产环境中连接 Outlook 邮箱——本指南预览连接器上线后的使用方式。要连接现在即可使用的邮箱，请参阅 [Gmail 和 IMAP](/docs/providers)。

要把 Outlook 或 Microsoft 365 邮箱连接到你的 AI 智能体，你只需登录 MCP Emails，用 Microsoft OAuth 添加邮箱，然后把智能体指向一个 MCP 端点即可。不用注册应用，不用进 Azure 门户，也不用自建 Graph 服务器。整个过程大约两分钟，你的智能体就能对实时邮箱进行读取、搜索、发送、回复、标记和管理文件夹。

大多数“用 AI 处理邮件”的教程都默认你用的是 Gmail，讲完就完了。Outlook 只换来一个耸肩，外加一条指向某个半荒废 GitHub 仓库的链接。如果你的工作离不开 Microsoft 365，那这就完全抓错了重点。这篇文章是以 Outlook 为主的版本：到底什么真正可用、Microsoft 登录怎么流转、底层跑的是什么，以及个人账户和工作账户之间的那些边界情况在哪里。

## 为什么 Outlook 比看上去更难（以及为什么在这里这不是你的麻烦）

Microsoft 邮件并不是单一的东西。一边是消费级的 Outlook.com／Hotmail／Live，另一边是托管在 Entra ID（这个身份服务以前叫 Azure AD）里的 Microsoft 365 工作和学校账户。它们的认证方式不同，而工作租户之上还可能叠加条件访问策略、管理员同意要求和 MFA 规则。

DIY 这条路意味着要在 Azure／Entra 门户里注册一个应用、选对受支持的账户类型、申请像 \`Mail.Read\` 和 \`Mail.Send\` 这样的 Microsoft Graph 权限、配置重定向 URI、处理令牌刷新，然后再写好用来列出、读取和发送邮件的 Graph 调用。人们为此耗掉一个下午，最后还得永远维护一个小服务器。这种事我亲眼见过。

MCP Emails 把这套注册和令牌管线在中心化的地方一次性做好，这样你就不用做了。你点一下“用 Microsoft 登录”，授权，然后就连上了。如果你想了解这一层为什么存在的概念性背景，[为你的 AI 智能体接入邮件的完整指南](/blog/how-to-give-your-ai-agent-email-access)是值得从中入门的主干文章。

## 连接你的 Outlook／Microsoft 365 邮箱

分两部分：先连接邮箱，再连接智能体。它们被刻意分开——邮箱连接授权 MCP Emails 去访问你的服务商，而智能体连接授权你的客户端去访问 MCP Emails。

### 第 1 步——添加邮箱

1. [免费开始](/signup)并打开仪表盘。
2. 进入 **Inboxes → Connect Inbox**。
3. 选择 **Outlook / Microsoft 365**。
4. 你会被转到 Microsoft 自己的登录页面。输入你的工作或个人 Microsoft 账户，如果你的租户要求就完成 MFA，然后查看同意屏幕。
5. 批准。Microsoft 会返回一个 OAuth 令牌，MCP Emails 将其加密（AES-256-GCM）并只存储该令牌。关于你邮箱的其他任何信息都不会被持久化。

这就是 OAuth 2.0——和 Gmail 用的是同一套模型。你从来不需要把 Outlook 密码粘贴进 MCP Emails，也不需要生成任何应用密码。这正是它与 IMAP 服务商的关键区别；如果你要连接的是 [iCloud、Fastmail 或通用 IMAP 邮箱](/blog/connect-icloud-fastmail-imap-to-claude)，那些用的是应用专用密码，因为它们不向第三方客户端提供 OAuth。

### 第 2 步——连接你的智能体

你只需连接一次客户端，同一套设置就对你账户下的每个邮箱都生效。对于支持 OAuth 的客户端（claude.ai、Claude Desktop、Cursor），在 claude.ai 里的操作是：

**Customize → Connectors → Add connector → 粘贴 URL → Connect → 登录并批准。**

端点是：

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

当你点击 Connect 时，你会登录自己的 MCP Emails 账户并批准权限——\`read:email\`、\`send:email\`，或两者都批准。其间没有 API 密钥被传递；它底层用的是带 PKCE 的 OAuth 2.0 授权码模式以及动态客户端注册。

对于不支持 OAuth 的客户端（Cline、JetBrains 插件、你自己的脚本、原始 cURL），请在 **Dashboard → API Keys** 里生成一个带权限范围的密钥，选好权限，然后把它作为 \`Authorization: Bearer <api-key>\` 发送。针对这些客户端的完整操作流程在[在 Cursor、Cline 和 VS Code 中为 AI 智能体接入邮件](/blog/email-for-ai-agents-cursor-cline-vscode)里。如果你在权衡这两种方式，[AI 邮件访问中 OAuth 与 API 密钥的对比](/blog/oauth-vs-api-keys-ai-email-access)梳理了其中的取舍。

## 底层的 Microsoft Graph

一旦连接成功，你的智能体发起的每一次工具调用都会实时发往 Microsoft Graph。读取一条消息时，MCP Emails 调用 Graph，把解析后的结果交给你的智能体，然后丢弃它。发送一条消息时，它会代你通过 Graph 发出——从你真实的地址、经由 Microsoft 的基础设施发出，所以你域名的送达率和声誉始终属于你自己。MCP Emails 绝不会用它自己的域名来转发邮件。

实际效果是：你的智能体发出的邮件看起来和你亲自发的一模一样，因为它本来就是。它会出现在你的“已发送邮件”里。回复能正确串入会话线程，因为回复工具会替你设置 In-Reply-To 和 References 头部。

## 个人账户与工作／学校账户

两者都行。消费级的 Outlook.com 账户和 Microsoft 365 工作／学校账户都通过同一套 Microsoft 登录流程连接，并且都向你的智能体暴露相同的工具。

现实唯一会插一脚的地方，是工作／学校账户上的同意屏幕。如果你的 IT 管理员在租户里锁定了第三方应用的同意权限——很多较大的组织都会这么做——你可能看到的是“需要审批”，而不是普通的同意提示，连接会等待管理员处理。这不是 MCP Emails 的限制；这是你租户的策略，它会同样地拦住任何第三方客户端。对于个人账户，或者允许用户自行同意的租户，你自己批准一下就完成了。

## 连接好之后能做什么

你的智能体会获得整合后的核心工具，外加 Outlook 支持的额外工具：

- \`inbox_list\`——一定要先调用这个。它返回你已连接的邮箱及其 \`inbox_id\` UUID，这样智能体就永远不用去猜某个 ID。
- \`email_read\`——一个工具，多个 action：\`list\`（最新优先、分页，并带有像 \`unread_only\` 这样的筛选条件）、\`read\`（解析后的纯文本、可选的净化 HTML、可选的附件）以及 \`search\`（见下面关于搜索的说明）。
- \`email_compose\`——\`send\` 这个 action 用于撰写邮件，支持抄送／密送、HTML 以及总计最多 10 MB 的附件；\`reply\` 和 \`forward\` 这两个 action 会带着正确的头部在会话线程内正确串接。
- \`email_organize\`——标记已读／未读、加旗标、归档、删除和移动，各自通过自己的 \`action\` 完成。

除了这些之外，Outlook 还支持标记已读／未读、加旗标（Outlook 的“旗标”对应加星／标记的概念）、转发以及在文件夹之间移动。在你针对某个具体工具进行开发之前，请查看在线[文档](/docs)以获取最新的功能清单。

### 搜索使用 Microsoft 的 \`$search\`

Outlook 搜索不是 Gmail 搜索。Gmail 接受像 \`from:\` 和 \`is:unread\` 这样的操作符，而对 Outlook 邮箱使用 \`email_read\` 的 \`search\` action 时，会把你的查询传给 Microsoft Graph 的 \`$search\`，它会在整个邮箱中做按相关性排序的全文匹配，并且也接受 KQL。所以像 \`invoice from accounting last week\` 这样的查询可以当作自然语言使用，而你也可以用 KQL 写得更精确，比如 \`from:finance@acme.com AND subject:invoice\`。如果你写的提示词里硬编码了 Gmail 操作符，它们在 Outlook 上不会有相同的表现——告诉你的智能体用自然语言搜索，让 Graph 去排序。

## 一个值得搭建的工作流

下面是我对一个 Microsoft 365 邮箱跑的分拣循环。每小时一两次，智能体会：

1. 用 \`email_read\` 的 \`list\` action 加上 \`unread_only: true\` 调用。
2. 对任何看起来有时效性的邮件用 \`email_read\` 的 \`read\` action 读取。
3. 把这一批做个汇总，并为那些我显然会回复的邮件起草回复。
4. 在我确认之前，把所有邮件都保持为未读。

一个老实的提醒：MCP Emails 是基于轮询的。它没有 webhook，也没有服务器推送，所以智能体是按计划检查，而不是在邮件一到达的瞬间就被通知。对于分拣来说这没问题——节奏由你来设。如果你要做更具响应性的东西，请阅读[如何分拣并汇总收件箱](/blog/ai-agent-triage-summarize-inbox)，了解那些经得起考验的轮询模式。

## 与自建 M365 服务器的对比

GitHub 上流传的那些自托管 Outlook MCP 服务器全都撞上同一堵墙：Entra 应用注册和 Graph 令牌生命周期才是真正的工作量，而它们要由你永远扛着。你得处理刷新令牌、在 Microsoft 调整 Graph 时应对权限变更，以及那些令牌存放之处的安全问题。而用托管方式时，令牌在静态时是加密的，只在调用时于隔离的函数内部解密，并且可以在仪表盘里一键吊销。如果你想看完整对比，[托管 vs 自托管](/blog/hosted-vs-self-hosted-gmail-mcp-server)深入剖析了其中的取舍。

连接 Outlook 试用起来不花一分钱——[免费方案](/pricing)提供无限邮箱和工具调用，限速为每分钟 60 个请求，无需绑卡。添加你的 Microsoft 365 邮箱，把 Claude 指向那个端点，然后给它点东西去读吧。`,
};
