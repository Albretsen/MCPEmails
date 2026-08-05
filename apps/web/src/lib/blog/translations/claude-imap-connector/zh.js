export default {
  title: 'Claude IMAP 连接器：将任意 IMAP 邮箱连接到 Claude',
  description:
    '使用 IMAP/SMTP 设置、应用专用密码和 TLS 端口，为任意邮箱配置 Claude IMAP 连接器，并了解安全建议、限制与故障排查方法。',
  coverAlt: 'Claude 通过 MCPEmails 连接到 IMAP 和 SMTP 邮箱',
  content: `**Claude IMAP 连接器**可以让 Claude 使用那些没有原生 Claude 集成的邮箱：Fastmail、iCloud Mail、Yahoo、Zoho、Yandex、您自有域名下的邮箱，以及几乎所有提供 IMAP 和 SMTP 的服务商。

Claude 不会直接登录邮件服务器，也不会直接处理您的邮箱密码。MCPEmails 位于两者之间：它通过 IMAP 连接服务商以处理收件，通过 SMTP 处理发件，再向 Claude 提供一套一致的 [Model Context Protocol](https://modelcontextprotocol.io) 工具。理解这个区别很重要：IMAP 和 SMTP 负责邮箱通信，而 MCP 则为 Claude 提供安全且结构化的操作，例如读取、搜索、回复和移动邮件。

本指南介绍通用连接器以及 Claude 端的设置。如果您使用 iCloud 或 Fastmail，并希望查看其具体的应用专用密码界面和服务器名称，可以同时打开[针对 iCloud、Fastmail 和 IMAP 的服务商专用指南](/blog/connect-icloud-fastmail-imap-to-claude)。

## Claude IMAP 连接器实际如何工作

整个连接由三个部分组成：

1. **您的邮件服务商**提供 IMAP，用于读取和整理邮件；同时提供 SMTP，用于发送邮件。
2. **MCPEmails**以加密形式保存邮件凭据，与这些服务器通信，并将服务器响应转换成行为可预期的邮件工具。
3. **Claude**连接 MCP endpoint，并且只调用您通过 scope 授权的工具。

因此，Claude 不需要 IMAP 库、SMTP 配置，也不需要在 prompt 中包含密码。连接后，它可以用 \`inbox_list\` 查找邮箱，用 \`email_read\` 列出、读取、搜索邮件或获取附件，用 \`email_compose\` 发送、回复和转发邮件，还可以用 \`email_organize\` 移动、复制、标记或归档邮件。文件夹、草稿、定时发送、联系人和删除功能由其他独立工具提供；完整列表请参阅[工具参考](/docs#tools)。

## 设置前需要准备什么

请从邮件服务商的帮助页面或管理员处收集以下信息：

- **电子邮件地址：**例如 \`you@example.com\`。这是连接后的收件箱所显示的地址。
- **登录用户名：**通常是完整的电子邮件地址。某些自定义域名托管商会提供不同的 IMAP/SMTP 用户名。
- **IMAP 主机和端口：**例如 \`imap.example.com\`，端口为 \`993\`，用于采用隐式 TLS 的 IMAP。此连接负责读取、搜索、文件夹及邮件操作。
- **SMTP 主机和端口：**例如 \`smtp.example.com\`，端口为 \`465\` 或 \`587\`。端口 \`465\` 使用隐式 TLS；\`587\` 通过 STARTTLS 升级为加密连接。此连接负责发送、回复和转发。
- **密码：**最好使用专为邮件客户端访问而创建、可撤销的应用专用密码。

如果服务商已公布设置，请勿根据域名猜测服务器名称。邮件托管往往与网站托管分离，自定义域名邮箱也可能使用服务商指定、不同于可见邮箱地址的登录名。

只要服务商支持，就应使用**应用专用密码**。它与您的主账号密码相互独立，可以单独撤销，而无需更改日常登录密码。服务商通常要求先启用双重身份验证，才能创建应用专用密码。有些还要求先在邮件设置中启用 IMAP 访问。

MCPEmails 内置 iCloud、Yahoo、Zoho 和 Yandex 预设，并为 Fastmail 提供专门的应用专用密码流程。选择这些选项后，系统会自动填写已知的主机和端口。其他服务商或自建邮件服务器请选择 **Generic IMAP**，并自行填写相应信息。

## 第 1 步：连接 IMAP/SMTP 邮箱

1. [创建 MCPEmails 账号或登录](/signup)，然后打开 **Dashboard → Inboxes → Connect Inbox**。
2. 如果列表中有对应服务商，请直接选择；否则选择 **IMAP / SMTP**。
3. 输入电子邮件地址和应用专用密码。使用通用连接器时，还要输入 IMAP 主机和端口、SMTP 主机和端口；如果托管商提供了单独的登录用户名，也请填写。
4. 保存连接。MCPEmails 会先在 IMAP 服务器上验证凭据，然后才保存邮箱。因此，如果登录被拒绝或 TLS endpoint 无法访问，错误会在这里出现，而不是稍后才在 Claude 中暴露。

通常的安全默认值为 IMAP \`993\`，SMTP 则为 \`465\` 或 \`587\`。这些端口不能互换：请使用服务商文档指定的端口和安全模式。MCPEmails 将 SMTP 端口 \`587\` 作为 STARTTLS 处理，其他已配置的 SMTP 端口则按隐式 TLS 处理。不支持 TLS 的连接会被拒绝。

## 第 2 步：将 MCPEmails 添加为 Claude 连接器

邮箱连接完成后，将 Claude 指向 MCPEmails：

1. 在 claude.ai 中打开 **Customize → Connectors**。
2. 选择 **Add connector**，然后输入 \`https://www.mcpemails.com/api/mcp\`。
3. 选择 **Connect**，登录 MCPEmails，并且只批准该工作流程所需的权限。

例如，邮件摘要工作流需要读取和搜索权限，但不需要发送或删除权限；回复工作流则需要发送权限。文件夹管理和永久删除各自具有独立的 scope，因此在真正需要之前，您可以一直禁用破坏性操作。有关客户端流程的更多细节，请参阅 [Claude 邮件连接操作指南](/blog/connect-claude-to-email)。

然后进行一个简单的冒烟测试：

\`\`\`
使用 inbox_list 找到我的 IMAP 收件箱。列出最新的五封未读邮件并进行总结。不要发送、移动或删除任何内容。
\`\`\`

先调用 \`inbox_list\`，Claude 就能取得正确的 \`inbox_id\`，无需依赖复制过来的 UUID。

## Claude 可以通过 IMAP 做什么

连接成功后，Claude 可以：

- 列出并读取从服务商处实时获取的邮件。
- 按发件人、收件人、主题、正文、已读状态、星标状态和日期进行搜索。
- 在文档注明的大小与格式限制内，下载或提取受支持的附件。
- 通过 SMTP 发送新邮件，或者在保留相关邮件上下文的同时回复和转发。
- 在 IMAP 文件夹中移动、复制、标记、归档和整理邮件。
- 在相应工具支持时，创建和管理草稿、定时发送邮件以及搜索联系人。
- 将邮件移至 Trash；或者在拥有明确删除权限并设置 \`permanent: true\` 时，通过 IMAP 将其永久清除。

最后一项功能需要谨慎使用。IMAP 永久删除会绕过 Trash，且可能无法恢复。MCPEmails 将删除功能作为独立的破坏性工具提供，MCP 客户端则控制确认行为；即便如此，也应只向确实需要的工作流授予 \`delete:email\`。

## 重要的 IMAP 限制

IMAP 连接器适用范围广，但并不会让所有服务商的行为变得完全一致。

- **没有新邮件推送：**MCPEmails 仅采用请求/响应模式。新邮件到达时，它不会发送 webhook，也不会触发 Claude。自动化工作流必须按计划轮询，例如定期列出未读邮件。
- **搜索能力因传输方式而异：**结构化的发件人、主题、文本和日期筛选器适用于各服务商，但通用 IMAP 不支持 \`has_attachment\` 搜索筛选器。服务商原生的搜索语法也无法跨平台通用。
- **文件夹不是 Gmail 标签：**IMAP 会在文件夹之间移动邮件，而 Gmail 可以为同一封邮件添加多个标签。实际区别请参阅 [Gmail 标签与 IMAP 文件夹](/blog/gmail-labels-vs-imap-folders-ai-agents)。
- **发送邮件必须使用 SMTP：**IMAP 登录成功只能证明 Claude 可以访问收件，不能证明 SMTP 主机、端口或发送权限正确。在依赖回复工作流之前，请先发送一封无关紧要的测试邮件。
- **服务商政策仍然有效：**邮箱容量、发送限额、同时连接数限制、垃圾邮件控制和管理员限制仍会照常执行。

## 排查 Claude IMAP 连接问题

### 连接邮箱时出现“Authentication failed”

请使用应用专用密码，而不是登录服务商网站时使用的密码。如果服务商有此要求，请确认已启用双重身份验证和 IMAP 访问。重新复制生成的密码，确保前后没有空格。如果地址使用自定义域名，请核实登录用户名是完整的电子邮件地址，还是单独的账号名。

### 服务器超时或 TLS 失败

检查主机名拼写，并使用服务商文档注明的安全端口。IMAP 首先尝试 \`993\`；SMTP 请使用文档指定的 \`465\` 或 \`587\`。网站主机名、控制面板主机名或裸域名不一定是邮件服务器。对于私有服务器，还应确认防火墙允许来自本地网络之外的连接，并且 TLS 证书与邮件主机名匹配。

### Claude 可以读取，但不能发送

这说明 IMAP 设置可用，但 SMTP 是独立的。请重新检查 SMTP 主机名和端口，确认凭据具有 SMTP 或“mail”访问权限，并验证服务商允许使用该 From 地址进行身份验证后的发件。例如，Fastmail 应用专用密码应使用 **Mail (IMAP/SMTP)** 权限创建，而不是只读权限。

### Claude 找不到邮箱

让 Claude 再次调用 \`inbox_list\`。如果邮箱没有出现，请在 MCPEmails dashboard 中检查其状态；如果应用专用密码已被撤销或轮换，请重新连接。如果邮箱已出现，但某项操作被拒绝，请重新连接 Claude 连接器，或为 API key 添加所需的 scope。

### 搜索结果少于预期

先使用 \`from\`、\`subject\`、\`text\`、\`since\` 和 \`before\` 等结构化字段，并在需要时指定要搜索的文件夹。不要把 Gmail 操作符语法直接用于通用 IMAP 搜索，并期待完全相同的行为。请记住，通用 IMAP 会忽略是否存在附件的筛选条件。

## 安全性：凭据不会交给 Claude

MCPEmails 会保存后续调用所需的 OAuth token 或 IMAP 应用专用密码，并使用 AES-256-GCM 进行静态加密。普通邮箱内容只会在工具运行时实时获取，不会在两次调用之间持久保存。通信使用 TLS；您也可以在服务商处撤销应用专用密码，或在 dashboard 中断开邮箱连接。

这种清晰的边界，正是应该使用 MCP 桥接，而不是把邮件凭据粘贴到聊天或本地配置中的主要原因：Claude 获得的是由 scope 限定的邮件能力，而不是邮箱的钥匙。有关存储和威胁模型的详情，请阅读[为什么“电子邮件永不存储”至关重要](/blog/why-email-never-stored-matters)以及[安全概览](/security)。

## 简要总结

Claude IMAP 连接器就是以 MCP 工具形式呈现给 Claude 的 IMAP/SMTP 邮箱连接。准备好安全服务器设置，创建可撤销的应用专用密码，在 MCPEmails 中连接邮箱，然后在 Claude 中添加 \`https://www.mcpemails.com/api/mcp\`。请先测试只读访问，再有意添加发送或破坏性 scope；如果服务商拒绝连接，请按照上述清单排查。

准备好试用了吗？[连接 IMAP 邮箱](/signup)，或者使用[服务商专用设置指南](/blog/connect-icloud-fastmail-imap-to-claude)查看 iCloud 和 Fastmail 的详细设置。`,
};
