const translation = {
  title: 'ClaudeをHotmail・Outlook.comに接続する方法（個人用Microsoftアカウント）',
  description:
    'ClaudeのMicrosoft 365コネクタは個人用Microsoftアカウントに対応していません。Hotmail、Outlook.com、Live、MSNの受信トレイをClaudeに接続するには、Microsoftでログインし、カスタムコネクタのURLを1つ追加します。',
  coverAlt: 'MCPEmailsを通じて個人用のOutlook.comまたはHotmailの受信トレイに接続したClaude',
  content: `個人用のOutlook.com、Hotmail、Live、MSNのアドレスをClaudeに接続するには、**Microsoftで接続**でメールボックスをMCPEmailsに追加し、URLを1つカスタムコネクタとしてClaudeに追加します。Claude独自のMicrosoft 365コネクタは法人向けのMicrosoftテナントが前提で、Anthropicは個人用Microsoftアカウントでは使えないとしています。カスタムコネクタにはこの条件がないため、昔からあるhotmail.comのアドレスも、新しいoutlook.comのアドレスと同じように使えます。

このガイドは、Claudeで個人用Microsoftアカウントを使う場合の手順です。職場や学校のMicrosoft 365アカウントのメールを使う場合は、[OutlookとMicrosoft 365のガイド](/blog/connect-outlook-microsoft-365-ai-agent-mcp)をご覧ください。

## ClaudeのMicrosoft 365コネクタが個人用アカウントを受け付けない理由

Anthropicの[Microsoft 365コネクタのヘルプページ](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector)には、接続の前提として2つの条件が書かれています。

- アカウントが、Microsoft Businessプランに紐づくMicrosoft Entraテナントに属していること。
- そのテナントのグローバル管理者が、先に連携を承認していること。

同じページには、@outlook.comや@hotmail.comのアドレスなど、個人用Microsoftアカウントは接続に使えないとも書かれています。個人用アカウントには法人テナントも管理者もないため、承認する人がおらず、設定を変えて使えるようにする方法もありません。このコネクタは組織向けに作られたもので、SharePoint、OneDrive、Outlook、Teamsを検索し、管理者が書き込みツールを有効にするまでは読み取り専用の権限で動きます。

メールボックス自体に問題があるわけではありません。Claudeには別の経路が必要なだけです。

## 必要なもの

- Outlookのメールボックスがある個人用Microsoftアカウント：outlook.com、hotmail.com、live.com、msn.comのアドレス。hotmail.co.uk、outlook.de、live.noのような国別のドメインも含みます。
- Web版のClaudeまたはClaude Desktop。Anthropicはすべてのプランでカスタムコネクタを提供しており、Freeプランでもカスタムコネクタを1つ使えます。
- MCPEmailsのアカウント。[無料で始める](/signup)から登録し、タブを開いたままにしておきます。

MCPEmailsはこの2つの間に入ります。一方ではModel Context ProtocolでClaudeとやり取りし、もう一方ではMicrosoft Graphを通じてOutlook.comのメールボックスとやり取りします。

## ステップ1：Outlook.comまたはHotmailの受信トレイを接続する

1. MCPEmailsのダッシュボードで**受信トレイ**を開き、**受信トレイを接続**をクリックします。
2. **Outlook**を選び、**Microsoftで接続**をクリックします。
3. Microsoftのページで、Outlook.com、Hotmail、Live、MSNのアドレスでログインします。アカウントで2段階認証を使っている場合は、それも完了します。
4. アクセス許可の内容を確認して承認します。Microsoftからは、MCPEmailsにメールの読み取りと変更、ユーザーとしてのメール送信、このアクセスの維持、基本プロフィールとメールアドレスの表示を許可するかどうかを尋ねられます。

ダッシュボードに戻ると、受信トレイが接続された状態になっています。個人用アカウントでは管理者の操作は不要で、MicrosoftのパスワードをMCPEmailsに入力することもありません。

### IMAPやアプリ パスワードは使わない

古いガイドの多くは、アプリ パスワードを作成してOutlookのIMAP設定を入力するよう説明しています。この方法はもう使えません。Microsoftは2024年9月16日に、[Microsoft以外のメールアプリでのOutlookアカウントのパスワードによるログインを終了](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d)しました。**IMAP / SMTP**を選んでHotmailやOutlook.comのアドレスを入力すると、ダッシュボードに案内が表示され、**Use Sign in with Microsoft**（Microsoftでログインを使う）ボタンからOutlookの選択肢に戻れます。プロバイダーの詳細は[Outlook.comの設定ページ](/connect/outlook)にまとめています。

## ステップ2：MCPEmailsをカスタムコネクタとしてClaudeに追加する

claude.aiまたはClaude Desktopで、次の手順を行います。

1. **カスタマイズ → コネクタ**を開きます。
2. **+ 追加**をクリックし、**カスタムコネクタを追加**を選びます。
3. 名前（たとえばMCPEmails）を付け、次のURLを貼り付けます。

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. **続行**をクリックし、Claudeが検出した認証設定はそのままにして、**追加**をクリックします。
5. **接続**をクリックしてMCPEmailsアカウントにログインし、Claudeに許可する権限を承認します。たとえば、メールを読むには\`read:email\`、送信するには\`send:email\`です。

チャットで使うには、メッセージ入力欄の左下にある**+**をクリックし、**コネクタ**を選んでMCPEmailsをオンにします。APIキーの作成も設定ファイルの編集も必要ありません。TeamプランやEnterpriseプランでは、カスタムコネクタを追加できるのはOwnerだけです。メンバーは**カスタマイズ → コネクタ**でそのコネクタを見つけ、**接続**をクリックします。途中の画面で先に進めない場合は、[Claudeの設定ページ](/docs/claude)でよくある問題を確認してください。

## ステップ3：Claudeに簡単な質問をする

まずは読み取りだけの依頼から始めます。

> Hotmailの受信トレイにある未読メールのうち新しい5件を要約して、返信が必要なものを教えて。

Claudeは\`email_read\`ツールでメッセージを一覧表示し、開きます。答えが返ってくれば接続は成功です。次のような依頼も試してみてください。

- 「先週届いた注文確認メールを探して、配達日を教えて。」
- 「大家さんからの最新のメールへの返信を下書きして。ただし送信はしないで。」
- 「今月のニュースレターをすべて『あとで読む』というフォルダーに移動して。」

Gmail、iCloud、職場のメールボックスもある場合は、同じ方法で接続すれば、Claudeは同じコネクタからすべてを扱えます。Claudeがそれらをどう区別するかは、[ClaudeとChatGPTで複数のメールアカウントを使う方法](/blog/multiple-email-accounts-in-claude-and-chatgpt)で説明しています。

## ClaudeがOutlook.comの受信トレイでできること

接続後のClaudeは、ほかのプロバイダーと同じメールツールで作業します。

- メールの閲覧と検索。
- 自分のアドレスからの送信、返信、転送（添付ファイル付きも可）。
- 下書きの作成と編集、予約送信。
- フォルダーの作成（入れ子のフォルダーも可）、メッセージの移動、コピー、アーカイブ。
- メッセージへのフラグ設定、既読・未読の切り替え。
- メッセージの「削除済みアイテム」への移動、または完全な削除。
- その受信トレイに設定した署名を、送信するすべてのメッセージに追加。

Outlook.comはラベルではなくフォルダーでメールを整理するため、Claudeはメールをフォルダーに移動して仕分けします。Microsoft Graphの制限で知っておきたい点が1つあります。テキスト検索は、未読、添付ファイル、フラグ付き、日付のフィルターと組み合わせられません。検索にテキストが含まれるとこれらのフィルターは外され、どれが外されたかが結果としてClaudeに伝わります。先にテキストで検索し、そのあとClaudeに結果を絞り込ませてください。

MCPEmailsは新着メールをClaudeに自動で送りません。Claudeは依頼されたときに確認します。メールの仕分けや要約にはこの方式が合っています。

## Outlook.comのメールはどこかに保存されますか？

いいえ。Claudeがメッセージを要求するたびに、MCPEmailsはMicrosoftからその場で取得してClaudeに渡し、そのまま破棄します。受信トレイについて保存されるのは、Microsoftでログインしたときに発行されたOAuthトークンだけで、保存時は暗号化されています。接続を解除するには、MCPEmailsで受信トレイを削除するか、Microsoftアカウントにアクセスできるアプリの一覧からMCPEmailsを削除します。この仕組みは[「メールを一切保存しない」ことが重要な理由](/blog/why-email-never-stored-matters)で、メールの中に隠された指示など注意すべき点は[AIエージェントにメールへのアクセスを許可しても安全か](/blog/is-it-safe-to-give-ai-agent-email-access)で説明しています。

## よくある質問

**ClaudeをOutlook.comやHotmailに接続できますか？**
はい。Claudeに組み込まれたMicrosoft 365コネクタは個人用Microsoftアカウントに対応していませんが、カスタムコネクタなら対応しています。MCPEmailsで「Microsoftで接続」からアドレスを接続し、Claudeのカスタマイズ → コネクタで\`https://mcpemails.com/api/mcp\`を追加すれば、ClaudeがOutlook.com、Hotmail、Live、MSNのメールを読み、検索し、送信し、整理できるようになります。

**ClaudeのMicrosoft 365コネクタがHotmailのアドレスを受け付けないのはなぜですか？**
Anthropicのヘルプページによると、このコネクタにはMicrosoft Businessプランに紐づくMicrosoft Entraテナントと、それを承認するグローバル管理者が必要で、個人用Microsoftアカウントは使えません。個人用アカウントにはテナントも管理者もありません。

**アプリ パスワードやIMAPの設定は必要ですか？**
いいえ。個人用MicrosoftアカウントはMicrosoftでのログインとMicrosoft Graphを通じて接続します。Microsoftはこれらのアカウントで、Microsoft以外のメールアプリからのパスワードによるログインを受け付けていないため、アプリ パスワードを作ってもログインできません。

**古いHotmailのアドレスでも使えますか？**
はい。Hotmail、Live、MSN、Outlook.comのアドレスはどれもMicrosoftの同じ個人向けメールサービスなので、接続方法も同じです。ログインしたMicrosoftアカウントにOutlookのメールボックスがない場合、MCPEmailsは接続を受け付けず、その旨を表示します。

**同じ設定はChatGPTでも使えますか？**
はい。URLは同じです。ChatGPT側ではカスタムMCPサーバーとして追加します。手順は[ChatGPTをHotmail・Outlook.comに接続する方法](/blog/connect-chatgpt-to-outlook-com-hotmail)で説明しています。

## 次のステップ

[無料で始める](/signup)から登録し、Outlook.comまたはHotmailの受信トレイをMicrosoftで接続し、URLをClaudeに追加して、未読メールの要約を頼んでみてください。ほかのプロバイダーについては、[Claudeのメール設定ガイド](/blog/connect-claude-to-email)でGmail、iCloud、Fastmail、IMAPを扱っています。`,
};

export default translation;
