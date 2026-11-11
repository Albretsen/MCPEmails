const translation = {
  title: 'ClaudeをHotmail・Outlook.comに接続する方法（個人用Microsoftアカウント）',
  description:
    'ClaudeのMicrosoft 365コネクタは、Free、Pro、Max、Ultraの各プランで個人用Microsoftアカウントを受け付けるようになりました。それで足りるのはどんな場合か、そして添付ファイル、複数のメールボックス、Teamプランで使うために、Hotmail、Outlook.com、Live、MSNをカスタムコネクタのURL1つでClaudeに接続する方法を説明します。',
  coverAlt: 'MCPEmailsを通じて個人用のOutlook.comまたはHotmailの受信トレイに接続したClaude',
  content: `個人用のOutlook.com、Hotmail、Live、MSNのアドレスをClaudeに接続する方法は2つあります。Claude独自のMicrosoft 365コネクタは、Free、Pro、Max、Ultraの各プランで個人用Microsoftアカウントを受け付け、管理者の関与は不要です。もう1つの経路がMCPEmailsです。**Microsoftで接続**でメールボックスを追加し、URLを1つカスタムコネクタとしてClaudeに追加します。2つ目の経路は、組み込みコネクタがカバーしない部分を補います。添付ファイル、1つの接続にまとめた複数のメールボックス、TeamプランとEnterpriseプラン、そしてChatGPTやほかのMCPクライアントでの同じ受信トレイの利用です。昔からあるhotmail.comのアドレスも、新しいoutlook.comのアドレスと同じように、どちらの経路でも使えます。

このガイドは、Claudeで個人用Microsoftアカウントを使う場合の手順です。職場や学校のMicrosoft 365アカウントのメールを使う場合は、[OutlookとMicrosoft 365のガイド](/blog/connect-outlook-microsoft-365-ai-agent-mcp)をご覧ください。

## ClaudeのMicrosoft 365コネクタで個人用アカウントを使うとできること

Anthropicの[Microsoft 365に接続する記事](https://support.claude.com/en/articles/15183774-connect-to-microsoft-365)は、個人用アカウントも扱うようになりました。Free、Pro、Max、Ultraの各プランでは、Outlook.com、Hotmail、Live、MSNのアカウントを自分で接続でき、管理者は不要です。コネクタはOutlookとOneDriveにアクセスし、書き込みツールも含まれているため、Claudeは事前に確認したうえでメールの下書きや送信、カレンダーの予定の管理ができます。

同じ記事にある3つの制限が、メールを使う上で重要です。

- **書き込みツールでは添付ファイルを扱えない。** このコネクタ経由では、Claudeは添付ファイル付きのメールを送信、転送、下書きできません。
- **TeamとEnterpriseでは使えない。** これらのプランには個人用アカウントの選択肢が表示されないため、職場のプランと並べて個人用のHotmailアドレスを使う組み込みの経路はありません。
- **Claudeの中だけで、ログインしたアカウントのみ。** Gmailには専用のコネクタがあり、iCloud、Yahoo、IMAPのメールボックスにはコネクタがなく、ChatGPTやほかのMCPクライアントには何も引き継がれません。

職場や学校のアカウントは事情が異なります。組織内の誰かが接続する前に、Microsoft Entraのグローバル管理者が同意する必要があります。詳しくは[OutlookとMicrosoft 365のガイド](/blog/connect-outlook-microsoft-365-ai-agent-mcp)と[管理者の同意ページ](/docs/microsoft-365-admin-consent)で説明しています。

Claudeで個人用のOutlook.comの受信トレイを1つ、添付ファイルなしで使えれば十分という場合は、組み込みコネクタで足ります。このガイドの残りの部分は、それ以外のすべての場合の経路です。

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
5. **接続**をクリックしてMCPEmailsアカウントにログインし、同意画面でClaudeに許可するアクセスレベルを選びます。読むだけなら**読み取り専用**、返信や下書きも任せるなら**標準**です。**権限を個別に設定**で1つずつ選ぶこともできます。

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

いいえ。Claudeがメッセージを要求するたびに、MCPEmailsはMicrosoftからその場で取得してClaudeに渡し、そのまま破棄します。受信トレイについて保存されるのは、Microsoftでログインしたときに発行されたOAuthトークン（保存時は暗号化）と、予約して送信を待っているメッセージのように、オンにした機能に必要なわずかな情報です。接続を解除するには、MCPEmailsで受信トレイを削除するか、Microsoftアカウントにアクセスできるアプリの一覧からMCPEmailsを削除します。この仕組みは[「メールを一切保存しない」ことが重要な理由](/blog/why-email-never-stored-matters)で、メールの中に隠された指示など注意すべき点は[AIエージェントにメールへのアクセスを許可しても安全か](/blog/is-it-safe-to-give-ai-agent-email-access)で説明しています。

## よくある質問

**ClaudeをOutlook.comやHotmailに接続できますか？**
はい、方法は2つあります。Free、Pro、Max、Ultraでは、Claudeに組み込まれたMicrosoft 365コネクタが個人用Microsoftアカウントを直接受け付けます（添付ファイルは不可）。添付ファイル、複数のメールボックス、TeamまたはEnterpriseプラン、あるいはChatGPTでも同じ受信トレイを使いたい場合は、MCPEmailsで「Microsoftで接続」からアドレスを接続し、Claudeのカスタマイズ → コネクタで\`https://mcpemails.com/api/mcp\`を追加すれば、ClaudeがOutlook.com、Hotmail、Live、MSNのメールを読み、検索し、送信し、整理できるようになります。

**ClaudeのMicrosoft 365コネクタがHotmailのアドレスを受け付けないのはなぜですか？**
まずプランを確認してください。Anthropicによると、個人用MicrosoftアカウントはFree、Pro、Max、Ultraで接続でき、TeamとEnterpriseのプランにはその選択肢が表示されません。職場や学校のアドレスは別で、Microsoft Entraテナントのグローバル管理者が先に同意する必要があります。TeamまたはEnterpriseプランで個人用アドレスを使うには、カスタムコネクタとしてのMCPEmailsが経路になります。

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
