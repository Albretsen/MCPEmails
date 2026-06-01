export default {
  title: '在 Cursor、Cline 和 VS Code 中为 AI 智能体配置邮箱访问',
  description: '让 Cursor、Cline 和 VS Code 里的编码智能体访问邮箱。Cursor 用 OAuth；Cline 和自定义客户端通过 MCP 用带权限范围的 API 密钥。完整设置教程。',
  coverAlt: '通过 MCP 为 Cursor、Cline 和 VS Code 中的 AI 编码智能体配置邮箱访问',
  content: `先说简短版本。要让编辑器里的编码智能体访问一个真实的收件箱，只需把它指向一个 MCP 端点：\`https://www.mcpemails.com/api/mcp\`。Cursor 支持 OAuth，所以你粘贴这个 URL 然后登录即可。Cline、VS Code 原始的 MCP 配置，以及任何自定义脚本都不会走 OAuth 流程，所以它们通过一个带权限范围的 API 密钥来认证，该密钥作为 \`Authorization: Bearer\` 请求头发送。同一个端点，同一套工具，两种接入方式。

本指南涵盖这两条路径，演示如何签发一个权限范围正好限定为 \`read:email\` 和 \`send:email\` 的 API 密钥，并以一个我实际在用的开发工作流收尾：智能体帮我整理收件箱并发送回复，全程不用离开编辑器。如果你想先了解更宏观的全貌，那篇关于[如何让你的 AI 智能体访问邮箱](/blog/how-to-give-your-ai-agent-email-access)的支柱指南是最好的起点。

## 接入任何客户端之前：先连接一个收件箱

MCP 服务器并不持有你的邮件。它代理一条到你已在使用的邮件服务商的实时连接，在调用时拉取消息，随后丢弃。你的邮件不会被存储任何内容。所以第一步发生在控制台里，而不是在你的编辑器里。

进入 **Dashboard → Inboxes → Connect Inbox**，选择一个服务商：

- **Gmail** 或 **Outlook / Microsoft 365** → 一键 OAuth。用 Google 或 Microsoft 账号登录并授权即可。
- **iCloud、Fastmail、Yahoo、Zoho，或任何通用 IMAP 主机** → 使用应用专用密码。在服务商的设置中生成它（iCloud 是在 appleid.apple.com），然后粘贴进去。

Fastmail 只支持应用专用密码，不支持 OAuth，所以别在那里去找类似 Google 那样的授权同意页面。如果你用的是 iCloud 或 Fastmail，那篇 [iCloud、Fastmail 和 IMAP 设置详解](/blog/connect-icloud-fastmail-imap-to-claude)有针对各服务商的具体细节。如果用 Outlook，请看[连接 Outlook 和 Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp)。

收件箱一旦连接好，你的智能体就通过工具来访问它。你永远不需要把 UUID 或密码粘贴进编辑器配置里。

## Cursor：粘贴 URL，登录，搞定

Cursor 为 MCP 服务器支持 OAuth 2.0，这是最省心的路径。没有 API 密钥，也没有需要在配置文件里管理的密钥。

1. 打开 Cursor 设置，找到 MCP servers 部分。
2. 添加一个新服务器，URL 填 \`https://www.mcpemails.com/api/mcp\`。
3. Cursor 会打开一个浏览器窗口。登录你的 MCP Emails 账号，并批准你想让智能体拥有的权限范围——\`read:email\`、\`send:email\`，或两者都给。
4. 连接变为绿色，邮件工具出现在 Cursor 的工具列表中。

在底层，这是带 PKCE 的 OAuth 2.0 授权码流程，而 Cursor 持有的令牌的权限范围正好就是你批准的那些。如果你只授予了 \`read:email\`，智能体就根本无法发送。用完之后，从 **Dashboard → API Keys** 一键撤销该连接（OAuth 授权也在那里管理），Cursor 的访问权限会立即失效。

如果你同时也运行 Claude Desktop 和 claude.ai，它们遵循相同的粘贴并授权流程。

## Cline、原始 VS Code 和自定义脚本：使用 API 密钥

Cline、VS Code 里裸的 \`mcp\` 配置、JetBrains，以及任何你自己编写脚本的工具都没有实现 OAuth 握手。对于这些，你需要创建一个 API 密钥并把它作为 bearer 令牌发送。对于没有人去点击授权页面的 CI 任务和 cron 驱动的自动化场景，这同样是正确的做法。

### 第一步：创建一个带权限范围的 API 密钥

在 **Dashboard → API Keys** 中，点击 **Create key**。给它起一个你以后能认出来的名字（\`cline-laptop\`、\`triage-cron\`），然后选择它的权限范围：

- \`read:email\` 用于列出、搜索和读取。
- \`send:email\` 用于发送和回复。

只授予客户端所需的权限。一个只读的整理助手没有理由持有 \`send:email\`。密钥只会显示一次——它出现的那一刻就立即复制，因为你无法再次查看它。弄丢了你就只能轮换它，而不是找回它。

### 第二步：把密钥放进你的客户端配置

对于 Cline（以及大多数 VS Code 的 MCP 设置），把这个服务器连同 bearer 请求头一起加入 MCP 配置的 JSON 中：

\`\`\`json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

在动任何编辑器之前，用一条原始的 cURL 调用确认密钥可用：

\`\`\`bash
curl -s https://www.mcpemails.com/api/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

如果你拿到了一个工具列表，说明你已经连上了。出现 \`-32001\` 错误意味着密钥无效或缺少某个权限范围——这个错误不可重试，所以应该去修正密钥，而不是循环重试。不要把密钥提交到代码库。从环境变量里读取它，并让它远离 git。如果你正在权衡在什么场景该用哪种认证模型，[OAuth 与 API 密钥用于 AI 邮箱访问的对比](/blog/oauth-vs-api-keys-ai-email-access)梳理了各自的取舍。

## 你的智能体能用到的工具

两条路径暴露的是同一套能力。六个核心工具覆盖了主要工作：

- \`list_inboxes\`——总是先调用它，以发现已连接的收件箱及其 ID。
- \`list_messages\`——分页，最新的在前。
- \`read_email\`——解析后的纯文本、可选的经过净化的 HTML，以及附件。
- \`search_emails\`——服务商原生搜索（Gmail 操作符、Outlook KQL、IMAP 文本）。
- \`send_email\`——撰写邮件，支持 CC/BCC、HTML，以及最大 10 MB 的附件。
- \`reply_to_email\`——为你设置 In-Reply-To 和 References 请求头，让邮件会话保持完整。

另外还有几个工具用于标记、文件夹、定时发送和联系人，但上面这六个承担了实际工作的大部分。

## 一个真正物有所值的开发工作流

价值正是在这里体现出来。我在编辑器里常驻一个读+发权限的密钥，在那些原本会被收件箱拖掉的时段里依靠智能体。

早晨整理，直接打字进聊天面板：

> 调用 list_inboxes，然后列出我工作收件箱里过去 12 小时内的未读邮件。把它们分组：需要回复、仅供参考、噪音。对于仅供参考那一组，每封给我一行说明。

智能体会运行 \`list_inboxes\`，接着用设置了 \`unread_only\` 的 \`list_messages\`，读取那些重要的邮件，然后把一份排好序的摘要交还给我。当我看到一封想要回复的，我就跟进一句：

> 回复那位设计外包人员的邮件，确认周四下午 2 点可以，写短一点。

它会调用 \`reply_to_email\`，会话串联会被自动处理，回复通过我自己的 Gmail 发出——所以它从我的地址寄出，带着我自己域名的信誉，而不是经过某个中继。想要更深入地了解整理类提示词，请看[如何让 AI 智能体整理并总结你的收件箱](/blog/ai-agent-triage-summarize-inbox)。

一个需要坦白的局限：没有 webhook。服务器不会主动把新邮件推送给你。如果你想让智能体对收到的邮件做出反应，就需要轮询——按计划周期性地调用带 \`unread_only: true\` 的 \`list_messages\`。这是一个刻意的设计选择，它也决定了你如何构建任何带反应性的东西，比如一个[基于 MCP 的自动回复器](/blog/build-email-auto-responder-mcp-agent)。

## 脚本化访问的速率限制

如果你是从一个 cron 任务或一个紧密的智能体循环来驱动服务器，要留意限制。每个 API 密钥在所有套餐上都被限制为**每分钟 100 次请求、每小时 1,000 次、每天 10,000 次**。在此之上还有一个由你的套餐决定的每工作区突发上限：Free 为 60/min，Solo（$12/month）为 300/min，Team（$49/month）为 1,000/min。完整的细分见[价格页面](/pricing)。

当你触及限制时，服务器会返回一个可重试的错误（代码 \`-32029\`），并在 \`data.retry_after\` 中给出以秒为单位的等待时间。请遵守它——退避这么长时间再重试。另外，永远不要在一次通用失败后盲目重试 \`send_email\`；你会发出重复邮件。先检查它是否真的发送出去了。

## 小结

Cursor 让你用一个 URL 和一次登录就连上。其余一切都需要一个带权限范围的密钥和一个 bearer 请求头。两者命中的是同一个端点和同一套工具，并且都让你的凭据远离代码库，也远离模型的上下文。

[免费开始](/signup)并连接你的第一个收件箱，或者阅读[文档](/docs)获取完整的工具参考。`,
};
