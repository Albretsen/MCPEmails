const translation = {
  title: 'ChatGPTとメールを連携する方法：Yahoo、iCloud、Outlook、IMAP対応',
  description:
    'Gmail、Outlook、iCloud、Fastmail、任意のIMAP受信トレイをカスタムMCPコネクタでChatGPTと連携し、OpenAI Codexにはスコープを絞ったキーで接続する手順をステップごとに解説します。メールは保存されません。',
  coverAlt:
    'MCPEmailsでChatGPTとOpenAI CodexをGmail、Outlook、iCloud、Fastmail、IMAPメールと連携する',
  content: `ChatGPTは単体ではメールボックスにアクセスできません。メールの前段にMCPサーバーが必要で、MCPEmailsがそのサーバーです。受信トレイを一度接続し、ChatGPTにURLを1つ指定するだけで、メールがGmail、OutlookやMicrosoft 365、iCloud、Fastmail、Yahoo、Zoho、自前のIMAPサーバーのどこにあっても、同じメールツールが使えるようになります。

OpenAIには2つの利用面があり、認証の方法が異なります。ChatGPTはブラウザーでOAuthフローを実行するため、貼り付けるAPIキーはありません。OpenAI Codexはターミナルで動作し、代わりにスコープを絞ったBearerキーを使います。エンドポイントもツールも同じです。

**移動先：** [ChatGPTの設定](#ステップ2chatgptでコネクタを追加する) · [OpenAI Codex](#ターミナルのopenai-codex) · [トラブルシューティング](#トラブルシューティング)

## 必要なもの

- **Web版のChatGPTの有料プラン。** OpenAIの[カスタムMCPサーバーのヘルプページ](https://help.openai.com/en/articles/12584461)では、chatgpt.comのBusinessとEnterprise/Eduのワークスペースが対象として挙げられ、Proでは読み取りと取得のツールに限られます。GoとPlusへの言及はありません。モバイルアプリでは追加できません。BusinessとEnterpriseでは、管理者またはオーナーがワークスペースに追加して公開します。
- **無料のMCPEmailsアカウント。** [こちらから作成できます](/signup)。無料プランは受信トレイを1つ接続でき、カードは不要です。
- **メールボックスを1つ。** Gmail、OutlookまたはMicrosoft 365、iCloud、Fastmail、Yahoo、Zoho、Yandex、またはIMAPとSMTPに対応するものなら何でも使えます。

お使いのChatGPTプランでカスタムMCPサーバーを追加できない場合でも、同じ受信トレイと同じURLが[Claude](/docs/claude)、[Cursor](/docs/cursor)、[VS Code](/docs/vscode)、その他の[対応クライアント](/docs/clients)ですでに使えます。

## ステップ1：MCPEmailsに受信トレイを接続する

MCPEmailsのダッシュボードで**受信トレイ**、**受信トレイを接続**の順に開き、プロバイダーを選びます。

### GmailとGoogle Workspace

GmailはGoogleのアプリ パスワードを使ってIMAPで接続します。2 段階認証プロセスを有効にし、myaccount.google.com/apppasswordsでアプリ パスワードを作成して、16文字のパスワードをGmailアドレス全体と一緒に貼り付けます。通常のGoogleパスワードは使えません。Google Workspaceの管理者はドメインのアプリ パスワードを無効にできるため、この項目が見当たらない場合は管理者に確認してください。手順は[Gmailの手順](/blog/connect-gmail-to-claude)にあります。

### iCloud、Fastmail、Yahoo、Zoho

これらのプロバイダーは、Webで入力するパスワードではなく、アプリ用のパスワードを必要とします。プロバイダー側で作成し、MCPEmailsでそのプロバイダーを選んで貼り付けます。正確な手順は[iCloud、Fastmail、IMAPのガイド](/blog/connect-icloud-fastmail-imap-to-claude)にあります。

### OutlookとMicrosoft 365

Outlookはアプリ パスワードではなくSign in with Microsoft（Microsoftでサインイン）で接続します。**Outlook**を選び、**Connect with Microsoft**（Microsoftで接続）をクリックして承認します。個人のOutlook.com、Hotmail、Live、MSNアカウントはすぐに接続されます。職場または学校のMicrosoft 365アカウントでは、先にIT管理者が組織全体に対してアプリを一度承認する必要がある場合があります。ダッシュボードに、管理者へ送るためのリンクが表示されます。詳しくは[OutlookとMicrosoft 365のガイド](/blog/connect-outlook-microsoft-365-ai-agent-mcp)をご覧ください。

### その他のIMAPメールボックス

**IMAP**を選び、アドレスとアプリ パスワードを入力します。一般的な設定は自動的に検出されます。独自ドメインでは、プロバイダーが案内するホスト、ポート、セキュリティモードが必要になることがあります。[プロバイダー一覧表](/docs/providers)に各プロバイダーの対応機能があり、[connect](/connect)の下にプロバイダーごとのページがあります。[Gmail](/connect/gmail)、[Outlook](/connect/outlook)、[Microsoft 365](/connect/office365)、[iCloud](/connect/icloud)、[汎用IMAP](/connect/imap)などです。

プランで許可されていれば、メールボックスを複数接続できます。ChatGPTは\`inbox_list\`でそれらを見つけるので、プロンプトにメールボックスIDを貼り付けることはありません。

## ステップ2：ChatGPTでコネクタを追加する

1. chatgpt.comで**プラグイン**、**Personal**（個人）の順に開き、右上の**Add**（追加）をクリックします。
2. **カスタム MCP サーバーを追加**を選び、名前をMCPEmailsにします。
3. **接続**の下に次のURLを貼り付けます。

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. **OAuth**を選び、**理解したうえで続行します**にチェックを入れて、**プラグインとして作成**をクリックします。
5. MCPEmailsでログインして承認します。
6. チャットで**@**と入力し、MCPEmailsを選びます。この選択はそのメッセージにだけ適用されるので、続きの質問でメールが必要になったら、もう一度@でMCPEmailsを指定してください。

「認証なし」ではなくOAuthを選んでください。このサーバーは匿名の呼び出しを拒否するため、認証なしで作成したコネクタは設定時には問題なく見えて、最初のツール呼び出しで失敗します。これは原因が分かりにくい順序です。OAuthなら、ChatGPTが自分で登録を行い、PKCE付きの認可コードフローを完了します。作成するクライアントIDも、どこかに置くクライアントシークレットもありません。OpenAIはこれらのメニューを時々移動するので、最新の経路は[ChatGPTのセットアップページ](/docs/chatgpt)で確認してください。

## ステップ3：必要なスコープだけを承認する

同意画面はOpenAIのものではなく、MCPEmailsのものです。ChatGPTはあとから追加のアクセスを求めに戻ってこないため、ChatGPTの場合は**フルアクセス**が選ばれた状態で開きます。範囲を絞りたい場合は、**アクセスを許可**をクリックする前に選び直してください。**読み取り専用**ならトリアージ、要約、検索には十分で、取り消せない操作はすべて対象外になります。**権限を個別に設定**には9つの権限（読み取り、検索、送信、フォルダー、削除、下書き、連絡先、予約、自動化）がすべて表示されます。また、この画面では既定で、あとから接続するものも含めてワークスペース内のすべての受信トレイにアクセスできます。制限するには、そこで特定の受信トレイを選んでください。

付与が足りなくても後から直せます。ChatGPTの接続にない権限をツールが必要とする場合、ツールの結果にどの権限が不足しているかが示され、ChatGPTに再接続を求めます。受信トレイの所有者はダッシュボードで[人による承認](/blog/approve-ai-agent-email-sends)を必須にすることもでき、その場合はすべての送信、返信、転送、下書きの送信、予約送信が、人が解放するまで保留されます。

## ステップ4：ChatGPTに安全な最初のタスクを任せる

読み取りだけから始めます。

> 未読メールのうち新しい3件を要約して、今日中に返信が必要なものを教えてください。送信、移動、削除は何もしないでください。

ChatGPTはまず受信トレイを見つけ、必要なメッセージだけを読みます。これが動いたら、次を試してください。

- 「先月Stripeから届いた請求書を探して、金額を教えて」
- 「Alexからの最新メッセージへの返信を下書きして。ただし下書きのままにして」
- 「今週届いたニュースレターのうち、アーカイブできそうなものを見せて。私の確認を待って」

繰り返し使うルーチンは、[受信トレイのトリアージ手順](/blog/ai-agent-triage-summarize-inbox)や[ワークフロープロンプト集](/blog/ai-agent-email-workflows-and-prompts)から始めてください。

## 接続後にChatGPTができること

MCPEmailsは、パスワードや生のIMAPソケットではなく、目的を絞ったツールをChatGPTに渡します。

- **読み取りと検索：** \`email_read\`はlist、read、read_batch、search、attachmentをカバーします。検索は送信者、件名、日付、未読状態などの構造化フィールドを使い、Gmailのラベルはフォルダーとして表示されます。
- **送信、返信、転送：** \`email_compose\`は、お使いのプロバイダーとアドレスから送信します。
- **整理：** \`email_organize\`、\`email_search_and_move\`、\`email_delete\`。
- **下書き、フォルダー、予約送信：** \`draft\`、\`draft_list\`、\`folder\`、\`folder_list\`、\`schedule\`、\`schedule_list\`。
- **その他：** \`contact_search\`、\`signature_get\`、\`signature_set\`に加えて、繰り返しのルール用の\`automation\`と\`automation_read\`。

計画しておきたい制限が1つあります。チャットの中では、ChatGPTはメッセージが届いた瞬間ではなく、依頼されたときに新着メールを確認します。コネクタ側からChatGPTを呼び出す仕組みはありません（自分のコードは別です。ProとBusinessのワークスペースではダッシュボードの**APIキー**でWebhookを追加でき、新着メールが届くとあなたのURLに署名付きのPOSTが送られます）。

## ターミナルのOpenAI Codex

CodexはChatGPTコネクタとは別の利用面で、ブラウザーのOAuthフローは使いません。ターミナルクライアントは代わりにBearerトークンで認証します。

1. ダッシュボードで**APIキー**を開き、このエージェントに必要なスコープだけにチェックを入れてキーを作成します。
2. すぐにコピーします。キーは\`mcpe_\`の後に64文字の16進数が続く形式で、表示されるのは一度だけです。
3. Codex自身のMCP設定で\`https://mcpemails.com/api/mcp\`をstreamable HTTPのMCPサーバーとして登録し、キーを\`Authorization: Bearer\`ヘッダーで渡します。

キーによる接続もOAuthによる接続も同じエンドポイントにアクセスし、同じツールカタログが見えます。違いはトークンの出どころだけです。先にエンドポイントの動作を確かめたい場合は、[生のHTTPガイド](/docs/curl)に1行の\`tools/list\`呼び出しがあり、[OAuthとAPIキーの比較](/blog/oauth-vs-api-keys-ai-email-access)でどちらの経路が適切かを説明しています。

キーのスコープは厳しく絞ってください。コーディングエージェントには通常、読み取り専用が適切です。サポートスレッドを要約できるエージェントは役に立ちますが、無人でメールを送信できるエージェントは別のリスク区分に入ります。

## トラブルシューティング

- **カスタムMCPサーバーを追加する項目がない。** カスタムMCPサーバーはモバイルアプリではなくブラウザーのchatgpt.comで追加します。OpenAIが挙げているのはBusinessとEnterprise/Eduで、Proでは読み取りと取得のツールに限られるため、BusinessまたはEnterpriseワークスペースでは、管理者またはオーナーが追加する必要がある場合があります。
- **コネクタが最初のツール呼び出しで失敗する。** おそらく認証なしで作成されています。削除して、OAuthで作り直してください。
- **コネクタは作成されたが、ChatGPTがメールに触れずに回答する。** そのメッセージでMCPEmailsが選ばれていません。**@**と入力してMCPEmailsを選び、もう一度質問してください。
- **プロバイダーがパスワードを拒否する。** Webのログインパスワードではなく、プロバイダーが生成したアプリ パスワードを使ってください。2要素認証を有効にしないと発行しないプロバイダーもあります。
- **カスタムIMAP接続がタイムアウトする。** ホスト、ポート、TLSモードを確認してください。通常、ポート993は暗黙的TLS、ポート143はSTARTTLSを使います。
- **ChatGPTは接続できているがメールが見えない。** ダッシュボードで受信トレイが有効になっているか確認し、接続が\`read:email\`を持っているか確かめて、ChatGPTに先に\`inbox_list\`を呼び出すよう依頼してください。

## よくある質問

**ChatGPTは私のメールを読んだり送信したりできますか？**
カスタムMCPコネクタを通じて可能です。読み取り、検索、送信、返信、転送、整理、予約送信のすべてが、設定時に承認したスコープの範囲内で行われます。

**ChatGPTにAPIキーは必要ですか？**
いいえ。OAuthを選べば、ChatGPTが自分で登録してフローを完了します。APIキーは、Codexやスクリプトのようにブラウザーのフローを実行できないクライアント向けです。

**Codexも同じ方法で設定しますか？**
いいえ。Codexはターミナルの利用面なので、ブラウザーのOAuthフローではなく、\`Authorization: Bearer\`ヘッダーにスコープを絞ったAPIキーを使います。エンドポイントもツールも同じです。

**私のメールはあなたのサーバーに保存されますか？**
いいえ。すべてのメッセージは、それを求めたリクエストのためにプロバイダーからリアルタイムで取得され、その後破棄されます。保持されるのは暗号化されたプロバイダーの認証情報だけです。[メールを決して保存しないことが重要な理由](/blog/why-email-never-stored-matters)で考え方を説明しています。

**料金はいくらですか？**
Freeは受信トレイ1つを接続でき、上限は[料金ページ](/pricing)に記載しています。有料プランでは受信トレイが増えます。

## 次のステップ

[無料で始めて](/signup)、受信トレイを接続し、\`https://mcpemails.com/api/mcp\`をChatGPTに追加して、未読メールの要約を頼んでみてください。現在のクリック経路は[ChatGPTのセットアップページ](/docs/chatgpt)に、完全なツールリファレンスは[ドキュメント](/docs)にあります。`,
};

export default translation;
