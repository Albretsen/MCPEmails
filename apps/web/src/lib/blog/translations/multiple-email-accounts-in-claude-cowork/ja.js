const translation = {
  title: 'Claude Coworkで複数のメールアカウントを使う方法（個人用Outlookにも対応）',
  description:
    'Claude CoworkのGmailコネクタで使えるGoogleアカウントは1つだけで、Microsoft 365コネクタは個人用のOutlookアドレスを受け付けません。職場と個人の複数の受信トレイを、1つのCoworkタスクで扱う方法を説明します。',
  coverAlt: 'GmailやOutlook.comを含む職場と個人のメールアカウントを、1つのClaude Coworkタスクに接続した様子',
  content: `**Claude CoworkはClaudeのチャットと同じコネクタを使うため、メールに関する制限も同じです。Gmailコネクタで使えるGoogleアカウントは1つだけで、Microsoft 365コネクタで使えるのは職場のMicrosoft 365アカウントだけです。** 個人用のOutlook.comやHotmailのアドレス、2つ目のGmail、IMAPホスト上の会社のメールボックスには、カスタムコネクタが必要です。MCPEmailsのようなMCPサーバーを使えば、カスタムコネクタ1つで、接続したすべてのメールボックスをそれぞれの名前でCoworkタスクから使えます。

**目次：** [組み込みコネクタ](#coworkの組み込みメールコネクタで使えるもの) · [複数の受信トレイ](#1つのcoworkタスクで複数の受信トレイを使う) · [設定](#設定方法) · [権限](#送信は自分の管理下に置く) · [よくある質問](#よくある質問)

## Coworkの組み込みメールコネクタで使えるもの

Anthropicの[Coworkガイド](https://support.claude.com/en/articles/13345190-get-started-with-cowork)では、コネクタはチャットと同じ**カスタマイズ → コネクタ**ページで管理します。現在、ClaudeアプリではチャットとCoworkが同じ画面にまとめられています。Claudeアカウントで接続しているものが、そのままCoworkタスクで使えるものです。

- **Gmail。** ClaudeのGmailコネクタは、メールの閲覧、検索、下書き作成、送信ができます。[Anthropicの記事](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)には「接続したGoogleアカウント」へのアクセスと書かれており、2つ目のアカウントの追加には触れていません。このコネクタで個人用と仕事用のGmailを並べて使うことはできません。
- **Microsoft 365。** [Microsoft 365コネクタ](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector)は、企業のMicrosoft 365テナントに属するアカウント向けです。最初にグローバル管理者の同意が必要で、読み取り専用の状態から始まり、@outlook.comや@hotmail.comのような個人用Microsoftアカウントは接続できません。
- **それ以外のすべて。** Yahoo、iCloud、Fastmail、Zoho、IONOS、自社のメールサーバーには、Claudeの組み込みコネクタがありません。

つまり、職場のメールボックスに加えて個人用のOutlook.comや2つ目のGmailを使う、というよくある組み合わせは、組み込みコネクタだけではCoworkで扱えません。

## 1つのCoworkタスクで複数の受信トレイを使う

[カスタムコネクタ](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)はリモートのMCPサーバーで、AnthropicはClaude、Cowork、Claude Desktopで使えるとしています。ClaudeはAnthropicのクラウドからカスタムコネクタに接続するため、Coworkには1つ制約があります。\`claude_desktop_config.json\`で設定したローカルのMCPサーバーは、Coworkでは使えません。サーバーはインターネットからアクセスできる必要があります。

MCPEmailsはホスト型のMCPサーバーなので、この条件はすでに満たしています。各メールボックスを一度MCPEmailsに接続し、ClaudeにURLを1つ追加すれば、すべてのメールボックスをCoworkタスクで使えます。

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **プロバイダーは自由に組み合わせ可能。** Googleのアプリ パスワードで接続する[GmailとGoogle Workspace](/connect/gmail)、Microsoftでのログインで接続する[個人用のOutlook.com、Hotmail、Live](/connect/outlook)と[職場のMicrosoft 365](/connect/office365)、[iCloud](/connect/icloud)、[Yahoo](/connect/yahoo)、[Fastmail](/connect/fastmail)、[Zoho](/connect/zoho)、そして[IMAPとSMTP](/connect/imap)に対応したあらゆるメールボックス。
- **メールボックスごとに名前で識別。** タスクは\`inbox_list\`を呼び出して、接続済みのすべてのアドレスを表示名とともに確認します。そのため「info@と自分のOutlookを確認して」と頼むのに追加の設定は要りません。
- **正しいアドレスから返信。** 各メールボックスは、それぞれのプロバイダーから、それぞれの送信者名と署名で送信します。
- **保存しない。** メールはリクエストのたびにプロバイダーからその場で取得し、当社のサーバーには保存しません。

個人用のOutlook.comアドレスはMicrosoftでのログインで接続でき、管理者は不要です。職場のMicrosoft 365アカウントでは、IT管理者が組織としてMCPEmailsを一度承認する必要がある場合があります。何を承認するのかと、IT管理者に渡すリンクは[Microsoft 365の管理者の同意](/docs/microsoft-365-admin-consent)で説明しています。

## 設定方法

1. **メールボックスを接続します。** [MCPEmailsの無料アカウントを作成](/signup)し、**受信トレイ**を開いて**受信トレイを接続**を、メールボックスごとに1回ずつ行います。それぞれに「個人のOutlook」「Acme営業」のようなわかりやすい表示名を付けてください。Claudeはこの名前を読んでメールボックスを区別します。
2. **Claudeにコネクタを追加します。** **カスタマイズ → コネクタ**を開き、**+ 追加**をクリックして**カスタムコネクタを追加**を選びます。名前をMCPEmailsとし、\`https://mcpemails.com/api/mcp\`を入力して**続行**をクリックし、検出されたログイン設定はそのままにして**追加**をクリックします。TeamプランとEnterpriseプランではOwnerが追加し、メンバーは**接続**をクリックします。
3. **ログインしてアクセス権を選びます。** 読むだけのタスクなら**読み取り専用**、下書きと送信を加えるなら**標準**、予約送信、フォルダー、削除まで加えるなら**フルアクセス**を選びます。
4. **Coworkで有効にします。** タスクで**+**メニューを開き、コネクタの中のMCPEmailsをオンにします。

各画面は[Claudeの設定ガイド](/blog/connect-claude-to-email)で、カスタムコネクタにできることとできないことは[Claudeのカスタムコネクタとは](/blog/claude-custom-connectors-explained)で確認できます。

Cowork自体は、ClaudeのPro、Max、Team、Enterpriseプランで使えます。MCPEmailsのFreeプランで接続できるメールボックスは1つです。複数のメールボックスには有料プランが必要で、[料金ページ](/pricing)に一覧があります。

## 送信は自分の管理下に置く

Coworkタスクは多くの手順を自分で進めるため、確認なしで何をしてよいかを最初に決めておきます。

- **Claudeで。** AnthropicのCoworkガイドによると、コネクタのツールごとに**常に許可**、**承認が必要**、**ブロック**を設定できます。MCPEmailsの送信ツールを**承認が必要**にすれば、Claudeは送信のたびに止まって確認します。TeamプランとEnterpriseプランでは、組織の設定で書き込みツールに承認が必須になっている場合もあります。
- **MCPEmailsで。** メールボックスの**送信前の確認**をオンにし、方式を選びます。**先にチャットで確認する**では、Claudeがメールを表示してあなたの承諾を待ちます。**mcpemails.comで承認**では、ワークスペースのオーナーまたは管理者がログインして承認するまで各送信が保留されます。この承認はClaudeが代わりに行うことはできません。詳しくは[AIによるメール送信を人が承認する方法](/blog/approve-ai-agent-email-sends)をご覧ください。
- **まず下書きに。** メールの作成を頼むと、MCPEmailsはそのメールボックスに下書きとして保存するようClaudeに指示します。送信される前に、内容を読んで編集できます。

メールは他人が書いたもので、中にはAIを操ろうとして書かれたものもあります。メールを読み、送信もできるタスクでは、これらの確認のどれかをオンにしておいてください。

## 複数の受信トレイ向けのプロンプト

> MCPEmailsを使って、職場の受信トレイと個人のOutlookを確認し、この2日間に届いたメールのうち自分が返信すべきものをすべて一覧にしてください。1つのリストにまとめ、各行にどの受信トレイかを付けてください。送信や移動は一切しないでください。

> MCPEmailsを使って、来週のフライトの予約確認メールを探してください。接続しているすべての受信トレイを検索し、どの受信トレイにあるか教えてください。

> MCPEmailsを使って、最新の問い合わせへの返信をsales@から下書きし、下書きとして保存してください。送信はしないでください。

同じ要約を頼まずに毎朝受け取りたい場合は、1つ目のプロンプトをスケジュールに設定します。Claudeのスケジュールタスクは[ClaudeとChatGPTで毎日のメール要約を自動化する方法](/blog/daily-email-briefing-with-claude-and-chatgpt)で説明しています。ClaudeのチャットとChatGPTでの同じ設定は、[ClaudeとChatGPTで複数のメールアカウントを使う方法](/blog/multiple-email-accounts-in-claude-and-chatgpt)で説明しています。

## よくある質問

**Claude Coworkで2つのGmailアカウントを使えますか？**
Claudeの組み込みGmailコネクタでは使えません。Anthropicはこのコネクタについて、接続した1つのGoogleアカウントにアクセスすると説明しています。両方のアカウントをGoogleのアプリ パスワードでMCPEmailsに接続し、MCPEmailsをカスタムコネクタとして追加すれば、Coworkタスクから両方を使えます。

**Coworkで個人用のOutlook.comやHotmailのメールを読めますか？**
ClaudeのMicrosoft 365コネクタでは読めません。このコネクタは個人用Microsoftアカウントを受け付けないためです。アドレスをMicrosoftでのログインでMCPEmailsに接続し、MCPEmailsをClaudeに追加してください。手順は[ClaudeをHotmail・Outlook.comに接続する方法](/blog/connect-claude-to-outlook-com-hotmail)にあります。

**カスタムコネクタはCoworkで使えますか？**
はい。Anthropicは、カスタムコネクタをClaude、Cowork、Claude Desktopで使えるとしています。ただし、インターネットからアクセスできるリモートサーバーである必要があります。デスクトップの設定ファイルで指定したローカルサーバーは、Coworkでは使えません。

**メールボックスごとにコネクタが必要ですか？**
いいえ。MCPEmailsのコネクタ1つで、ワークスペース内のすべてのメールボックスを扱えます。同じURLが、Claudeのチャット、Cowork、ChatGPT、その他のMCPクライアントで使えます。

**ClaudeはCoworkからメールを送信できますか？**
はい。標準またはフルアクセスで接続したメールボックスなら、どれからでも送信できます。各コネクタの送信の扱いは[Claudeはメールを読める？送信もできる？](/blog/can-claude-read-my-email#claudeでメールを送信できる)で比較しています。

## 次のステップ

[無料で始める](/signup)から登録し、いちばんよく確認するメールボックスを接続して、MCPEmailsをClaudeに追加し、今日返信が必要なものをCoworkタスクに聞いてみてください。複数の答えではなく1つの答えにまとめたくなったら、ほかの受信トレイも追加しましょう。`,
};

export default translation;
