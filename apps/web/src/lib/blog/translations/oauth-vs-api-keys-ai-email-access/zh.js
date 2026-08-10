export default {
  title: 'AI 邮箱访问该用 OAuth 还是 API 密钥？该怎么选',
  description: 'AI 邮箱访问选 OAuth 还是 API 密钥：claude.ai、Claude Desktop、Cursor 用 OAuth；Cline、JetBrains 和脚本用受限 API 密钥。',
  coverAlt: '连接 AI 智能体到邮箱时的 OAuth 与 API 密钥对比 — MCPEmails',
  content: `当你通过 MCP Emails 把 AI 智能体连接到邮箱时，有两种认证方式可选：OAuth 或 API 密钥。简短的答案是：如果你的客户端支持 OAuth（claude.ai、Claude Desktop、Cursor），就用 OAuth；如果不支持（Cline、JetBrains、脚本、cURL），就用受限的 API 密钥。两者访问的是同一个端点，暴露的是同一套工具。区别在于由谁来管理这个密钥，以及你能多容易地随时断开它。

这并不是一个用安全换便利、必须牺牲其中一方的权衡。两条路径都被严格限定在 \`read:email\`、\`send:email\` 或两者之内，而且都能在仪表盘上一键撤销。真正的问题是哪一种更适合你实际在用的客户端。想了解这一切如何连成一体的全貌，可以先看支柱指南：[如何让你的 AI 智能体访问邮箱](/blog/how-to-give-your-ai-agent-email-access)。

## 30 秒速选建议

当你的 MCP 客户端支持时，用 **OAuth**。目前这涵盖了 claude.ai、Claude Desktop 和 Cursor。你粘贴一个 URL、登录、批准权限范围，就完成了。没有密钥要复制，没有密钥要保存，也没有密钥会泄露。

当你的客户端没有 OAuth 流程时，用 **API 密钥**。Cline、JetBrains 的 AI 助手、一个 Python 定时任务、一段把 JSON-RPC 通过 cURL 传出去的 shell 脚本——这些都需要一个 bearer 令牌。你在仪表盘里创建一个，设定它的权限范围，复制一次，然后放进 \`Authorization\` 请求头里传递。

如果同一个客户端两种方式都可选，那就选 OAuth。配置文件里的密钥越少越好，这永远是更稳妥的默认选择。

## OAuth 在这里是怎么工作的

OAuth 是免密钥的那条路。不是由你生成一个凭据再把它粘贴到某处，而是客户端和服务器直接协商出一个，令牌就存在客户端内部，而不是放在一个由你管理的配置文件里。

在 claude.ai 里，流程是：**Customize → Connectors → Add connector → 粘贴 URL → Connect → 登录并批准。** 这个 URL 就是 MCP 端点 \`https://mcpemails.com/api/mcp\`。批准之后，智能体就获得了访问权限，而你自始至终没碰过任何密钥。

在底层，它用的是标准、当下通行的 OAuth：

- **Authorization Code + PKCE**（RFC 7636），因此从不会传输任何 client secret。PKCE 正是保护移动端和单页应用登录的同一套机制。
- **Dynamic Client Registration**（RFC 7591），因此客户端会自行注册，你这边无需任何手动设置。
- **令牌会自动刷新**，在受支持的客户端内部完成。你不用盯着过期时间操心。
- **权限范围就是你在同意页上批准的那些**：\`read:email\`、\`send:email\`，或两者。

实际的好处是：令牌永远不会以一个明文字符串的形式出现，也就不会被你意外提交、记录到日志，或粘贴进错误的对话里。当你想切断访问时，在仪表盘里撤销这个连接，智能体立刻就被挡在门外。至于这种撤销为什么真的重要——邮箱本身始终保持原样，因为在我们这边[邮件从不被存储](/blog/why-email-never-stored-matters)。

## API 密钥在这里是怎么工作的

有些客户端不会说 OAuth。这并不是在贬低它们。Cline、JetBrains，以及任何你自己写的东西，都只是期待一个 bearer 令牌——这是更老、但完全没问题的机器认证方式。

你在 **Dashboard → API Keys** 里创建一个：

1. 给密钥起一个日后你能认出来的名字（\`cline-laptop\`、\`triage-cron\`）。
2. 选择它的权限范围：\`read:email\`、\`send:email\`，或两者。
3. 复制它。它只会显示**一次**，之后再也不显示。如果丢了，就重新创建一个。

密钥长得像 \`mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456\`，你在每次请求时都要带上它：

\`\`\`
Authorization: Bearer mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456
\`\`\`

一个用来列出你收件箱的原始 JSON-RPC 调用长这样：

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "inbox_list", "arguments": {} }
}
\`\`\`

把它 POST 到 \`https://mcpemails.com/api/mcp\` 并带上 bearer 请求头，你就会收到已连接的收件箱及其 ID。从这里开始，智能体会调用 \`email_read\`（\`action\` 设为 list、read 或 search）和 \`email_compose\`（\`action\` 为 send、reply 或 forward）——核心工具，外加 \`email_organize\`、\`folder\`、\`schedule\` 和 \`contact_search\` 用于标记、文件夹、定时和联系人。

API 密钥要求你做、而 OAuth 不要求的唯一一件事：把密钥当成密码来对待。它是一个明文形式的长期密钥。把它放进环境变量，而不是放进你会推送到 GitHub 的源码里。如果某个密钥泄露了，在仪表盘里撤销它，再轮换成一个新的。

## 权限范围：每一次都只授予最小权限

这部分对两种方式都是一样的，而且它是出力最多的那项安全控制。一个只能 \`read:email\` 的连接发不出任何东西，无论智能体决定要做什么。如果你正在搭建一个[汇总与分拣的工作流](/blog/ai-agent-triage-summarize-inbox)，那就授予只读权限。智能体读取、排序、汇报，一个被搞糊涂或被操纵的模型没有任何途径把消息发出去。

只有当发送确实是这项工作本身时，才加上 \`send:email\`，比如一个[基于 MCP 工具搭建的自动回复器](/blog/build-email-auto-responder-mcp-agent)。即便如此，也要按任务分别设定独立的密钥或连接，而不是一个到处复用、无所不能的凭据。最小权限不是疑神疑鬼。它是你能买到的最便宜的保险。

## 那到底该用哪个？

### 用 OAuth，如果……

你的客户端是 claude.ai、Claude Desktop 或 Cursor。你希望配置里没有任何密钥。你希望令牌刷新由它替你处理。你希望撤销这件事尽可能干净利落。这是默认选项，你应该首先伸手去拿它。

### 用 API 密钥，如果……

你的客户端不支持 OAuth——Cline、JetBrains、OpenAI 风格的工具运行器，或者你自己的代码。你正在用 cURL 或一个小程序对着端点写脚本。你需要一个稳定的凭据，好让一个无人值守的进程在没有人去点同意页的情况下也能用。受限的密钥在这里恰到好处，而且有一份针对 [Cursor、Cline 和 VS Code 客户端](/blog/email-for-ai-agents-cursor-cline-vscode)的完整操作指南。

还有一件事无论你选哪个都成立：速率限制。每个 API 密钥的上限是 100 requests/minute、1,000/hour 和 10,000/day，每个工作区还按套餐有一个突发上限（[Free](/pricing) 为 60/min，Scale 最高 1,000/min）。当你触及限制时，服务器会返回一个以秒为单位的 \`retry_after\` 值。请遵守它，而且绝不要盲目重试 \`email_compose\` 发送——那样你会重复发送。

## 结论

OAuth 和 API 密钥并不是一个安全性的高下排名。它们是与你的客户端的匹配。OAuth 是更好的默认选项，因为它把密钥完全从你手里拿走；但对于那些确实需要密钥的客户端和脚本来说，一个权限受限、妥善保存的 API 密钥同样是真正安全的。仔细挑选权限范围，把密钥存进环境变量，撤销掉任何你不再使用的东西。

准备好接上一个了吗？连接一个收件箱和一个客户端大约[两分钟就能从头到尾搞定](/blog/connect-email-to-ai-agent-under-2-minutes)，或者你也可以阅读完整的[文档](/docs)并[免费开始](/signup)。`,
};
