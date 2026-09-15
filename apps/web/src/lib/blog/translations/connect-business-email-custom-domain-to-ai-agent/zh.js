const translation = {
  title: '把自有域名的企业邮箱连接到你的 AI 智能体（IMAP 配置指南）',
  description:
    '面向 you@yourcompany.com 的配置指南：查清究竟是谁在托管你的邮件，连接 Google Workspace、Zoho、Fastmail、Migadu、Titan、Rackspace、IONOS 或 cPanel，并在智能体回信之前设好发件人名称。',
  coverAlt:
    '使用 MCP Emails 把自有域名的企业邮箱连接到 AI 智能体',
  content: `> **Outlook 和 Microsoft 365 仍在开发中。** 目前还无法在生产环境中连接。如果你的企业邮箱其实是一个 Microsoft 租户，本指南可以帮你确认这一点，但今天还连不上。

几乎所有"把邮箱连接到 AI 智能体"的教程都默认你的地址以 gmail.com 结尾。企业邮件完全不同：域名并不会告诉你邮箱由谁托管，是否允许邮件客户端登录可能由别人说了算，而智能体发出的每一封邮件都会以你的名义抵达客户。这是一份写给 you@yourcompany.com 的指南。

**按服务商查看：** Google Workspace、Zoho Mail、Fastmail 和 Migadu、Titan Email、Rackspace Email、IONOS、cPanel 与共享主机。

## 为什么企业邮箱比个人邮箱更难连

- **应用访问权限可能掌握在别人手里。** Google Workspace 管理员可以为整个域名关闭应用专用密码。Zoho 出厂时默认关闭 IMAP，Titan 默认关闭第三方访问。这三种情况下，登录被拒绝的样子和密码错误一模一样。
- **你的地址并不指向你的邮件服务器。** 我们自己的 hello@mcpemails.com 由 Migadu 托管，而域名本身完全看不出来。凭猜测填写 \`mail.yourcompany.com\` 通常什么也连不上。
- **SMTP 不一定是 IMAP 的镜像。** Rackspace 的收发都在同一个不带品牌的主机上；OVH Hosted Exchange 根本不监听 465，必须用 587 加 STARTTLS。
- **发件人名称是客户看得见的。** 一封没有署名就发出去的回信，最后会变成一张工单。

## 第 1 步：查清究竟是谁在托管你的邮件

MCP Emails 会替你回答这个问题。在 IMAP 连接表单里输入地址，停顿半秒，它会按顺序查询四个来源：一张记录了真实连接失败服务商的对照表、你域名的 RFC 6186 服务记录、与该表比对的 MX 记录，以及 Mozilla 的自动配置数据库。只有收件和发件两半都解析成功，才会自动填写。

如果想先自己确认：

\`\`\`
dig +short MX yourcompany.com
dig +short SRV _imaps._tcp.yourcompany.com
\`\`\`

服务记录会直接给出主机和端口，但多数域名根本没有发布，所以通常只能看 MX 的结果：

- 以 \`.l.google.com\` 结尾，或 \`smtp.google.com\`：Google Workspace。
- \`mx.zoho.com\` 或其区域变体：Zoho Mail。
- \`aspmx1.migadu.com\`：Migadu。\`mx1.titan.email\`：Titan，无论你是以哪个品牌买的。
- 托管在 Microsoft 的 MX 名称：Microsoft 365 租户，目前还不能连接。
- 你的主机商自己的服务器名：cPanel 或 Plesk 邮箱。

## 第 2 步：按你的服务商操作

在控制台中打开 **Inboxes → Connect Inbox**，选择与你相符的方式。

### Google Workspace

Workspace 默认通过 **Google 应用专用密码** 以 IMAP 连接（\`imap.gmail.com\` 端口 993，\`smtp.gmail.com\` 端口 465），也可以使用 OAuth。只有开启两步验证后才会出现应用专用密码，而管理员可以为整个域名关闭它，那样 Google 的相应页面对你就是不存在的。管理员还可以在"安全性 → API 控制"中限制第三方 OAuth 应用，这会在 Google 自己的授权页面就拦下这条路。如果两条路都被关闭，请联系管理员。

### Zoho Mail

先**启用 IMAP 访问**：设置 → 邮件账户 → 选择地址 → IMAP 访问。它默认关闭，而且按邮箱逐个设置，所以为自己打开并不会让同事也能用。如果开启了双重验证，还要生成一个**应用专用密码**。

主机名取决于 Zoho 从不放在一起展示的两件事：账户位于它六个区域数据中心中的哪一个（\`.com\`、\`.eu\`、\`.in\`、\`.com.au\`、\`.jp\`、\`zohocloud.ca\`），以及它是否是自有域名的付费组织账户，后者要用该区域的 \`imappro\` 和 \`smtppro\`。MCP Emails 会同时询问这两项并拼出主机名。

### Fastmail 和 Migadu

Fastmail 使用带 Mail（IMAP/SMTP）权限的**应用密码**，在 Settings → Privacy & Security 生成：\`imap.fastmail.com\` 端口 993，\`smtp.fastmail.com\` 端口 465。如果某篇教程让你用 OAuth 登录 Fastmail，那是过时的内容。

Migadu 使用**邮箱密码**，而不是你的 Migadu 账户密码，后者只管理域名和账单，不对任何邮件做认证。别名没有密码，所以如果你想用的地址是别名，请在邮箱上添加一个**身份（identity）**并为它单独设置密码。主机是 \`imap.migadu.com\` 和 \`smtp.migadu.com\`。[iCloud 与 IMAP 指南](/blog/connect-icloud-fastmail-imap-to-claude)里有应用密码的详细步骤。

### Titan Email

在你打开一个开关之前，Titan 会拒绝所有邮件客户端：**Settings → Enable Titan on Other Apps**。在那之前登录失败的样子就像密码错误。Titan 还会以其他公司的品牌出售，所以你在哪里购买决定了用哪些主机名：GoDaddy 以 Professional Email 的名义出售，用 \`imap.secureserver.net\` 和 \`smtpout.secureserver.net\`；Hostinger 以 Titan 的名义出售，用 \`imap.titan.email\`。Titan 自己的排错文档让你关闭双因素验证，其实不必，因为它支持应用密码。

### Rackspace Email

无论你的域名是什么，收发两端的主机都是 \`secure.emailsrvr.com\`。这个名字不带任何 Rackspace 品牌，于是有人把它"改正"成看起来更合理的名字，结果什么都用不了。请使用 Cloud Office 控制面板中的邮箱密码。一旦开启多因素认证，该密码在 IMAP 和 SMTP 上就会失效，却仍然能登录网页版邮箱，这时你需要一个应用密码。Rackspace 同时还销售 Hosted Exchange 并转售 Microsoft 365，这两者在这里都无法连接。

### IONOS

IONOS 为**每个地址单独设置邮箱密码**，在控制面板的 Email 中设置。你的 IONOS 账户登录名（往往也是一个邮箱地址）只用于认证控制面板，别无他用，而这一个混淆就占了我们日志里大部分的 IONOS 失败。IONOS 在 993 加 TLS 和 143 加 STARTTLS 上都能响应，所以在两者之间来回切换纯属浪费时间：有一个工作区连续尝试了十二次并不断切换，而问题自始至终都是密码。

### cPanel 与共享主机

根本不存在 cPanel 邮件服务，只有你主机商的服务器，因此控制面板是主机名的唯一权威来源。打开 **Email Accounts**，点击 **Connect Devices**，从 **Mail Client Manual Settings** 中复制数值，使用安全的 SSL/TLS 那一列。用户名是完整的邮箱地址，绝不是你的 cPanel 登录名，凭据则是邮箱密码。没有应用密码，也没有 OAuth。Plesk 的做法完全相同。

## 当自动识别失败、需要你自己填写时

每个协议给 MCP Emails 四样东西：主机、端口、安全模式，以及作为用户名的完整邮箱地址。这些约定是固定的，表单还会让端口和安全模式保持同步，避免两者脱节：

- IMAP **993** 是隐式 TLS；IMAP **143** 是 STARTTLS。
- SMTP **465** 是隐式 TLS；SMTP **587** 是 STARTTLS；在只提供这一种方式的小型主机上，**25** 也是 STARTTLS。

把它们弄混曾是通用连接失败的最大单一原因：在 993 上使用 STARTTLS 会一直等待一个纯 TLS 监听端永远不会发出的问候，而在 143 上使用隐式 TLS 则会握手失败。现在你不必一次就填对。凡是从未建立起可用会话的连接，都会在其他标准传输方式上重试，每个协议最多三次，并从你指定的那一种开始。被服务器拒绝的密码则绝不重试：重发只会让服务商用于锁定账户的失败登录次数翻三倍。

发信还会协商一件你永远看不到的事。Exchange 类主机只声明 **LOGIN** 而没有 PLAIN，因此 MCP Emails 会读取服务器声明的机制，两者都有时优先用 PLAIN，否则回退到 LOGIN。被拒绝的认证机制绝不会被当成密码错误报告给你。

## 在智能体回信之前设好发件人名称

智能体发出的每一封邮件，其 From 头都来自同一个字段：收件箱的显示名称，位于地址之前。留空的话，邮件就只带一个光秃秃的地址发出去。

在收件箱详情页按收件箱设置它，那里的预览会显示收件人实际看到的邮件头。智能体也可以用 \`signature_set\` 的 \`sender_name\` 参数来设置。名称上限为 100 个字符，控制字符和尖括号会被去掉，这样名称就无法把第二个地址夹带进邮件头。顺便也设置一个签名：参见[为 Claude 设置邮件签名](/blog/email-signatures-for-claude)。

## 企业邮件常见故障排查

- **登录被拒，但密码肯定没错。** 先查开关再查密码：Zoho 的 IMAP 访问、Titan 的第三方访问、Workspace 的应用专用密码、Rackspace 的多因素认证。
- **你用错了密码。** Migadu、IONOS、Rackspace 和 cPanel 都把控制面板登录名与邮箱密码分开，而两者通常都是邮箱地址。
- **连接超时而不是失败。** 那是主机或端口的问题，不是凭据。请回到服务商自己的面板重新确认主机名。
- **能收信却发不出去。** 发件那一半有自己的主机、端口和安全模式，有些主机根本不监听 465。另外确认你已授予 \`send:email\`。
- **它其实是 Microsoft 365 邮箱。** 无论是直接购买，还是由 GoDaddy、IONOS 或 Rackspace 转售，它仍然是 Microsoft 租户，目前还不能连接。

[服务商对照表](/docs/providers)和[各服务商页面](/connect)提供逐家的细节。

## 常见问题

**我怎么知道公司邮件到底托管在哪里？**
查询域名的 MX 记录，或者把地址输入连接表单，让自动识别替你检查 MX 和服务记录。

**可以连接 Google Workspace 地址吗？**
可以，用 Google 应用专用密码走 IMAP，或者用 OAuth。两条路管理员都能封：应用专用密码可按域名整体关闭，第三方 OAuth 应用可在 API 控制中受限。

**如果我的主机商没有公布 IMAP 设置怎么办？**
自己填：主机、端口、安全模式，以及作为用户名的完整邮箱地址。如果第一种传输方式没有响应，系统会自动尝试其他标准组合。

**MCP Emails 会存储公司的邮件吗？**
不会。邮件内容在每次请求时从你的服务商实时获取，随后丢弃。只有加密后的服务商凭据会被保留。

**免费方案的一个收件箱够用吗？**
Free 可连接 1 个收件箱。Personal 每月 5 美元，3 个收件箱且没有每月操作上限；Pro 每月 15 美元，收件箱数量不限。详见[价格](/pricing)。

## 下一步

[创建免费账户](/signup)，连接你的企业邮箱，设好发件人名称，再把 \`https://mcpemails.com/api/mcp\` 添加到你的客户端。然后先让它调用 \`inbox_list\` 并总结昨天的未读邮件，再考虑授予任何可以发信的权限。`,
};

export default translation;
