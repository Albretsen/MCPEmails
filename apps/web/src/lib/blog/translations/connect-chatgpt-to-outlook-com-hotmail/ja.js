const translation = {
  title: 'ChatGPTをHotmail・Outlook.comに接続する方法（個人用Microsoftアカウント）',
  description:
    'ChatGPTのOutlookプラグインは職場や学校のアカウント向けです。個人用のHotmail、Outlook.com、Live、MSNの受信トレイをChatGPTに接続するには、Microsoftでログインし、カスタムMCPサーバーのURLを1つ追加します。',
  coverAlt: 'MCPEmailsを通じて個人用のOutlook.comまたはHotmailの受信トレイに接続したChatGPT',
  content: `個人用のOutlook.com、Hotmail、Live、MSNのアドレスをChatGPTに接続するには、**Microsoftで接続**でメールボックスをMCPEmailsに追加し、URLを1つカスタムMCPサーバーとしてChatGPTに追加します。ChatGPT独自のOutlookプラグインは職場や学校のMicrosoftアカウントを前提に作られていて、個人用のアドレスで試した人からは、法人または教育機関のアカウントしか接続できないと表示されたという報告があります。カスタムMCPサーバーにはそうした制限がありません。

このガイドは、ChatGPTで個人用Microsoftアカウントを使う場合の手順です。Claudeの場合は[ClaudeをHotmail・Outlook.comに接続する方法](/blog/connect-claude-to-outlook-com-hotmail)を、職場や学校のMicrosoft 365アカウントの場合は[OutlookとMicrosoft 365のガイド](/blog/connect-outlook-microsoft-365-ai-agent-mcp)をご覧ください。

## ChatGPTのOutlookプラグインが対応している範囲

ChatGPTにはOutlook EmailとOutlook Calendarのプラグインがあります。OpenAIの[ヘルプページ](https://help.openai.com/en/articles/12512241)は組織向けに書かれています。一部の操作には、Microsoft Entraの管理者が組織に対して承認する必要のあるMicrosoftのアクセス許可が必要で、どの操作を有効にするかはワークスペースの管理者が決めます。個人用Microsoftアカウントに対応しているかどうかは、このページには書かれていません。

試した人たちは、対応していないと言っています。2025年9月の[Microsoft Q&Aのスレッド](https://learn.microsoft.com/en-gb/answers/questions/5558072/cant-connect-outlook-to-chatgpt)では、Hotmailのユーザーが、Outlookのサインインの段階で法人または教育機関のアカウントしか接続できないというメッセージに止められています。2026年4月の返信でも、個人用のHotmailとOutlook.comのアカウントは引き続き対象外とされています。OpenAIはそれ以降の変更を文書化していないので、試してみたいならまずプラグインを確認してください。アドレスが受け付けられれば、ほかには何も要らないかもしれません。

拒否されたなら、原因はアカウントの種類です。個人用Microsoftアカウントには組織も管理者もいません。あなたの側の設定で変えられるものではありません。

## 必要なもの

- Outlookのメールボックスがある個人用Microsoftアカウント：outlook.com、hotmail.com、live.com、msn.com。hotmail.co.ukやoutlook.deのような国別版も含みます。
- **ChatGPT Goまたは有料プランで、ブラウザーのchatgpt.comから操作すること。** OpenAIがカスタムMCPサーバーの追加を認めているのはこれらのプランです。Freeでは追加できず、モバイルアプリからも追加できません。
- MCPEmailsのアカウント。[無料で始める](/signup)から登録します。無料プランは受信トレイを1つ接続できます。

MCPEmailsは、一方ではModel Context ProtocolでChatGPTと、もう一方ではMicrosoft Graphを通じてメールボックスとやり取りします。

## ステップ1：Outlook.comまたはHotmailの受信トレイを接続する

1. MCPEmailsのダッシュボードで**受信トレイ**を開き、**受信トレイを接続**をクリックします。
2. **Outlook**を選び、**Microsoftで接続**をクリックします。
3. Microsoftのページで、Outlook.com、Hotmail、Live、MSNのアドレスでログインします。アカウントで2段階認証を使っている場合は、それも完了します。
4. アクセス許可を承認します。Microsoftからは、MCPEmailsにメールの読み取りと変更、ユーザーとしてのメール送信、このアクセスの維持、基本プロフィールとメールアドレスの表示を許可するかどうかを尋ねられます。

ダッシュボードに戻ると、受信トレイが接続された状態になっています。個人用アカウントでは管理者は関与せず、MicrosoftのパスワードをMCPEmailsに入力することもありません。

### IMAPとアプリ パスワードは使わない

古いガイドには、アプリ パスワードを作成してOutlookのIMAP設定を入力するよう書かれています。Microsoftは2024年9月16日に[Microsoft以外のメールアプリでのOutlookアカウントのパスワードによるログインを終了](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d)したため、この経路ではもうログインできません。**IMAP / SMTP**を選んでHotmailやOutlook.comのアドレスを入力すると、ダッシュボードが**Use Sign in with Microsoft**（Microsoftでログインを使う）へ案内します。詳細は[Outlook.comの設定ページ](/connect/outlook)に1か所にまとめています。

## ステップ2：MCPEmailsをChatGPTに追加する

1. chatgpt.comで**プラグイン**、**Personal**（パーソナル）の順に開き、右上の**Add**（追加）をクリックします。
2. **カスタム MCP サーバーを追加**を選び、名前をMCPEmailsにします。
3. **Connection**（接続）の下に次のURLを貼り付けます。

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. **OAuth**を選び、**理解したうえで続行します**にチェックを入れて、**プラグインとして作成**をクリックします。
5. MCPEmailsにログインし、ChatGPTに許可するアクセス権を承認します。最初は読み取りだけでも構いません。
6. チャットで**@**と入力し、MCPEmailsを選びます。この選択はそのメッセージにだけ適用されるので、続きの質問でメールが必要になったら、もう一度@で指定してください。

「認証なし」ではなくOAuthを選んでください。認証なしで作成したコネクタは、設定時には問題なく見えて、最初の呼び出しで失敗します。BusinessやEnterpriseのワークスペースでは、管理者がサーバーを追加する必要がある場合があります。OpenAIはこれらのメニューを時々移動するので、最新の経路は[ChatGPTのセットアップページ](/docs/chatgpt)で確認してください。

## ステップ3：ChatGPTに小さな依頼をする

読み取りだけから始めます。

> Hotmailの受信トレイにある未読メールのうち新しい5件を要約して、返信が必要なものを教えて。

答えが返ってくれば、接続は成功です。次のような依頼も試してみてください。

- 「先週届いた注文確認メールを探して、配達日を教えて」
- 「大家さんからの最新のメールへの返信を下書きして。ただし送信はしないで」
- 「今月のニュースレターをすべて『あとで読む』というフォルダーに移動して」

Gmail、iCloud、Yahoo、仕事用のメールボックスもある場合は、それらもMCPEmailsに接続すれば、ChatGPTは同じサーバーを通じてすべてを扱えます。どう区別するかは[ClaudeとChatGPTで複数のメールアカウントを使う方法](/blog/multiple-email-accounts-in-claude-and-chatgpt)で説明しています。

## ChatGPTがOutlook.comの受信トレイでできること

- メールの閲覧と検索。
- 自分のアドレスからの送信、返信、転送（添付ファイル付きも可）。
- 下書きの作成と編集、予約送信。
- フォルダーの作成（入れ子のフォルダーも可）、メッセージの移動、コピー、アーカイブ。
- メッセージへのフラグ設定、既読・未読の切り替え。
- メッセージの「削除済みアイテム」への移動、または完全な削除。
- その受信トレイに設定した署名を、送信するすべてのメッセージに追加。

Outlook.comはラベルではなくフォルダーを使うため、ChatGPTはメールを移動して仕分けします。Microsoft Graphの制限で知っておきたい点が1つあります。テキスト検索は、未読、添付ファイル、フラグ付き、日付のフィルターと組み合わせられません。検索にテキストが含まれるとこれらのフィルターは外され、どれが外されたかが結果に示されます。先にテキストで検索し、ChatGPTに結果を絞り込ませてください。

MCPEmailsは新着メールをChatGPTに自動で送りません。依頼されたときに確認します。

## Outlook.comのメールはどこかに保存されますか？

いいえ。ChatGPTがメッセージを要求するたびに、MCPEmailsはMicrosoftからその場で取得して渡し、破棄します。受信トレイについて保持されるのは、Microsoftでログインしたときに発行されたOAuthトークン（保存時は暗号化）と、送信を待っている予約メッセージのように、オンにした機能に必要なわずかな情報だけです。接続を解除するには、MCPEmailsで受信トレイを削除するか、Microsoftアカウントにアクセスできるアプリの一覧からMCPEmailsを削除します。この仕組みは[「メールを一切保存しない」ことが重要な理由](/blog/why-email-never-stored-matters)で説明しています。

## よくある質問

**ChatGPTをHotmailやOutlook.comに接続できますか？**
はい、カスタムMCPサーバーを使えばできます。MCPEmailsで「Microsoftで接続」からアドレスを接続し、ChatGPTのプラグインで\`https://mcpemails.com/api/mcp\`を追加すれば、ChatGPTがOutlook.com、Hotmail、Live、MSNのメールを閲覧、検索、送信、整理できるようになります。カスタムMCPサーバーの追加にはChatGPT Goまたは有料プランが必要です。

**ChatGPTのOutlookプラグインは個人用アカウントで使えますか？**
OpenAIのヘルプページには書かれておらず、ユーザーからは、サインイン時に法人または教育機関のアカウントしか接続できないと表示されたという報告があります。文書化されている設定手順は組織のMicrosoft Entra管理者を前提にしており、個人用アカウントにはそれがありません。

**アプリ パスワードやIMAPの設定は必要ですか？**
いいえ。個人用MicrosoftアカウントはMicrosoftでのログインとMicrosoft Graphを通じて接続します。Microsoftはこれらのアカウントで、Microsoft以外のメールアプリからのパスワードによるログインをもう受け付けていません。

**古いHotmailのアドレスでも使えますか？**
はい。Hotmail、Live、MSN、Outlook.comのアドレスはどれもMicrosoftの同じ個人向けメールサービスなので、接続方法も同じです。

**同じ設定はClaudeでも使えますか？**
はい。URLは同じです。Claude側の手順は[ClaudeをHotmail・Outlook.comに接続する方法](/blog/connect-claude-to-outlook-com-hotmail)で説明しており、Freeを含むすべてのClaudeプランで使えます。

## 次のステップ

[無料で始める](/signup)から登録し、Outlook.comまたはHotmailの受信トレイをMicrosoftで接続し、URLをChatGPTに追加して、未読メールの要約を頼んでみてください。ほかのプロバイダーについては、[ChatGPTとメールを連携する](/blog/connect-chatgpt-to-email)でGmail、iCloud、IMAPを扱っています。`,
};

export default translation;
