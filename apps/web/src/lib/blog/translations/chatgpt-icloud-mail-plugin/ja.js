const translation = {
  title: 'ChatGPTのiCloud Mailプラグイン：設定方法、制限、ほかのアカウント',
  description:
    'OpenAIの新しいプラグインでiCloud MailをChatGPTに接続する手順、できることとできないこと、Apple Mailのほかのアカウントが見えない理由、そしてClaudeでもiCloudを使う方法。',
  coverAlt: 'ChatGPTとClaudeに接続したiCloud Mail',
  content: `2026年10月27日、OpenAIはChatGPTにiCloud MailプラグインとiCloud Calendarプラグインを追加しました。Mailプラグインを使うと、ChatGPTはAppleのアプリ用パスワードを使って、1つのiCloudメールボックスでメールの検索、閲覧、下書き、送信ができます。対象はiCloudだけです。iPhoneやMacのメールアプリに追加したGmail、Outlook、仕事用のアカウントには届きませんし、ClaudeにはiCloudの選択肢そのものがありません。

このガイドでは、プラグインの設定方法、できること、よくあるつまずき、そしてClaudeでiCloudを使いたいときや複数の受信トレイを1か所にまとめたいときに何を使えばよいかを説明します。

**移動先：** [設定](#icloud-mailをchatgptに接続する方法) · [できること](#icloud-mailプラグインでできること) · [動かないとき](#icloudプラグインが動かないときは) · [ほかのアカウント](#apple-mailのほかのアカウントが見えない理由) · [Claude](#claudeでicloud-mailを使う) · [よくある質問](#よくある質問)

## iCloud MailをChatGPTに接続する方法

OpenAIの[接続済みアプリのヘルプページ](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)によると、プラグインはFreeを含むすべてのChatGPTプランに、Web、デスクトップアプリ、iOSで順次提供されています。MailとCalendarは別々のプラグインなので、一方を接続してももう一方は接続されません。

1. **Apple Accountの2ファクタ認証を有効にします**（まだの場合）。Appleは2ファクタ認証で保護されたアカウントにしか[アプリ用パスワードを発行しません](https://support.apple.com/ja-jp/102654)。
2. **アプリ用パスワードを作成します。** account.apple.comにサインインし、**サインインとセキュリティ**を開いて**アプリ用パスワード**を選び、1つ生成します。あとで見つけやすいよう、名前はChatGPTにしておきます。
3. **ChatGPTでプラグインを開きます。** **設定**、**プラグイン**の順に進み、**iCloud Mail**を選びます。
4. **iCloudアドレスとアプリ用パスワードを入力します。** OpenAIが受け付けるのは@icloud.com、@me.com、@mac.comで終わるアドレスです。

通常のApple Accountのパスワードはここでは使えません。Appleは他社製アプリに2つの入り口を用意しています。対応アプリはApple Accountそのもので認可でき、それ以外のアプリにはアプリ用パスワードを求めます。OpenAIのプラグインは後者で、サードパーティのメールアプリが使うのと同じ種類のパスワードです。

## iCloud Mailプラグインでできること

OpenAIのヘルプページと、[9to5Mac](https://9to5mac.com/2026/10/27/icloud-mail-and-calendar-plugins-now-work-with-chatgpt/)などのリリース時の報道によると、Mailプラグインは次のことができます。

- iCloudのメールを検索し、メッセージを読む。
- 届いたメールを要約する（たとえば今日の未読メール）。
- 返信を下書きし、メールを送信する。
- iCloudの連絡先を調べる。連絡先の参照は読み取り専用で、今回のリリースに連絡先やリマインダーの独立したプラグインはありません。

OpenAIのページにもリリース時の報道にも、プラグインがメッセージをフォルダーに移動したり削除したりできるとは書かれていません。OpenAIが文書化するまで、受信トレイの整理は期待しないでください。会社や学校が管理するアカウントでは、ワークスペースのアプリ設定でブロックされている場合があります。

ChatGPTでプラグインの接続を解除しても、Apple側のアプリ用パスワードは削除されません。アクセスを完全に断つには、account.apple.comの**サインインとセキュリティ**、**アプリ用パスワード**でそのパスワードを削除してください。

## iCloudプラグインが動かないときは

よくある原因を、つまずく人の多い順に並べます。

- **Appleのパスワードが拒否される。** アプリ用パスワードを使ってください。account.apple.comに**アプリ用パスワード**の項目がなければ、2ファクタ認証がオフになっています。
- **プラグインが一覧にない。** OpenAIはまだ順次提供中なので、あなたのアカウントに届いていない可能性があります。BusinessやEnterpriseのワークスペースでは、管理者がプラグインをオフにしていることもあります。
- **アドレスが拒否される。** Mailプラグインは@icloud.com、@me.com、@mac.comのアドレスを求めます。iCloud+のカスタムドメインしか使っていない場合は、同じApple AccountのiCloudアドレスを入力してください。
- **Apple Accountのパスワードを変更した。** パスワードを変更またはリセットすると、Appleはすべてのアプリ用パスワードを取り消します。**すべてを消去する**でも同じです。新しいアプリ用パスワードを作成して接続し直してください。
- **メッセージがiCloudではなくGmailやOutlookにある。** 次のセクションをご覧ください。

## Apple Mailのほかのアカウントが見えない理由

iPhoneやMacのメールアプリは、追加したすべてのアカウントを1つの一覧に表示します。ChatGPTはメールアプリを読んでいるわけではありません。プラグインはAppleのiCloudメールサーバーに直接サインインするので、見えるのはiCloudのメールボックスだけです。Apple MailでiCloudの隣に並んでいるGmail、Outlook.com、Yahoo、仕事用のアカウントは、プラグインからは見えません。

GmailとOutlookについては、ChatGPTに別のプラグインがあり、合わせて接続できます。ただし注意点が2つあります。

- **Yahoo、AOL、Fastmail、Zoho、IMAPの会社用メールボックスにはChatGPTのプラグインがありません。** その場合は[ChatGPTとClaudeでYahoo Mailを使う](/blog/connect-yahoo-mail-to-chatgpt-and-claude)をご覧ください。
- **個人用のOutlook.comやHotmailのアドレス**は、ChatGPTのOutlookプラグインに拒否されることがあります。理由と代わりの方法は[ChatGPTをOutlook.comとHotmailに接続する](/blog/connect-chatgpt-to-outlook-com-hotmail)で説明しています。

プラグインはそれぞれが独立した接続で、サインインも別々です。どれを使うかはChatGPTに伝える必要があります。

## ClaudeでiCloud Mailを使う

Claudeには独自のメールコネクタが2つあります。Gmail向けと、職場のMicrosoft 365アカウント向けです。ClaudeにiCloudの選択肢はありません。Appleは対応するサードパーティ製アプリに対して、アプリ用パスワードの代わりにApple AccountでiCloud Mailを認可する道も用意していますが、Claudeにはそれを使うコネクタがなく、MCPEmailsはアプリ用パスワードを使ってIMAPでiCloudに接続します。Claudeの選択肢をメールボックスごとに整理した記事が[Claudeは私のメールを読めますか？](/blog/can-claude-read-my-email)です。

ClaudeでiCloudを使うには、iCloudへの接続を保持するMCPサーバーを追加します。それがMCPEmailsです。OpenAIのプラグインと同じく、アプリ用パスワードを使ってIMAPでiCloudに接続し、そのメールボックスをModel Context Protocolを話すあらゆるアプリに提供します。Claude、ChatGPT、Cursor、その他の[対応クライアント](/docs/clients)です。

1. [MCPEmailsの無料アカウントを作成します](/signup)。無料プランは受信トレイを1つ接続できます。
2. ダッシュボードで**受信トレイ**を開き、**受信トレイを接続**をクリックして**iCloud Mail**を選び、iCloudアドレスと新しいアプリ用パスワードを貼り付けます。サーバーの詳細とApple特有のユーザー名の癖は[iCloudの設定ページ](/connect/icloud)にあります。
3. Claudeで**カスタマイズ**、**コネクタ**の順に開き、**+ 追加**をクリックして**カスタムコネクタを追加**を選び、\`https://mcpemails.com/api/mcp\`を貼り付けます。クリックの手順をすべて載せたのが[Claudeのセットアップページ](/docs/claude)です。

これでClaudeは、iCloudのメールの閲覧、検索、送信、返信、予約送信、整理ができます。フォルダー間でメッセージを移動することも含みます。

## プラグインで足りる場合と足りない場合

iCloudが唯一のメールボックスで、ChatGPTが唯一のAIアプリなら、OpenAIのプラグインを使ってください。すべてのプランで無料で、2分で終わります。

MCPEmailsを検討する価値があるのは、次のような場合です。

- **Claudeを使っている**、またはClaude、ChatGPT、コーディングツールを行き来していて、それぞれで同じ受信トレイを使いたい。
- **メールボックスが複数ある。** iCloud、Gmail、Yahoo、Outlook.com、会社のIMAPの受信トレイを1つのアカウントに接続すれば、どのクライアントからもURL 1つですべてが見えます。エージェントがそれらをどう区別するかは[ClaudeとChatGPTで複数のメールアカウントを使う方法](/blog/multiple-email-accounts-in-claude-and-chatgpt)で説明しています。
- **読むだけでなく、メールを仕分けて片付けたい。** フォルダー、移動、アーカイブ、予約送信、常設のルールです。

ChatGPTでは、MCPEmailsをカスタムMCPサーバーとして追加します。OpenAIはこれをchatgpt.comのGoと有料プランで認めており、Freeでは追加できません。手順は[ChatGPTのセットアップページ](/docs/chatgpt)にあります。

メールがMCPEmailsに保存されることはありません。エージェントが求めたときにAppleからその場で取得し、保持するのは暗号化したアプリ用パスワードだけです。Apple側でそのパスワードを取り消せば、受信トレイはすぐに切断されます。

## よくある質問

**ChatGPTはiCloudのメールを読めますか？**
はい。設定、プラグインの順に開き、iCloudアドレスとAppleのアプリ用パスワードでiCloud Mailプラグインを接続します。OpenAIによると、Web、デスクトップ、iOSのすべてのChatGPTプランに順次提供されています。

**ChatGPTのiCloudプラグインは、Apple Mailに入れたGmailやOutlookのアカウントも見えますか？**
いいえ。プラグインはメールアプリではなくiCloudのメールサーバーにサインインするので、iCloudに保存されたメールしか見えません。ほかのアカウントは、それぞれのプラグインか、MCPEmailsのようなMCPサーバーを通じて接続してください。

**ChatGPTがAppleのパスワードを拒否するのはなぜですか？**
AppleはApple Accountでの認可に対応したアプリ以外には、アプリ用パスワードを要求します。ChatGPTのiCloud MailプラグインもMCPEmailsもこの後者にあたります。account.apple.comのサインインとセキュリティ、アプリ用パスワードで作成してください。2ファクタ認証がオンになっている必要があります。

**ClaudeにiCloudのコネクタはありますか？**
いいえ。Claude独自のメールコネクタはGmailと職場のMicrosoft 365アカウント向けです。iCloudはMCPサーバー経由のカスタムコネクタとしてClaudeに追加します。アプリ用パスワードでメールボックスをMCPEmailsに接続し、\`https://mcpemails.com/api/mcp\`をClaudeに貼り付けてください。

**iCloudをChatGPTから完全に切り離すには？**
ChatGPTの設定でプラグインの接続を解除し、そのあとaccount.apple.comでアプリ用パスワードを削除します。ChatGPT側で解除するだけでは、Apple側のパスワードは有効なままです。

## 次のステップ

ChatGPTでiCloudを使えれば十分なら、プラグインで足ります。同じiCloudの受信トレイをClaudeでも使いたい、またはほかのメールボックスと並べて使いたいなら、[無料で始めて](/signup)、アプリ用パスワードでiCloudを接続し、URLを1つAIアプリに貼り付けてください。パスワードの手順をより詳しく説明したのが[iCloud、Fastmail、IMAPのガイド](/blog/connect-icloud-fastmail-imap-to-claude)です。`,
};

export default translation;
