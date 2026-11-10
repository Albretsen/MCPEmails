const translation = {
  title: 'Yahoo Mail（yahoo.com）をChatGPTとClaudeに接続する方法',
  description:
    'ChatGPTにもClaudeにもYahoo Mailのコネクタはありません。Yahooのアプリ パスワードとMCPのURL 1つでYahoo Mailを両方に接続し、AIにメールの閲覧、検索、送信、整理を任せる手順です。Yahoo! JAPANのYahoo!メールは別サービスで、専用ページがあります。',
  coverAlt: 'MCPEmailsを通じてChatGPTとClaudeに接続したYahoo Mail',
  content: `ChatGPTは単体ではYahoo Mailを読めず、Claudeも同じです。ChatGPTのメールプラグインが対応するのはGmail、Outlook、iCloud Mail、Claudeのコネクタが対応するのはGmailと職場のMicrosoft 365アカウントです。Yahoo Mailをどちらかに接続するには、メールボックスの前段にMCPサーバーを置きます。MCPEmailsなら、Yahooのアプリ パスワードとURL 1つで済み、同じYahooの受信トレイをChatGPT、Claude、その他のAIアプリから使えるようになります。

**先にご確認ください。** このガイドは米国Yahooの**Yahoo Mail**（@yahoo.com、@ymail.com、@rocketmail.com、yahoo.co.ukなどの国別版）向けです。Yahoo! JAPANの**Yahoo!メール**（@yahoo.co.jp、@ymail.ne.jp）は別会社が運営する別のサービスで、アプリ パスワードの仕組みがなく、ここで説明するYahooの設定画面も存在しません。Yahoo!メールをお使いの場合は、IMAPアクセスを有効にしてYahoo! JAPAN IDのパスワードで接続する手順をまとめた[Yahoo!メール（Yahoo! JAPAN）の接続ページ](/connect/yahoo-japan)をご覧ください。ChatGPTとClaude側の手順（ステップ3）はどちらのサービスでも共通です。

**移動先：** [組み込みの選択肢がない理由](#chatgptとclaudeがまだyahoo-mailを読めない理由) · [アプリ パスワード](#ステップ1yahooのアプリ-パスワードを作成する) · [ChatGPT](#ステップ3achatgptに追加する) · [Claude](#ステップ3bclaudeに追加する) · [よくある質問](#よくある質問)

## ChatGPTとClaudeがまだYahoo Mailを読めない理由

OpenAIの[接続済みアプリの一覧](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)には、Gmail、Outlook、そして2026年10月27日から[iCloud Mail](/blog/chatgpt-icloud-mail-plugin)のプラグインがあります。Yahoo Mailのプラグインはありません。Claude独自のコネクタはGmailとMicrosoft 365向けです。詳しくは[Claudeは私のメールを読めますか？](/blog/can-claude-read-my-email)で説明しています。

代わりに検索で見つかるのは、次のようなものです。

- **ブラウザー拡張機能。** Web版のYahoo Mailの画面にChatGPTのボタンを追加します。開いているページでメッセージを書く助けにはなりますが、ChatGPT自体は受信トレイにアクセスできないので、検索も一括処理もできません。
- **自動化プラットフォーム。** トリガーが発火したときに、Yahooのメッセージを1通ずつAIモデルに渡します。決まったワークフロー1つには便利ですが、チャットでメールについて質問する用途には向きません。
- **コピーして貼り付ける。** 1通ずつなら使えます。

AIに本物のメールボックスを渡せるのはMCPサーバーだけです。ChatGPTもClaudeもカスタムコネクタとして受け付け、Yahooへのログインはサーバー側が行います。

## 必要なもの

- Yahoo Mailのアドレス。yahoo.com、yahoo.co.ukのような国別版、または登録時に使ったymail.comやrocketmail.comの形式です（Yahoo!メールの@yahoo.co.jpは上記の専用ページへ）。
- **ChatGPTの場合：** Goまたは有料プランで、ブラウザーのchatgpt.comから操作します。OpenAIはFreeプランでのカスタムMCPサーバーの追加を認めておらず、モバイルアプリからも追加できません。
- **Claudeの場合：** どのプランでも使えます。Freeプランでもカスタムコネクタを1つ追加できます。
- 無料のMCPEmailsアカウント。[こちらから作成できます](/signup)。無料プランは受信トレイを1つ接続できます。

## ステップ1：Yahooのアプリ パスワードを作成する

Yahooは通常のYahooパスワードで他のアプリからログインすることを認めていないため、MCPEmails用のアプリ パスワードを作成します。手順は[Yahooのヘルプページ](https://help.yahoo.com/kb/SLN15241.html)にあります。

1. Yahooにログインし、**Account Security**（アカウントセキュリティ）ページを開きます。
2. **External connections**（外部接続）の下にある**Create app password**（アプリ パスワードを作成）をクリックします。
3. 名前（たとえばMCPEmails）を入力し、**Generate password**（パスワードを生成）をクリックします。
4. パスワードをコピーします。Yahooが表示するのは一度だけです。

この項目が見当たらない場合は、同じページで2段階認証を有効にしてから、もう一度確認してください。あとでアクセスを取り消すには、同じ画面でこのアプリ パスワードを削除します。

## ステップ2：Yahoo MailをMCPEmailsに接続する

1. MCPEmailsのダッシュボードで**受信トレイ**を開き、**受信トレイを接続**をクリックします。
2. **Yahoo Mail**を選びます。
3. Yahooアドレス全体を入力し、アプリ パスワードを貼り付けます。

サーバー設定はあらかじめ入力されています。MCPEmailsは受信トレイを保存する前にYahooでログインを確認するので、パスワードが間違っていればチャットの途中ではなく、この時点で分かります。[Yahoo Mailの設定ページ](/connect/yahoo)に、IMAPとSMTPの詳細と、よくあるつまずきをまとめています。

AOLのアドレスは別のアカウントで、アプリ パスワードも別です。[AOLの設定](/connect/aol)を参考に、AOLとして接続してください。

## ステップ3a：ChatGPTに追加する

1. chatgpt.comで**プラグイン**、**Personal**（パーソナル）の順に開き、**Add**（追加）をクリックします。
2. **カスタム MCP サーバーを追加**を選び、名前をMCPEmailsにします。
3. **Connection**（接続）の下に次のURLを貼り付けます。

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. **OAuth**を選んで確認し、**プラグインとして作成**をクリックして、MCPEmailsにログインします。
5. チャットで**@**と入力し、MCPEmailsを選びます。続きの質問でメールが必要になったら、もう一度同じ操作をします。

OpenAIはこれらのメニューを時々移動します。最新の経路とよくあるエラーの対処は[ChatGPTのセットアップページ](/docs/chatgpt)にあります。

## ステップ3b：Claudeに追加する

1. claude.aiまたはClaude Desktopで**カスタマイズ**、**コネクタ**の順に開きます。
2. **+ 追加**をクリックし、**カスタムコネクタを追加**を選びます。
3. 名前をMCPEmailsにして\`https://mcpemails.com/api/mcp\`を貼り付け、**続行**、**追加**の順にクリックします。
4. **接続**をクリックしてMCPEmailsにログインし、Claudeに許可するアクセス権を承認します。

チャットでは**+**をクリックし、**コネクタ**を選んでMCPEmailsをオンにします。TeamプランやEnterpriseプランではOwnerが先にコネクタを追加します。その手順は[Claudeのセットアップページ](/docs/claude)にあります。

両方に追加しても構いません。MCPEmailsのアカウント1つで、同じYahooの受信トレイをChatGPTとClaudeから同時に使えます。

## ChatGPTとClaudeがYahoo Mailでできること

まずは読み取りだけの依頼から始めます。

> 今日届いたYahooの未読メールを要約して、返信が必要なものを教えてください。

これが動いたら、AIは次のことができます。

- 送信者、件名、日付、未読状態でメールを閲覧、検索する。
- Yahooアドレスから送信、返信、転送する（添付ファイル付きも可）。
- あとで仕上げるための下書きを保存し、送信を予約する。
- フォルダーを作成し、メッセージを移動、アーカイブ、フラグ付け、削除する。
- 受信トレイに設定した署名をすべてのメッセージに付ける。

Yahooの受信トレイに向いたプロンプトの例です。

- 「今月届いたニュースレターをすべて探して、『あとで読む』というフォルダーに移動して。先に一覧を見せて」
- 「大家さんからの最新のメールへの返信を下書きして。ただし下書きのままにして」
- 「先週、航空会社から予約について何か届いていた？」

MCPEmailsは新着メールをAIに自動で送りません。依頼されたときに確認する方式なので、まとめて確認したり整理したりする用途に向いています。

## 安全ですか

YahooのメールがMCPEmailsに保存されることはありません。ChatGPTやClaudeが求めたときにYahooからその場で取得し、渡したあとは破棄します。保持されるのはアプリ パスワードだけで、暗号化して保存します。本物のYahooパスワードは、Yahoo以外のどこにも入力しません。

接続を承認するときに、各AIアプリに何を許可するかを選べます。読み取りだけにするか、送信も許可するかです。受信トレイの所有者は、ダッシュボードですべての送信を承認待ちにすることもできます。メールの中に隠された指示など、知っておくべきリスクは[AIエージェントにメールへのアクセスを許可しても安全か](/blog/is-it-safe-to-give-ai-agent-email-access)で説明しています。

## トラブルシューティング

- **Yahooがパスワードを拒否する。** Yahooのパスワードではなくアプリ パスワードを使い、スペースを入れずに貼り付けてください。
- **アプリ パスワードを作成する項目がない。** 先にAccount Securityページで2段階認証を有効にしてください。
- **アドレスが@yahoo.co.jpや@ymail.ne.jpである。** それはYahoo! JAPANのYahoo!メールで、このページの手順は当てはまりません。[Yahoo!メールの接続ページ](/connect/yahoo-japan)をご覧ください。
- **ChatGPTにカスタムMCPサーバーを追加する項目がない。** Goまたは有料プランで、ブラウザーのchatgpt.comから操作する必要があります。
- **AIがメールを読まずに答える。** ChatGPTでは、そのメッセージで@からMCPEmailsを指定してください。Claudeでは、コネクタの一覧でMCPEmailsがオンになっているか確認してください。
- **Yahooのほかにもメールボックスがある。** 両方をMCPEmailsに接続してください。AIがそれらをどう区別するかは[ClaudeとChatGPTで複数のメールアカウントを使う方法](/blog/multiple-email-accounts-in-claude-and-chatgpt)で説明しています。

## よくある質問

**ChatGPTはYahoo Mailを読めますか？**
単体では読めません。ChatGPTにYahoo Mailのプラグインはありません。Yahooのアプリ パスワードでYahoo MailをMCPEmailsのようなMCPサーバーに接続し、\`https://mcpemails.com/api/mcp\`をカスタムMCPサーバーとしてChatGPTに追加すれば、ChatGPTがYahooのメールを閲覧、検索、送信できるようになります。

**ClaudeはYahoo Mailで使えますか？**
はい、カスタムコネクタ経由で使えます。Claude独自のメールコネクタはGmailとMicrosoft 365向けなので、YahooはMCPサーバーを通します。カスタムコネクタはFreeプランを含むすべてのClaudeプランで使えます。

**Yahoo! JAPANのYahoo!メールも同じ手順ですか？**
いいえ。Yahoo!メール（@yahoo.co.jp、@ymail.ne.jp）は米国のYahoo Mailとは別のサービスで、アプリ パスワードはありません。Yahoo!メールの設定でYahoo! JAPAN公式サービス以外からのアクセスを許可し、IMAPとSMTPを有効にしたうえで、Yahoo! JAPAN IDのパスワードで接続します。手順は[Yahoo!メールの接続ページ](/connect/yahoo-japan)にあります。接続後のChatGPTとClaude側の設定は、このページのステップ3と同じです。

**Yahooのパスワードは必要ですか？**
いいえ。Yahooは他のアプリからのアカウントパスワードを受け付けません。Account SecurityページのExternal connectionsでアプリ パスワードを作成し、それを使います。

**同じ設定がChatGPTとClaudeの両方で使えますか？**
はい。Yahooの受信トレイを一度接続し、同じURLをそれぞれのアプリに追加します。各アプリは別々にMCPEmailsにログインし、それぞれの権限を持ちます。

**接続を解除するには？**
MCPEmailsで受信トレイを削除するか、YahooのAccount Securityページでアプリ パスワードを削除します。どちらでもアクセスは止まります。

## 次のステップ

[無料で始めて](/signup)、アプリ パスワードでYahooの受信トレイを接続し、URLを1つChatGPTまたはClaudeに追加してください。Yahoo、AOL、iCloudなどのパスワードの手順は[アプリ パスワードとは？](/blog/what-is-an-app-password)で説明しています。`,
};

export default translation;
