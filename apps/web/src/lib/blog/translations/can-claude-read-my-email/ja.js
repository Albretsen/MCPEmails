const translation = {
  title: 'Claudeでメールを読む・送信することはできる？メールボックス別に解説',
  description:
    'GmailとMicrosoft 365の職場アカウントなら、Claude純正のコネクタで可能です。Yahoo、iCloud、Outlook.com、IMAPのメールボックスや複数のプロバイダーをまとめて使うには、MCPサーバーが必要です。',
  coverAlt:
    'Gmail、Microsoft 365、Yahoo、iCloud、IMAPのメールボックスでメールを読み、送信するClaude',
  content: `**はい、Claudeはメールを読むことも送信することもできます。ただし、Claudeに接続したメールボックスに限られます。** Claudeには純正のメールコネクタが2つあり、1つはGmail用、もう1つはMicrosoft 365の職場アカウント用です。Gmailコネクタはメールの読み取り、検索、送信ができ、初期設定では送信のたびに承認を求めます。Microsoft 365コネクタは読み取りと検索ができ、送信は管理者が書き込みツールを有効にしてからになります。Yahoo、iCloud、個人用のOutlook.comアドレス、IMAPホスト上の会社のメールボックス、または複数のプロバイダーを1つの接続でまとめて使う場合は、MCPEmailsのようなMCPサーバーが必要です。

このページでは、あなたがどのケースに当てはまるかを整理します。AnthropicとGoogleの製品に関する情報は、2026年10月に各社のページで確認したものです。これらの製品は頻繁に変わるため、各セクションに根拠となるページへのリンクを載せています。

**目次：** [Gmail](#gmailclaude純正のコネクタ) · [Microsoft 365](#outlookとmicrosoft-365職場アカウントのみ) · [純正コネクタで足りない部分](#純正コネクタが対応していないもの) · [MCPEmails](#mcpemailsで足りない部分を補う方法) · [送信](#claudeでメールを送信できる) · [FAQ](#faq)

## Gmail：Claude純正のコネクタ

ClaudeのGmailコネクタは、Claudeのコネクタディレクトリに「Google製」として掲載されており、GoogleのGmail MCPサーバー(\`gmailmcp.googleapis.com\`)で動作します。Claudeのコネクタ設定から有効にし、Googleアカウントでログインします。

[Anthropicのヘルプ記事](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)と[ディレクトリの掲載ページ](https://claude.com/connectors/gmail)によると、次のことができます。

- **読み取りと検索**：普段の言葉で質問してメールを探し、スレッド全体を読めます。
- **下書き、送信、返信、転送**：Anthropicの記事には4つすべてが記載されています。
- **整理**：ラベルを付けたり、メッセージやスレッドをゴミ箱に移動したりできます。
- **事前確認**：初期設定では、送信、返信、転送のたびにClaudeが承認を求めます。TeamプランとEnterpriseプランでは、まずオーナーが組織でコネクタを有効にし、メンバーが確認なしでこれらの操作を実行できるかどうかも決めます。

できないこと：

- **添付ファイル**：Anthropicの記事によると、Claudeが見られるのは添付ファイルのメタデータだけで、中身は読めません。
- **Googleアカウントは1つ**：記事では「接続したGoogleアカウント」へのアクセスとして説明されており、2つ目を追加する方法には触れていません。

Googleは同じGmail MCPサーバーを、[Workspace Developer Preview Program](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)の一部としても公開しています。このプログラムの参加者は、自分のGoogle Cloud OAuthクライアントを使って、ほかのMCPクライアントに自分で追加できます。こちらの版で文書化されているツールは、検索、スレッドの読み取り、下書きの作成、ラベルの変更で、送信ツールはありません。下書きを確認し、Gmailから送信する形です。

メールボックスがGmailだけで、使うAIアプリもClaudeだけなら、純正コネクタで十分かもしれません。

## OutlookとMicrosoft 365：職場アカウントのみ

ClaudeのMicrosoft 365コネクタは、企業のMicrosoft 365テナントに属するアカウントのOutlookメールを読み取ります。

- **読み取りと検索**の対象は、メインのメールボックス、そのアーカイブフォルダー、アクセス権のある共有メールボックスです。
- **送信は初期状態でオフです。** コネクタは読み取り専用で始まります。書き込みツールを有効にすると、Claudeはメールの送信と転送、下書きの作成、編集、削除ができるようになります。添付ファイル付きのメッセージは書き込みツールで拒否されます。
- **管理者が承認する必要があります。** 組織内の誰かが接続する前に、Microsoft Entraのグローバル管理者が同意する必要があり、書き込みツールを使う前にもう一度同意が必要です。
- **個人アカウントは使えません。** [Anthropicの記事](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector)には、@outlook.comや@hotmail.comのようなアドレスでは接続できないと明記されています。

つまり、個人用のOutlook.com、Hotmail、LiveのアドレスをClaudeにつなぐ純正の方法はありません。使える方法は[ClaudeをOutlook.comとHotmailに接続する](/blog/connect-claude-to-outlook-com-hotmail)で説明しています。

## 純正コネクタが対応していないもの

2つを合わせても、次のメールボックスはどちらの純正コネクタでも使えません。

- **Yahoo MailとAOL**
- **iCloudメール**
- **個人用のOutlook.com、Hotmail、Live**のアドレス
- **IMAPホスト上の会社のメールボックス**：Fastmail、Zoho Mail、IONOS、STRATO、cPanelのホスティング、または自社サーバー
- **2つ目のGoogleアカウント**：Anthropicの記事は接続済みのGoogleアカウント1つについて説明しており、別のアカウントの追加には触れていません。
- **複数のプロバイダーを1つの接続で**：info@、自分のアドレス、個人のGmailを1回の質問でまとめて検索するような使い方

FastmailとZoho Mailは独自のMCPサーバーを提供しており、カスタムコネクタとしてClaudeに追加できます。ただし、それぞれ自社のメールボックスにしか届きません。Claudeのどちらのヘルプ記事にも、送信を後の時刻に予約する機能は書かれていません。[ClaudeとChatGPTの純正コネクタの比較](/native-connectors-vs-mcp)では、各機能を出典と確認日付きで一覧にしています。

## MCPEmailsで足りない部分を補う方法

MCPEmailsはホスト型のMCPサーバーです。各メールボックスを一度MCPEmailsに接続し、ClaudeにコネクタURLを1つ追加すれば、Claudeは接続したすべてのメールボックスでメールを読み、検索し、送信できます。

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **どのプロバイダーでも**：[Yahoo Mail](/connect/yahoo)、[iCloudメール](/connect/icloud)、[個人用のOutlook.com](/connect/outlook)と[職場のMicrosoft 365](/connect/office365)（どちらもMicrosoftでログイン）、Googleのアプリ パスワードを使う[Gmail](/connect/gmail)、アプリ パスワードを使う[Fastmail](/connect/fastmail)、[Zoho Mail](/connect/zoho)、そして[IMAPとSMTP](/connect/imap)に対応したあらゆるメールボックス。[プロバイダー一覧](/connect)には、ホストごとの設定ページがあります。
- **1つのチャットで複数のメールボックス**：Claudeは\`inbox_list\`を呼び出し、接続済みのアドレスをすべて名前で把握します。そのため「sales@と自分のGmailを検索して」が1つの会話で通じます。設定方法は[Claudeで複数のメールアカウントを使う](/blog/multiple-email-accounts-in-claude-and-chatgpt)で説明しています。
- **正しいアドレスから送信**：各メールボックスはそれぞれのプロバイダー経由で、独自の差出人名と署名を付けて送信します。
- **予約送信と整理**：フルアクセスを許可すれば、Claudeは接続済みのすべてのメールボックスで予約送信をしたり、メールの移動、フラグ付け、アーカイブ、削除をしたりできます。
- **添付ファイルを読む**：Claudeは[PDF、CSV、HTMLの添付ファイルからテキストを取り出せます](/blog/extract-email-attachments-for-ai)。ファイルは保存されません。
- **ほかのアプリでも同じメールボックス**：標準的なMCPサーバーなので、一度の設定でChatGPT、Cursor、VS Codeなどのほかのクライアントでも使えます。

メールはリクエストのたびにプロバイダーからリアルタイムで取得され、保存されません。保存されるのは、各メールボックスの暗号化された認証情報、予約したメッセージ（送信されるまで）、確認待ちの送信（承認、却下、期限切れになるまで）です。データはストックホルムに保存されます。

### Claudeに追加する

1. [MCPEmailsの無料アカウントを作成](/signup)し、**受信トレイ**から**受信トレイを接続**を選んでメールボックスを接続します。
2. claude.aiまたはClaude Desktopで**カスタマイズ → コネクタ**を開き、**+ 追加**、続いて**カスタムコネクタを追加**をクリックします。名前をMCPEmailsにして\`https://mcpemails.com/api/mcp\`を入力し、**続行**をクリックします。検出されたログイン設定はそのままにして**追加**をクリックします。
3. Claudeに求められたらMCPEmailsにログインし、Claudeに与えるアクセス範囲を選びます。**読み取り専用**、**標準**（送信と下書きを追加）、**フルアクセス**（予約送信、フォルダー、削除を追加）のいずれかです。

[Claudeの設定手順ガイド](/blog/connect-claude-to-email)では画面ごと、プロバイダーごとに手順を説明しています。コネクタのエラーについては[Claudeの設定ページ](/docs/claude)を参照してください。

## Claudeでメールを送信できる？

はい。Claudeはメールを読むことしかできないと書いているページはまだ多いものの、Anthropicの最新のヘルプ記事では送信もできるとされています。Claudeが送信できるかどうかは、コネクタの種類と、接続時に何を許可したかで決まります。

### ClaudeのGmailコネクタ

2026年10月下旬に再確認した[AnthropicのGoogle Workspaceの記事](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)によると、Gmailコネクタはメールの下書き、保存済み下書きの一覧表示、送信、返信、転送ができます。初期設定では、送信、返信、転送のたびにClaudeが承認を求めます。TeamプランとEnterpriseプランでは、オーナーがコネクタを有効にし、メンバーが毎回の確認なしでこれらの操作を実行できるかどうかを決めます。

送信元は、接続した1つのGoogleアカウントです。添付ファイルについてClaudeが見られるのはメタデータだけで、中身は読めません。

### ClaudeのMicrosoft 365コネクタ

最初は読み取り専用です。書き込みツールを有効にすると（より広い権限についてMicrosoft Entraのグローバル管理者の承認が必要です）、Claudeはメールの送信と転送、下書きの作成、編集、削除ができるようになります。書き込みツールは添付ファイル付きのメッセージをすべて拒否し、個人用のOutlook.comやHotmailのアドレスはそもそも接続できません。

### MCPEmailsでの送信のしくみ

MCPEmailsを通すと、ClaudeはGmail、Outlook、iCloud、Yahoo、会社のIMAPメールボックスなど、接続済みのどのメールボックスからでも送信できます。どこまで許可するかは、次の4つで決められます。

- **付与するアクセス範囲**：ClaudeにMCPEmailsを追加するときに、**読み取り専用**（Claudeは送信も下書きもできない）、**標準**（下書きと送信を追加）、**フルアクセス**（予約送信、フォルダー、削除を追加）から選びます。接続するメールボックスを一部に限定することもできます。
- **まず下書き**：Claudeにメールを書くよう頼むと、MCPEmailsはそのメールを送信せず、メールボックスに下書きとして保存するようClaudeに指示します。ClaudeとChatGPTでは、下書きはチャット内の編集可能なカードとして開き、宛先、件名、本文を変更して保存することも、数秒間取り消せる状態で送信することもできます。下書きはメールアプリの下書きフォルダーにも入ります。
- **送信前の確認**：ダッシュボードでメールボックスごとに設定します。**先にチャットで確認する**にすると、Claudeは会話の中でメールを見せ、あなたが了承するまで送信を待ちます。**mcpemails.comで承認**にすると、送信、返信、転送、下書きの送信をすべて保留し、ワークスペースのオーナーか管理者がブラウザーでMCPEmailsにログインして承認するまで送られません。Claude自身は承認できません。詳しくは[AIによるメール送信を人が承認する方法](/blog/approve-ai-agent-email-sends)をご覧ください。
- **送信ごとの受領通知**：Claudeは送信元アドレス、宛先、件名、送信済みフォルダーにコピーが残ったかどうか、または送信に失敗した理由を表示します。

各メールボックスはそれぞれのプロバイダー経由で送信するため、メッセージはあなたの実際のアドレスから、あなたの差出人名と署名付きで送られ、返信もいつもの受信トレイに届きます。Claudeは[メールの予約送信](/blog/schedule-email-with-claude-and-chatgpt)もできます。

### Claudeは確認なしでメールを送信できる？

- **ClaudeのGmailコネクタ**は、初期設定では送信、返信、転送のたびに確認を求めます。
- **ClaudeのMicrosoft 365コネクタ**は、書き込みツールを有効にするまで一切送信できません。
- **MCPEmails**が追加の確認なしで送信するのは、送信のアクセス権を付与し、かつそのメールボックスで**送信前の確認**をオフにしている場合だけです。Claude自体のツール権限でもう一段階制御できます。**カスタマイズ → コネクタ**で、MCPEmailsのツールごとに「常に許可」「承認が必要」「ブロック」を設定できます。

どの方法を使う場合でも、メールの中身は指示ではなくデータとして扱ってください。メッセージにはAIを操るために書かれた文章が含まれていることがあり、確認のステップがあれば、メールボックスから何かが送られる前に気づけます。リスクの詳細は[メールへのアクセスの安全性ガイド](/blog/is-it-safe-to-give-ai-agent-email-access)で説明しています。

## FAQ

**Claudeは私のメールを読めますか？**
はい、メールボックスを接続すれば読めます。GmailとMicrosoft 365の職場アカウントはClaude純正のコネクタで接続します。Yahoo、iCloud、個人用のOutlook.com、IMAPのメールボックスは、MCPEmailsのようなMCPサーバーをカスタムコネクタとしてClaudeに追加して接続します。

**Claudeはメールを送信できますか？**
はい。ClaudeのGmailコネクタは送信、返信、転送ができ、初期設定ではまず承認を求めます。Microsoft 365コネクタは書き込みツールを有効にすると送信できます。MCPEmails経由では、接続時に送信のアクセス権を与えていれば、Claudeは接続済みのどのメールボックスからでも送信でき、書くよう頼まれたメールはまず下書きとして保存します。

**ClaudeのGmailコネクタでメールを送信できますか？**
はい。AnthropicはGmailコネクタの機能として送信、返信、転送を挙げており、いずれも初期設定では承認を求めます。送信元は接続した1つのGoogleアカウントです。

**ClaudeでGmailを読めますか？**
はい。Claude純正のGmailコネクタで、接続したGoogleアカウントのメールを読めます。複数のGoogleアカウントを使いたい場合や、同じチャットでGmailとほかのプロバイダーを一緒に使いたい場合は、Googleのアプリ パスワードを使ってMCPEmails経由で接続してください。

**ClaudeでOutlookやHotmailのメールにアクセスできますか？**
職場や学校のMicrosoft 365アカウントは、管理者が承認すればClaudeのMicrosoft 365コネクタを使えます。個人用のOutlook.comやHotmailのアドレスは使えません。MCPEmailsはどちらもMicrosoftでログインして接続できますが、職場アカウントの場合は、組織として一度アプリを承認するためにIT管理者が必要になることがあります。

**ClaudeでYahooやiCloudのメールを読めますか？**
純正コネクタでは読めません。YahooまたはAppleのアプリ パスワードでメールボックスをMCPEmailsに接続し、MCPEmailsをClaudeに追加してください。手順は[ChatGPTとClaudeでYahoo Mailを使うガイド](/blog/connect-yahoo-mail-to-chatgpt-and-claude)にあり、[ChatGPTのiCloudメールプラグイン解説](/blog/chatgpt-icloud-mail-plugin)ではOpenAIの新しいiCloudの選択肢と比較しています。

**Claudeで複数のメールアカウントを同時に読めますか？**
はい、MCPEmails経由で可能です。接続したメールボックスはすべて1つのコネクタURLでClaudeに表示され、Claudeは呼び出しのたびにどのメールボックスかを指定します。

**MCPEmailsはメールを保存しますか？**
いいえ。メッセージの内容はリクエストのたびにプロバイダーからリアルタイムで取得され、回答を返したら破棄されます。保存される情報は[セキュリティ](/security)のページをご覧ください。

## 次のステップ

メールがすべて1つのGmailアカウントにあるなら、まずClaudeのGmailコネクタを試してください。それ以外の場合は、[無料で始めて](/signup)メールボックスを接続し、Claudeに\`https://mcpemails.com/api/mcp\`を追加して、今日返信が必要なメールを聞いてみてください。`,
};

export default translation;
