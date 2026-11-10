const translation = {
  title: 'Claudeとメールを連携する方法：iCloud、Apple Mail、Yahoo、IMAP対応',
  description:
    'ClaudeをiCloud、Yahoo、Outlook、任意のIMAP受信トレイとMCPで連携する手順。Apple Mailで読んでいるアカウントにも対応します。2分で完了、コード不要、メールは保存されません。',
  coverAlt:
    'MCPEmailsでClaudeをGmail、Outlook、iCloud、Fastmail、Yahoo、Zoho、IMAPメールと連携する',
  content: `Claudeはメールの読み取り、検索、整理、送信ができますが、実際の受信トレイにアクセスするにはMCPサーバーが必要です。MCPEmailsがその橋渡しをします。受信トレイを一度接続し、Claudeに安全なエンドポイントを1つ追加するだけで、Gmail、OutlookとMicrosoft 365、iCloud、Fastmail、Yahoo、Zoho、その他のIMAPプロバイダーに共通のメールツールをClaudeで使えるようになります。

コードを書く必要も、SDKをインストールする必要もなく、ClaudeのOAuthフローで接続する場合はAPIキーも不要です。メールはリクエストのたびにプロバイダーからリアルタイムで取得され、MCPEmailsには保存されません。

**お使いのプロバイダーへ移動：** [Gmail](#gmailとgoogle-workspace) · [iCloud](#icloud-mail) · [Apple Mail](#apple-mail) · [Fastmail](#fastmail) · [Outlook](#outlookとmicrosoft-365) · [Yahoo、Zoho、Yandex、カスタムIMAP](#yahoozohoyandexカスタムimap)

## 必要なもの

- **Claude**（Web版のclaude.aiまたはClaude Desktop）。カスタムコネクタはすべてのClaudeプランで追加できます。Freeは1つまで、ProとMaxは上限なしです。
- 無料の**MCPEmails**アカウント。[こちらから作成できます](/signup)。
- メールの受信トレイを1つ。OutlookはSign in with Microsoft（Microsoftでサインイン）で接続します。Gmail、iCloud、Fastmail、Yahoo、Zoho、その他ほとんどのプロバイダーはアプリ パスワードを使います。

## ステップ1：MCPEmailsに受信トレイを接続する

MCPEmailsのダッシュボードで**受信トレイ → 受信トレイを接続**を開き、プロバイダーを選びます。

### GmailとGoogle Workspace

**Gmail**を選び、myaccount.google.com/apppasswordsでGoogleのアプリ パスワードを作成して（Googleは2 段階認証プロセスが有効な場合にのみ発行します）、16文字のパスワードをGmailアドレス全体と一緒に貼り付けます。通常のGoogleパスワードはここでは使えず、アプリ パスワードはいつでも取り消せます。Workspaceの管理者がドメインでアプリ パスワードを無効にしている場合は、[Gmail向けの手順](/blog/connect-gmail-to-claude)を参照してください。[Gmailの設定と制限](/connect/gmail)と[Google Workspaceのセットアップページ](/connect/google-workspace)もご覧ください。

### iCloud Mail

Apple Accountでアプリ用パスワードを作成し、**iCloud**を選んで、通常のApple Accountのパスワードではなくそのパスワードを入力します。プロバイダー側の正確な手順は[iCloudとIMAPの手順](/blog/connect-icloud-fastmail-imap-to-claude)にまとめています。[iCloud MailをClaudeと連携する](/connect/icloud)もご覧ください。

### Apple Mail

Apple Mailはメールアプリなので、Claudeはアプリではなく、その背後にあるアカウントに接続します。iCloudアドレスは上記の手順で接続します。Gmail、Outlook、Yahoo、仕事用のアカウントは、それぞれのプロバイダーを通じて接続します。「このMac内」にのみ保存されているフォルダーはどのサーバーにも存在しないため、Claudeからは見えません。Mac側で何かを起動しておく必要はありません。

### Fastmail

FastmailでMailへのアクセス権を持つアプリ パスワードを作成し、**Fastmail**を選んでMCPEmailsに貼り付けます。接続テストが成功するまで、生成したパスワードは手元に残しておいてください。[Claude向けのFastmail設定](/connect/fastmail)をご覧ください。

### OutlookとMicrosoft 365

Outlookはアプリ パスワードではなくSign in with Microsoftで接続します。**Outlook**を選び、**Connect with Microsoft**（Microsoftで接続）をクリックして承認します。個人のOutlook.com、Hotmail、Live、MSNアカウントはすぐに接続されます。職場または学校のMicrosoft 365アカウントでは、先にIT管理者が組織全体に対してアプリを一度承認する必要がある場合があります。ダッシュボードに、管理者へ送るためのリンクが表示されます。詳しくは[OutlookとMicrosoft 365のガイド](/blog/connect-outlook-microsoft-365-ai-agent-mcp)をご覧ください。[Outlookのセットアップページ](/connect/outlook)または[Microsoft 365のセットアップページ](/connect/office365)もあります。

### Yahoo、Zoho、Yandex、カスタムIMAP

アプリ パスワードを作成し、**IMAP**を選んで、アドレスとパスワードを入力します。一般的な設定は自動的に検出されます。独自ドメインの場合は、プロバイダーが案内するIMAP/SMTPホスト、ポート、セキュリティモードが必要になることがあります。各プロバイダーの設定は[Yahoo Mail](/connect/yahoo)、[Zoho Mail](/connect/zoho)、[Yandex Mail](/connect/yandex)、[カスタムIMAP](/connect/imap)のページにあります。[対応プロバイダーの一覧](/connect)も参照できます。

受信トレイは複数接続できます。Claudeは\`inbox_list\`で受信トレイを自動的に見つけるので、プロンプトにメールボックスIDを貼り付ける必要はありません。

プロバイダーごとの詳しい説明が必要な場合は、[2分で完了するマルチプロバイダー設定ガイド](/blog/connect-email-to-ai-agent-under-2-minutes)、専用の[Gmailガイド](/blog/connect-gmail-to-claude)、または[iCloud、Fastmail、IMAPのガイド](/blog/connect-icloud-fastmail-imap-to-claude)をご覧ください。

## ステップ2：ClaudeにMCPEmailsを追加する

claude.aiまたはClaude Desktopで次の操作をします。

1. **カスタマイズ → コネクタ**を開きます。
2. **+ 追加**をクリックし、**カスタムコネクタを追加**を選びます。
3. 名前をMCPEmailsにして、次のURLを貼り付けます。

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. **続行**をクリックし、Claudeが検出したログイン設定を確認して（既定値のままで問題ありません）、**追加**をクリックします。
5. MCPEmailsにログインし、同意画面でアクセスレベルを選びます。**読み取り専用**、**標準**、**フルアクセス**のいずれかを選ぶか、**権限を個別に設定**で必要な権限だけにチェックを入れます。
6. チャットで左下の**+**をクリックし、**コネクタ**を選んでMCPEmailsをオンにします。

TeamプランまたはEnterpriseプランでは、Ownerが**組織設定 → コネクタ**でコネクタを一度追加します。メンバーは**カスタマイズ → コネクタ**を開いてMCPEmailsを見つけ、**接続**をクリックします。

Claude側の設定はこれで完了です。OAuthにより接続は承認したスコープに限定され、MCPEmailsからいつでも取り消せます。OAuthに対応していないクライアントを使う場合は、代わりにスコープを絞ったAPIキーを使います。その手順は[OAuthとAPIキーの比較](/blog/oauth-vs-api-keys-ai-email-access)で説明しています。Claude固有の問題は[Claudeのセットアップページ](/docs/claude)をご覧ください。

## ステップ3：Claudeに安全な最初のタスクを任せる

まずは読み取りだけのリクエストから始めます。

> 未読メールのうち新しい3件を要約して、今日中に返信が必要なものを教えてください。

Claudeはまず接続された受信トレイを見つけ、次に該当するメッセージを一覧して読みます。これが動いたら、次のようなリクエストを試してください。

- 「先月Stripeから届いた請求書を探して、金額を教えて」
- 「Alexからの最新メッセージへの返信を下書きして。ただし送信はしないで」
- 「今週届いたニュースレターのうち、アーカイブしてよさそうなものを見せて」
- 「Acmeとのスレッドで、私は何に同意した？」

繰り返し使うルーチンには、[受信トレイのトリアージ手順](/blog/ai-agent-triage-summarize-inbox)や[Claudeに受信トレイを管理させる方法](/blog/best-ways-to-let-claude-manage-your-inbox)をご覧ください。

## 接続後にClaudeができること

MCPEmailsは、パスワードや生のIMAP接続ではなく、目的を絞ったメールツールをClaudeに提供します。

- **読み取りと検索：** \`email_read\`はメッセージの一覧表示、本文全体の読み取り、送信者、件名、日付、未読状態などの構造化フィールドによる検索を行います。Gmailではラベルがフォルダーとして表示されます。
- **送信、返信、転送：** \`email_compose\`は、お使いのプロバイダーとアドレスから送信します。
- **整理：** \`email_organize\`はメッセージの移動、ラベル付け、フラグ付け、アーカイブを行います。
- **下書き、フォルダー、予約送信、連絡先：** \`draft\`、\`folder\`、\`schedule\`、\`contact_search\`が、実用的なメールワークフローの残りをカバーします。

知っておきたいのは、Claudeがメールを読むのはツールを呼び出したときだけで、チャットに何かがプッシュされることはない点です。新着メールの確認は、あなたが頼んだときに行われます。メールが届いた瞬間に自分のコードを動かしたい場合は、ProとBusinessのワークスペースでダッシュボードの**APIキー**から新着メールのWebhookを追加でき、MCPEmailsが署名付きのPOSTをあなたのURLに送ります。

## 接続とClaude設定のトラブルシューティング

- **プロバイダーがパスワードを拒否する：** Webでのログインに使うパスワードではなく、プロバイダーが生成したアプリ パスワードを使ってください。必要であれば、2要素認証を有効にしてから再生成してください。
- **カスタムIMAP接続がタイムアウトする：** プロバイダーのIMAP/SMTPホスト、ポート、TLSモードを確認してください。通常、ポート993は暗黙的TLS、ポート143はSTARTTLSを使います。
- **Claudeは接続できているがメールが見えない：** まずMCPEmailsで受信トレイが有効になっているか確認し、次にClaudeを再接続して**read:email**を承認します。メッセージを読む前に、Claudeに**inbox_list**を呼び出すよう依頼してください。
- **Claudeは読めるが送信できない：** **send:email**を付けて再接続し、プロバイダー接続がSMTPまたはプロバイダー固有の送信に対応しているか確認してください。

それでも解決しない場合は、[プロバイダー一覧表](/docs/providers)で対応機能を確認し、[セットアップガイドを開いて](/docs#quickstart)、送信を有効にする前に読み取りだけのリクエストを1つ試してください。

## Claudeとメールを連携しても安全ですか

はい。接続に必要なアクセス権だけを与え、送信などの外向きの操作には人が関与し続けるようにすれば安全です。

- **メールは保存されません。** MCPEmailsは呼び出しのたびにメッセージの内容をリアルタイムで取得し、渡した後は破棄します。保持される受信トレイのデータは、プロバイダーに再接続するために必要な暗号化された認証情報だけです。
- **認証の主導権はプロバイダーにあります。** OutlookはOAuthを使うため、MCPEmailsがMicrosoftのパスワードを目にすることはありません。Gmailなどアプリ パスワードを使うプロバイダーでは、アプリ パスワードはアカウントのパスワードとは別の認証情報で、いつでも取り消せます。
- **スコープは明示的です。** Claudeに送信させたくなければ、読み取り専用のアクセス権だけを与えてください。送信アクセス権は必要なときにだけ追加し、どちらのアクセス経路もいつでも取り消せます。

メール本文はすべて信頼できない入力として扱ってください。送信前にClaudeに下書きを作らせ、社外向けのメッセージは確認し、メール内の指示にあなた自身の意図を上書きさせないようにしてください。[メールアクセスの安全性ガイド](/blog/is-it-safe-to-give-ai-agent-email-access)で脅威モデルを詳しく説明しています。

## よくある質問

**ClaudeはGmail、Outlook、iCloudと連携できますか？**
GmailはGoogleのアプリ パスワード、OutlookはSign in with Microsoft、iCloudはアプリ用パスワードで接続します。職場または学校のMicrosoft 365アカウントでは、先にIT管理者がアプリを一度承認する必要がある場合があります。MCPEmailsはFastmailと汎用IMAPにも対応しており、YahooやZohoなどのサービスもカバーします。

**APIキーは必要ですか？**
いいえ。ClaudeのOAuthコネクタフローには不要です。エンドポイントURLを貼り付けてログインするだけです。APIキーは、OAuthを内蔵していないMCPクライアント向けです。

**Claudeはメールを送信できますか？**
はい。\`send:email\`を許可すれば送信できます。確認のステップを挟みたい場合は、読み取り専用から始めるか、まずClaudeに返信の下書きを作らせてください。

**MCPEmailsは私の受信トレイを保存しますか？**
いいえ。メッセージはプロバイダーからリアルタイムで読み取られ、破棄されます。MCPEmailsが保存するのは、そのリアルタイムのリクエストに必要な暗号化された接続用の認証情報だけです。

## 次のステップ

[無料で始めて](/signup)、受信トレイを接続し、\`https://mcpemails.com/api/mcp\`をClaudeに追加して、未読メールの要約を頼んでみてください。MCPツールの完全なリファレンスとプロバイダーごとの対応機能は[ドキュメント](/docs)をご覧ください。`,
};

export default translation;
