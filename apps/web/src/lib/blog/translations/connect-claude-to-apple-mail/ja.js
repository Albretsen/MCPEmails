const translation = {
  title: 'ClaudeをApple Mail（メールアプリ）と連携する方法：iCloud、Gmail、Outlook、Yahoo',
  description:
    'Apple Mailのアカウント（iCloud、Gmail、Outlook.com、Yahoo、IMAP）をClaudeに接続し、iPhoneを含むどのデバイスからでもメールの読み取り、検索、下書き、送信ができるようにする方法です。',
  coverAlt: 'Apple MailのiCloud、Gmail、Outlook、YahooのアカウントをMCPでClaudeに接続した様子',
  content: `ClaudeをApple Mailに接続するには、メールアプリそのものではなく、Apple Mailに表示されているメールアカウントを接続します。Apple Mailはクライアントで、iCloud、Gmail、Outlook.com、Yahoo、その他のIMAPアカウントを各プロバイダーのサーバーから同期しているだけです。MCPEmailsはサーバー側で同じアカウントにClaudeを接続するので、ClaudeにはApple Mailと同じ受信トレイ、フォルダー、下書き、送信済みメールが見えます。claude.ai、Claude Desktop、iPhoneのClaudeアプリから使え、Macの電源が入っている必要はありません。

## ClaudeはApple Mailに接続できる？

はい、Apple Mailの中のアカウントを通じて接続できます。Apple MailにはClaudeがログインできる独自の接続口がないため、確実な方法は次のとおりです。

1. Apple Mailが使っているアカウントを確認する。
2. 各アカウントを、ホスト型のMCPサーバーであるMCPEmailsに接続する。
3. URLを1つ使って、MCPEmailsをカスタムコネクタとしてClaudeに追加する。

これで、Claudeは許可した範囲内で、接続したすべてのアカウントのメールを読み、検索し、下書きを作り、送信し、予約し、整理できます。MacとiPhoneのApple Mailも同じメールボックスを見ているので、変更は次回の同期で反映されます。

## メールアプリではなくアカウントを接続する理由

GitHubで見つかるApple Mail用のMCPサーバーは、Mac上で動き、AppleScriptやメールアプリのローカルインデックスを読み取ってメールアプリ経由で動作します。これでも使えますが、設計上の制約があります。

- サーバーをインストールし、メールアプリを使える状態のMacでしか動きません。
- 接続がその1台のMacにあるため、iPhone、Windows PC、Webで使うClaudeからは届きません。
- Macがスリープ中や閉じているときは、サーバーにアクセスできません。

Claudeのカスタムコネクタは逆の仕組みです。Anthropicのヘルプセンターによると、MCPサーバーへの接続はデバイスからではなくAnthropicのサーバーから行われ、これはモバイルアプリを含むすべてのClaudeクライアントで同じです。メールアカウントへのサーバー側の接続はこのモデルに合っています。インストールするものはなく、どこでClaudeを開いても同じコネクタが使えます。

## ステップ1：Apple Mailが使っているアカウントを確認する

- **Macの場合**：メールアプリで**Mail → Settings**（メール → 設定）を選び、**Accounts**（アカウント）をクリックします。
- **iPhoneまたはiPadの場合**：**Settings → Apps → Mail → Mail Accounts**（設定 → アプリ → メール → メールアカウント）を開きます。

一覧にある各アカウントは、次のいずれかの方法でMCPEmailsに接続します。

- **iCloud**（@icloud.com、@me.com、@mac.com）：Appleのアプリ用パスワード。設定は[iCloudのページ](/connect/icloud)にあります。
- **Google**：Googleのアプリ パスワード。設定は[Gmailのページ](/connect/gmail)にあります。
- **Outlook.com、Hotmail、LiveまたはMicrosoft 365**：Microsoftでログインします。職場や学校のアカウントでは、IT管理者がMCPEmailsを一度承認する必要がある場合があります。詳しくは[Outlookのページ](/connect/outlook)をご覧ください。
- **Yahoo**：Yahooのアプリ パスワード。設定は[Yahoo Mailのページ](/connect/yahoo)にあります。
- **その他(IMAP)**：ホストのIMAPとSMTPの設定。[カスタムIMAPのページ](/connect/imap)をご覧ください。

この一覧にないプロバイダーについても、[対応しているすべてのプロバイダー](/connect)にサーバー設定を載せた個別のページがあります。

## ステップ2：各アカウントをMCPEmailsに接続する

無料の[MCPEmailsアカウント](/signup)を作成してダッシュボードを開き、**受信トレイ → 受信トレイを接続**に進んで、プロバイダーを選びます。

### iCloudメール

Appleは、ほかのアプリからAppleアカウントのパスワードでログインすることを認めていません。アプリ用パスワードが必要です。

1. [account.apple.com](https://account.apple.com)にサインインします。
2. **サインインとセキュリティ**で**アプリ用パスワード**を選びます。
3. **Generate an app-specific password**（アプリ用パスワードを生成）を選び、名前を\`MCPEmails\`にして、Appleが表示するパスワードをコピーします。
4. MCPEmailsで**iCloud**を選び、iCloudのアドレスを入力して、そのパスワードを貼り付けます。

これには、Appleアカウントで2ファクタ認証が有効になっている必要があります。注意点が1つあります。Appleアカウントのパスワードを変更すると、すべてのアプリ用パスワードが無効になるため、パスワード変更後は新しいものを生成して再接続してください。詳しくは[iCloud、Fastmail、IMAPのガイド](/blog/connect-icloud-fastmail-imap-to-claude)をご覧ください。

### Gmail

Apple MailはGoogleアカウントでGoogleにログインします。MCPEmailsは代わりに、IMAP経由でGoogleのアプリ パスワードを使います。アプリ パスワードは2 段階認証プロセスを有効にすると使えるようになります。**Gmail**を選び、アドレスと16文字のパスワードを貼り付けます。管理者がアプリ パスワードを無効にしているWorkspaceアカウントについては、[Gmailのガイド](/blog/connect-gmail-to-claude)で説明しています。

### Outlook.com、Hotmail、Microsoft 365

**Outlook**を選び、**Microsoftで接続**をクリックします。貼り付けるパスワードはありません。

### Yahooとその他のIMAPアカウント

プロバイダーでアプリ パスワードを作成し、**Yahoo**または**IMAP / SMTP**を選んで、アドレスとパスワードを入力します。よく使われるホストなら、アドレスからサーバー設定が自動で入力されます。

Claudeに使わせたいApple Mailのアカウントをそれぞれ接続してください。追加できる受信トレイの数は[プラン](/pricing)によって異なります。Claudeは\`inbox_list\`でアカウントを見つけるので、プロンプトにアカウントIDを貼り付ける必要はありません。

## ステップ3：MCPEmailsをClaudeに追加する

claude.aiまたはClaude Desktopで次の操作をします。

1. **カスタマイズ → コネクタ**を開きます。
2. **+ 追加**をクリックし、続いて**カスタムコネクタを追加**をクリックします。
3. \`MCPEmails\`などの名前を入力し、コネクタURLを貼り付けます。

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. 画面の案内に沿って進み、**追加**をクリックします。次に**接続**をクリックしてMCPEmailsにログインし、Claudeに許可する範囲を選びます。**読み取り専用**、**標準**（送信、下書き、連絡先を追加）、**フルアクセス**（フォルダー、予約送信、削除を追加）、**カスタム**のいずれかです。

APIキーも設定ファイルも不要です。TeamプランやEnterpriseプランでは、まずオーナーが**組織設定 → コネクタ**でコネクタを追加し、その後メンバーがそのコネクタの**接続**をクリックします。各ステップとよくあるエラーは[Claudeの設定ページ](/docs/claude)で説明しています。

### iPhoneで使う

Anthropicのヘルプセンターによると、claude.aiやClaude Desktopで追加したコネクタは、次にiOSまたはAndroidのClaudeアプリにログインしたときから使えます。Webで一度追加すれば、あとはスマートフォンからClaudeにメールのことを聞けます。iPhoneのメールアプリを開いておく必要も、Macの電源を入れておく必要もありません。

## Claudeに見えるもの、見えないもの

Claudeは各アカウントのサーバー上のコピー、つまりApple Mailが同期しているコピーを扱います。そのため、次のようになります。

- **アカウント内に作成したフォルダーは見えます。** iCloudやGmailのアカウントの下に作ったメールボックスはサーバー上にあるので、Claudeは一覧表示や検索ができ、フォルダーへのアクセスを許可していればメールを移動することもできます。
- **下書きはApple Mailに入ります。** Claudeが下書きを保存すると、そのアカウントの下書きフォルダーに入るので、Apple Mailで開いて編集し、自分で送信できます。
- **送信済みメールは保存されます。** Claudeが送信したメッセージは、Apple Mailから送ったものと同じように、そのアカウントの送信済みフォルダーに保存されます。メールサーバーがそのコピーを拒否した場合は、Claudeの結果にそう表示されます。
- **「このMac内」のメールボックスは見えません。** Appleはこれらを作成したMacだけに保存するため、サーバーへの接続からは見えません。Claudeに見つけてほしいものは、アカウントの下のメールボックスに移してください。
- **POPアカウントは一部しか見えない場合があります。** Apple MailがPOPで使っているアカウントでは、Macにダウンロードした後に古いメールがサーバーから削除されていることがあります。MCPEmailsはIMAPで接続するため、Claudeが見られるのはサーバーに残っているメールだけです。

メールはリクエストのたびにプロバイダーからリアルタイムで取得され、MCPEmailsには保存されません。唯一の例外は予約送信したメッセージで、送信されるまで保持されます。

## 試してみたいプロンプト

まずは読み取りだけのものから始めましょう。

> 今日届いたiCloudとGmailの未読メールを要約して。1つのリストにまとめて、それぞれどのアカウントに届いたかを付けて。

> 先月届いたフライトの確認メールを探して、予約番号を教えて。

> 大家さんからの最新のメッセージへの返信を下書きして。送信はしないで。続きはApple Mailで書きます。

ほかの使い方は、[Claudeに受信トレイを管理させる方法](/blog/best-ways-to-let-claude-manage-your-inbox)と[受信トレイの仕分けプレイブック](/blog/ai-agent-triage-summarize-inbox)をご覧ください。複数のアカウントを使っているなら、[AIで複数のメールアカウントを管理する](/blog/manage-multiple-email-accounts-with-ai)で、返信を正しいアドレスから送る方法を紹介しています。

## 同じアカウントにChatGPTを接続する

コネクタURLは標準的なMCPサーバーなので、ChatGPTからも同じApple Mailのアカウントを使えます。chatgpt.comでカスタムMCPサーバーとして追加します。OpenAIのヘルプセンターによると、この手順はWebでのみ行えます。追加できるプランやワークスペースの役割はよく変わるため、最新の手順は[ChatGPTの設定ページ](/docs/chatgpt)にまとめ、よくあるエラーは[ChatGPTのメールガイド](/blog/connect-chatgpt-to-email)で説明しています。

## 主導権を自分で握っておく

- **必要な権限だけを許可する。** Claudeに一切送信させたくないなら、同意画面で**読み取り専用**を選びます。
- **送信前に確認する。** ダッシュボードでアカウントの**送信前の確認**をオンにすると、そのアカウントからの送信はすべて承認待ちになります。[AIによるメール送信を人が承認する方法](/blog/approve-ai-agent-email-sends)をご覧ください。
- **いつでも取り消せる。** account.apple.comでアプリ用パスワードを削除するか、MCPEmailsのダッシュボードの**APIキー**でClaudeの接続を取り消します。

すべてのメールを信頼できないテキストとして扱ってください。メッセージにはAIに向けた指示が含まれていることがあります。リスクは[メールへのアクセスの安全性ガイド](/blog/is-it-safe-to-give-ai-agent-email-access)で説明しており、認証情報の暗号化方法とデータの保存場所は[セキュリティ](/security)のページにあります。

## FAQ

**ClaudeをApple Mailに接続するにはどうすればいいですか？**
Apple Mailが使っているアカウント（iCloud、Gmail、Outlook.com、Yahoo、IMAP）をMCPEmailsに接続し、ClaudeのCustomize、Connectorsで\`https://mcpemails.com/api/mcp\`をカスタムコネクタとして追加します。するとClaudeはそれらのアカウントでメールを読み、送信できるようになり、結果はApple Mailにも反映されます。

**Macは必要ですか？**
いいえ。Macでは何も動かしません。ClaudeはMCPEmailsを通じてメールアカウントにアクセスするので、claude.ai、WindowsやMacのClaude Desktop、iPhoneやAndroidのClaudeアプリから使えます。

**iPhoneのメールアプリでも使えますか？**
はい。iPhoneのメールアプリとClaudeは同じアカウントを扱います。claude.aiでコネクタを一度追加すれば、次にログインしたときからiPhoneのClaudeアプリでも使えます。

**Appleアカウントのパスワードが拒否されるのはなぜですか？**
iCloudは、ほかのアプリからはアプリ用パスワードしか受け付けません。account.apple.comの「サインインとセキュリティ」で生成し、そちらを貼り付けてください。

**Claudeは「このMac内」のフォルダーを見られますか？**
いいえ。これらのメールボックスはMacの中にしかありません。メッセージをiCloudなどのアカウントの下のメールボックスに移せば、Claudeから見えるようになります。

**メールは保存されますか？**
いいえ。リクエストのたびにプロバイダーからメールをリアルタイムで取得し、破棄します。例外は、送信されるまで保持される予約メッセージと、MCPEmailsが保管する各アカウントの暗号化された認証情報です。すべてのプロバイダーの詳しい手順は、[Claudeをメールに接続するガイド](/blog/connect-claude-to-email)にあります。

## 次のステップ

[無料で始めて](/signup)iCloudアカウントを接続し、Claudeにコネクタを追加して、今日返信が必要なメールを聞いてみてください。そのあとApple Mailを開けば、Claudeが読んだのと同じ受信トレイが表示されます。`,
};

export default translation;
