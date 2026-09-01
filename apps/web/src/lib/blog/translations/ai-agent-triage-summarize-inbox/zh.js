const translation = {
  title: '如何让 AI 智能体分拣并总结你的收件箱',
  description:
    '一份关于 AI 智能体收件箱分拣的实操指南：可直接复制粘贴的提示词，列出未读邮件、阅读要紧的内容、总结并排定优先级，还能按计划定时轮询。',
  coverAlt: 'AI 智能体通过 MCP 分拣并总结收件箱 — MCP Emails',
  content: `让 AI 智能体分拣收件箱最快的办法，是按顺序倚重两个工具：用 \`inbox_list\` 找到你的邮箱，然后用 \`email_read\` —— 以 \`action: list\` 加 \`unread_only: true\` 拉取新邮件，再以 \`action: read\` 读那几封看起来重要的 —— 然后给一句大白话指令让它总结并排序。整个循环就这么多。如果你想让它起草或发送回复，只需在最后加上带 \`action: reply\` 的 \`email_compose\`。

这篇文章给你我自己用的确切提示词，告诉你好的输出长什么样，以及如何按计划定时跑同一个循环，让早晨的分拣在你坐下之前就已经完成。这里假设你的智能体已经通过 [MCP Emails](/blog/how-to-give-your-ai-agent-email-access) 拿到了邮件访问权限。如果你还没连接收件箱，[两分钟以内的连接指南](/blog/connect-email-to-ai-agent-under-2-minutes) 会先帮你搞定这一步。

## 一图看懂分拣循环

每一次分拣会话都是同样的五步。一旦你描述好目标，智能体会自己琢磨出顺序，但了解底层发生了什么会有帮助：

1. \`inbox_list\` —— 发现已连接的收件箱及其 \`inbox_id\` UUID。智能体从不硬编码 UUID，而是在这里查出来。
2. 带 \`action: list\` 和 \`unread_only: true\` 的 \`email_read\` —— 拉取某个收件箱的未读队列，最新的排在前面。
3. 带 \`action: read\` 的 \`email_read\` —— 对那几封值得细读的邮件打开完整正文。
4. 总结并排序 —— 纯推理，不调用工具。模型负责归类、排序并给出解释。
5. 带 \`action: reply\` 的 \`email_compose\`（可选）—— 为需要回复的邮件起草或发送。

第 1 到第 4 步都是只读的。如果你是用带 \`read:email\` 范围的 [OAuth 授权或 API 密钥](/blog/oauth-vs-api-keys-ai-email-access) 连接的，那么智能体在物理上就发不出任何东西——对于一份你稍后才会扫一眼的自动摘要来说，这正是你想要的。

## 提示词 1：早晨摘要

先从简单的开始。这是我大多数日子都会跑的那一个。把它粘到 Claude（或任何连接到 MCP Emails 的 MCP 客户端）里，让它干活：

> 看一下我的主收件箱。把所有未读的都拉出来，然后给我一份摘要，分成三类：今天需要回复、仅供参考 / 可以等、大概是噪音。对前两类里的每一项，给我一行：发件人是谁、对方想要什么。不必打开我不需要的邮件——先扫一遍主题和发件人，只有当主题含糊不清时才去读正文。

留意这个提示词做了什么。它让智能体倚重 \`email_read\`（action list）的元数据（发件人、主题、摘要片段），并尽量少调用带 \`action: read\` 的 \`email_read\`。这能让会话保持快速，并且稳稳地待在速率限制之内——每个 API 密钥每分钟 100 个请求，以及每个工作区一个起步于免费方案 60/min 的上限。一个有 40 封未读的队列用这种方式分拣，大概是十几次工具调用，而不是四十次。

一个好的回复看起来是这样的：

\`\`\`text
NEEDS A REPLY TODAY (3)
- Dana (Acme): contract redline is back, wants sign-off before Fri
- Priya: blocked on the staging creds, asking you directly
- Stripe: a payment dispute opened, response due in 5 days

FYI / CAN WAIT (4)
- GitHub: 2 PRs merged into main overnight
- Notion: weekly digest
- Lena: shared the Q3 deck, no ask
- AWS: scheduled maintenance next Tuesday

PROBABLY NOISE (11): newsletters, 2 calendar invites already on your
calendar, LinkedIn, 6 marketing blasts.
\`\`\`

这才是真正有用的，而原始的收件箱做不到。智能体读了那三封主题没把诉求讲清楚的邮件，而把十一封通讯类邮件留着没动。

## 提示词 2：带优先级和推理的深度分拣

当未读数量很难看时——比如一个长周末之后的周一——我想要的就不只是分类。我希望智能体为它的排序辩护，这样我才能信得过：

> 我的收件箱乱成一团。把过去 4 天里所有未读的都分拣一遍。按它们实际有多紧急来排出前 8，而不是按发件人嗓门有多大。对每一项，告诉我截止日期（如果有的话）、谁被卡住了，以及你给出这个排名的一句话理由。读完你前 8 名里每一封的完整正文，这样你就不是在瞎猜。

「不是按发件人嗓门有多大」这句话很关键。没有它，智能体会过度看重全大写的主题和自动系统发来的「URGENT」。有了它，你得到的是判断力：

\`\`\`text
1. Priya — blocked on staging creds since Thu. A teammate can't ship
   until you respond. No formal deadline but it's costing time now.
2. Stripe dispute — hard deadline in 5 days, money attached, but you
   have buffer so it's #2 not #1.
3. Dana (Acme) — contract sign-off by Fri. Important, not yet urgent.
...
\`\`\`

对于这个提示词，智能体会调用带 \`action: read\` 的 \`email_read\` 八次，每个排名靠前的项目一次，因为你要求它别再猜。这是值得的权衡：用几次额外的调用换来你可以据此行动的排序。如果智能体在运行途中确实撞上了限制，MCP Emails 会返回一个可重试的错误，附带以秒为单位的 \`retry_after\` 值——行为良好的客户端会等够那么久再继续，而不是猛敲服务器。

## 提示词 3：以回复收尾的分拣

分拣能闭环时才更有价值。一旦你信得过这些摘要，就让智能体起草。我在发送这一步会保留人工把关，所以我的提示词要的是草稿，而不是自动驾驶：

> 照常分拣。对于「今天需要回复」里那些我能用两句话答复的，起草回复并拿给我看。先别发——我会说「发 1 和 3」或者改一改。贴合我平常的语气：简短、直接、没有官腔废话。

智能体跑完只读循环，然后把草稿就地写出来。当你说「发 1 和 3」时，它会为那两封调用带 \`action: reply\` 的 \`email_compose\`。回复会自动归入会话线程——MCP Emails 替你设好 \`In-Reply-To\` 和 \`References\` 头，所以你的答复会落进正确的对话里，而不是另起一条新线程。邮件通过你自己的服务商发出（Gmail API、Microsoft Graph，或你的 SMTP），所以送达率和你的域名信誉始终归你所有。没有任何东西经由某个共享发送域中转。

如果你想更进一步、把自己彻底从循环里移除，那就是另一种形态的自动化了——在让智能体无人值守地发送之前，关于我会给它加上哪些护栏，请看 [用 MCP 智能体搭建邮件自动回复器](/blog/build-email-auto-responder-mcp-agent)。

## 按计划定时跑分拣

这里有个老实话要说：MCP 是**轮询，不是推送。** MCP Emails 没有 webhook，也不发送任何由服务器发起的事件。新邮件到达时你的智能体不会被通知到。要做持续的分拣，就必须有某个东西按定时器去调用带 \`action: list\` 和 \`unread_only: true\` 的 \`email_read\`。

实际上这意味着两种方案之一：

- 一个定时任务——一条 cron 条目、你的智能体平台里的一个计划任务，或者 Claude 自带的调度（如果你的客户端支持的话）——在早上 8 点触发早晨摘要提示词，午饭后再来一次。一天两次能覆盖大多数人。
- 一个常驻的智能体循环，在工作时间里每隔几分钟轮询一次。对个人收件箱来说这是杀鸡用牛刀，烧掉速率限制却换不来多少收益。把它留给真正对时间敏感的邮箱，比如 support@ 或 alerts@。

我跑的是定时任务那一版。一天两次轮询，每次都是针对主收件箱的单个早晨摘要提示词。它只花几次工具调用，就能在我打开邮件客户端之前把一份干净的摘要摆到我面前。对大多数人来说，这在每一个要紧的维度上都胜过实时循环。

不管你选什么节奏，都要让轮询保持诚实：更频繁的轮询并不意味着更快，只意味着更多请求去撞同一个每分钟 60 到 1,000 的上限。让间隔匹配收件箱实际流动的快慢。

## 几件能让分拣明显变好的小事

- **点名收件箱。** 如果你连了不止一个账户，就说「我的工作收件箱」或「那个支持收件箱」。智能体会从 \`inbox_list\` 的标题里解析出来，你也就避免了它去分拣错的邮箱。
- **给它一套评判标准，而不只是「总结一下」。**「紧急 = 有人被卡住，或者有当天的截止日期」产出的排序，远比把紧急的定义留白要好得多。
- **给阅读量封顶。**「只在主题含糊时才打开正文」或「读前 8 个」能让会话保持快速又省钱。无上限的「全都读」既慢又很少更好。
- **在信任它之前保持只读。** 用 \`read:email\` 范围跑上一周。只有当草稿一直稳定地令人满意时，再加上 \`send:email\`。

如果分拣是你尝试的第一个工作流，那它是个很好的起点——它是只读的，回报立竿见影，而且它能建立起你在交出发送权限之前会想要的那份信任。等你上手之后想要更多点子，这里有 [AI 智能体有了收件箱访问权限后能做的七件事](/blog/7-things-ai-agent-can-do-with-inbox-access)。

## 在你自己的收件箱上试试

连接一个收件箱，粘上提示词 1，看着你的智能体在一分钟内把 40 封积压的邮件清薄。它[免费起步](/signup)，无需信用卡，而且你可以在仪表盘里一键撤销访问权限。如果你想把这个循环接进脚本而不是聊天里，[文档里的工具参考](/docs) 列出了每一个参数。`,
};

export default translation;
