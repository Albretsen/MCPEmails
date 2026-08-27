export default {
  title: '用 MCP 连接的智能体搭建邮件自动回复器',
  description: '用 MCP 连接的 AI 智能体搭建邮件自动回复器：轮询未读邮件、起草并安全回复，配合权限、速率限制与护栏。',
  coverAlt: '用 MCP 连接的智能体搭建邮件自动回复器 — MCPEmails',
  content: `基于 MCP Emails 搭建的邮件自动回复器是一个循环，而不是 webhook。这里没有服务端主动触发的事件，所以你的智能体按计划用 \`email_read\`（动作 \`list\`）**轮询**未读邮件，用 \`email_read\`（动作 \`read\`）读取每一封消息，起草回复，然后调用 \`email_compose\`（动作 \`reply\`）。本文带你走完整个搭建过程：轮询循环、你需要的权限、如何熬过速率限制，以及那些能防止智能体用胡编的回复轰炸你联系人的护栏。

这是[给你的 AI 智能体邮件访问权限](/blog/how-to-give-your-ai-agent-email-access)这条线索里偏进阶的一端。如果你只想做分拣和晨间摘要、不想发送任何东西，先读[AI 智能体的收件箱分拣与摘要](/blog/ai-agent-triage-summarize-inbox)——那是更安全的起点。等你真的想让智能体按下发送键时，再回到这里。

## 实话实说：根本没有 webhook

大多数"自动回复器"教程都假设邮件一落地就会触发一个推送事件。MCP Emails 不是这么工作的，据我所知没有哪个 MCP 服务器是这么工作的。MCP 是一个请求/响应式的工具协议。服务器只在你的智能体发起请求时作答；它从不主动呼叫你。

所以一个真正的自动回复器就是一个调度器加一次轮询。你每隔 N 秒或 N 分钟跑一个周期（tick），请求未读消息，处理所有新到的内容。就这样。它不如 webhook 优雅，但它可预测，而且这意味着*由你*来掌控节奏和影响范围。

挑一个轮询间隔，在你能容忍的延迟和你的速率预算之间取得平衡。对于客服类回复，每 60 秒一次就够了。对大多数收件箱来说，每 5 分钟一次绰绰有余，几乎碰不到你的限额。别每秒轮询一次——你会无谓地烧掉配额，而收件箱很少变化得那么快。

## 你需要什么：一把带发送权限的 API 密钥

自动回复器几乎总是作为脚本或定时任务（cron job）运行，而不是在聊天客户端里。这意味着走的是 [API 密钥这条路，而不是 OAuth](/blog/oauth-vs-api-keys-ai-email-access)。

在控制台里，进入 **API Keys**，创建一把密钥，并授予它你确实需要的权限：

- \`read:email\`——用于通过 \`email_read\` 轮询、列出和读取消息。
- \`send:email\`——用于调用 \`email_compose\`（动作 \`reply\`）。

密钥只显示一次。把它复制下来。它看起来像 \`mcpe_live_...\`，你要在每次请求时带上它：

\`\`\`
Authorization: Bearer mcpe_live_YOUR_KEY
\`\`\`

MCP 端点是一个单独的 URL：

\`\`\`
https://www.mcpemails.com/api/mcp
\`\`\`

**只**授予这个任务用得到的权限。如果将来某个版本的回复器需要转发或标记邮件，到时候再加上那些能力。一把只能读取和回复的密钥，即便泄露，也只能读取和回复。（关于密钥处理与轮换的完整说明，参见[文档](/docs)。）

## 这个循环

下面是一个能跑的回复器的大致样子。我用 MCP 工具上的伪代码写出来，这样能清楚地看出哪些调用按什么顺序发生。具体的 MCP 客户端接线取决于你的技术栈，但顺序才是重点。

\`\`\`python
# Tools used: inbox_list, email_read, email_compose

inbox = inbox_list()[0]              # discover, never hardcode the UUID

while True:
    unread = email_read(
        action="list",
        inbox_id=inbox["inbox_id"],
        unread_only=True,
        limit=20,
    )

    for summary in unread["messages"]:
        if not should_handle(summary):   # allowlist + filters, see below
            continue

        msg = email_read(
            action="read",
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
        )

        draft = generate_reply(msg)      # your LLM call

        if not passes_guardrails(draft, msg):
            queue_for_human(msg, draft)  # don't send; flag it
            continue

        send_with_backoff(
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
            body=draft,
        )

    sleep(60)
\`\`\`

有三点值得留意。第一，智能体调用 \`inbox_list\` 来发现 \`inbox_id\`，而不是把一个 UUID 粘进代码里——这就是"先发现"的模式，它能让脚本在你重新连接收件箱后依然可用。第二，\`unread_only: true\` 才是让这成为一个*新邮件*回复器、而不是一台对所有人反复回复的机器的关键。第三，每一封消息在发送任何东西之前都要经过护栏。

### 把消息标记为已处理

如果你想让一封消息在你回复之后不再显示为未读，读取时把 \`mark_as_read\` 设上，或者显式调用 \`mark_read\`。这里要慎重：如果你的循环回了复却从不把消息标为已读，下一个周期就会再回一次。把消息标记为已处理，正是循环保持幂等的方式。

## 速率限制，以及为什么你永远不能盲目重试发送

每一把 API 密钥都被限制在**每分钟 100 次请求、每小时 1,000 次、每天 10,000 次**，与套餐无关。你的工作区还有一个按层级划分的突发上限：**免费版为 60 req/min，Personal 为 120，Pro 为 300，Team 为 1,000**（见[定价](/pricing)）。一个礼貌的轮询并回复的循环会舒舒服服地待在这个范围内，但一个行为不当的循环可能会撞上去。

当你触到速率限制时，服务器会返回一个可重试的错误（代码 \`-32003\`），其中带有以秒为单位的 \`data.retry_after\`。尊重它。睡那么久，然后继续。

你套餐的每月操作额度是另一种限制，而且不可重试。额度用尽时，调用会以普通工具结果返回，带 \`isError: true\` 和一个 \`_meta["com.mcpemails/usage_limit"]\` 区块，而不是 JSON-RPC 错误，也没有 \`retry_after\`。在 \`reset_at\` 之前或未升级套餐时，重试只会白白消耗资源，所以请停止循环并把它暴露出来。

下面这条规则最要紧：**永远不要盲目地自动重试 \`email_compose\` 的发送或回复。**发送不是幂等的。如果一次发送调用超时或返回结果含糊，天真的重试可能会把同一封回复发送两次。读取尽管放心重试；把发送当作一次性操作，只在遇到明确的可重试错误时才重试，配合退避和一个硬上限。

\`\`\`python
def send_with_backoff(**kwargs):
    delay = 2
    for attempt in range(3):
        try:
            return email_compose(action="reply", **kwargs)
        except RateLimited as e:
            sleep(e.retry_after or delay)
            delay *= 2
        except RetryableError:
            sleep(delay)
            delay *= 2
        # any other error: do NOT retry a send. log it, move on.
        else:
            break
    raise SendFailed(kwargs)
\`\`\`

注意它只在限速或明确可重试的错误上重试，最多重试三次，而且从不无限循环。一次连续失败三次的发送，是该交给人去处理的问题，而不是循环的问题。

## 护栏：工具与隐患之间的分水岭

一个不经监督就发送的自动回复器，离给你的 CEO 发一封信心满满却完全错误的回答只差一个糟糕的提示词。先把刹车造好，再去造引擎。

### 用白名单限定谁能收到自动回复

别回复所有人。从一个很窄的白名单开始——一个客服别名、一个特定的发件人域名、匹配某种主题模式的消息。其他一切都排队交给人处理或直接忽略。白名单是你能加上的最高杠杆的单项护栏，因为它把故障限定在一个你自己选定的人群里。

### 让人留在闭环里，至少一开始要这样

这套东西最安全的版本根本不是自动回复器——而是一个自动*起草器*。智能体读取、起草并把回复暂存好，但由人来批准发送。MCP Emails 支持草稿，所以你可以让循环调用 \`draft\`（动作 \`create\`），而不是调用 \`email_compose\`，然后由你自己把好的那些发出去。先在草稿模式下跑一周。看看它本来会发出什么。只有到那时，再把你信得过的那些切到自动发送。

### 阻断循环和自我回复

两种经典的故障模式：

- **自动回复来回弹。**如果你回复了一封休假自动回复邮件，而它又回复了你的回复，你就和别人的机器人一起搭出了一个无限循环。把看起来像自动发出的消息过滤掉（检查 \`Auto-Submitted\` 头、\`no-reply\` 发件人，或者已知的自动回复主题），并且永远不要回复你自己的地址。
- **对同一邮件线程反复回复。**处理完后把消息标为已读，并保留一份你已经回答过的消息 ID 的小记录。一旦涉及发送，幂等性就不是可选项。

### 约束模型能说什么

给起草模型紧凑的指令和一个长度上限。对于客服回复，一个带占位槽的模板胜过自由发挥的生成。并且在发送前跑一个廉价的检查：这份草稿里有没有退款承诺、一个价格、一项法律承诺，或者一个你没料到的链接？如果有，就把它转给人。这就是上面循环里的 \`passes_guardrails\` 检查，也是你大部分工程精力的去处。

## 一个现实可行的初版

如果明天就要为一个真实收件箱上线这套东西，我会从小而无聊的地方起步：

1. 一把带 \`read:email\` 和 \`send:email\` 的 API 密钥，限定到一个收件箱。
2. 每两分钟轮询一次 \`email_read(action: "list", unread_only: true)\`。
3. 白名单里只放恰好一个客服别名。
4. 只用草稿模式——创建草稿，不自动发送任何东西。
5. 读了一周草稿之后，对那些显而易见的情形开启自动发送，其余的继续起草。

这是一套你真的能信任的系统，而且它能举一反三。同一个循环换个提示词，就变成一个分拣机器人、一个线索路由器，或者一个通知器。想看看智能体接入之后能做的更广菜单，参见 [AI 智能体在收件箱访问下能做的 7 件事](/blog/7-things-ai-agent-can-do-with-inbox-access)。如果你还在纠结到底要不要给智能体发送权限，[给 AI 智能体邮件访问权限安全吗](/blog/is-it-safe-to-give-ai-agent-email-access)值得你在上线前花点时间读一读。

准备好动手了吗？创建一把带权限范围的 API 密钥，并在[文档](/docs)里阅读工具参考，或者[免费开始](/signup)：免费版可连接一个收件箱，Personal（每月 5 美元）最多可连接三个，Pro 可连接你拥有的每一个邮箱；在自动化前先把护栏加好。`,
};
