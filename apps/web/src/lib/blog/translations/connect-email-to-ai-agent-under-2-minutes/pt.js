const translation = {
  title: 'Como conectar seu e-mail a um agente de IA em menos de 2 minutos (Gmail, Outlook, iCloud, Fastmail e IMAP)',
  description:
    'Conecte seu e-mail a um agente de IA em menos de 2 minutos. Passo a passo para Gmail, Outlook, iCloud, Fastmail e qualquer caixa de entrada IMAP via MCP: nenhum e-mail é armazenado.',
  coverAlt:
    'Conecte seu e-mail a um agente de IA em menos de 2 minutos: Gmail, Outlook, iCloud, Fastmail e IMAP via MCP',
  content: `Você conecta seu e-mail a um agente de IA em dois movimentos: conecte a caixa de entrada no painel do MCPEmails e depois aponte seu agente para uma única URL de endpoint. Com um cliente compatível com OAuth, como o claude.ai, é só isso. Sem código, sem SDK, e seu e-mail nunca é armazenado em lugar nenhum: cada leitura e cada envio chega ao seu provedor ao vivo e é descartado no momento em que o agente recebe.

Este é o guia rápido. Escolha seu provedor abaixo, siga os quatro ou cinco passos e você terá o Claude (ou o Cursor, ou um script próprio) lendo e enviando e-mails de verdade mais ou menos no tempo que leva para ler este parágrafo duas vezes. Para a versão mais profunda de "o que é isso e é seguro", comece pelo [guia completo para dar acesso ao e-mail ao seu agente de IA](/blog/how-to-give-your-ai-agent-email-access).

## O passo que todo provedor compartilha: conectar seu cliente

Antes de mexer em um provedor, decida como seu agente de IA vai falar com o MCPEmails. Há dois caminhos, e os dois usam o mesmo endpoint e as mesmas ferramentas.

**Caminho A: cliente OAuth (claude.ai, Claude Desktop, Cursor).** Sem chave de API. Você cola uma URL e aprova um login:

1. No claude.ai, vá em **Personalizar → Conectores**, depois **Add connector** (Adicionar conector).
2. Cole o endpoint: \`https://www.mcpemails.com/api/mcp\`
3. Clique em **Conectar**, faça login na sua conta do MCPEmails e aprove o nível de acesso que você quiser (**Somente leitura**, **Padrão**, **Acesso total** ou um conjunto personalizado de permissões).

Isso é todo o lado do cliente. Os tokens têm exatamente o escopo que você aprovou, e você pode revogar a conexão no painel com um clique. Se quiser os prós e contras explicados, veja [OAuth vs. chaves de API para acesso de IA ao e-mail](/blog/oauth-vs-api-keys-ai-email-access). Para um passo a passo por cliente, veja como [conectar o Claude ao seu e-mail](/blog/connect-claude-to-email) ou [conectar o ChatGPT ao seu e-mail](/blog/connect-chatgpt-to-email).

**Caminho B: cliente com chave de API (Cline, JetBrains, cURL, agentes próprios).** Para qualquer coisa sem OAuth integrado:

1. Vá em **Painel → Chaves de API** e crie uma chave.
2. Escolha os escopos dela (\`read:email\`, \`send:email\`).
3. Copie uma vez (ela só é mostrada uma vez) e envie como cabeçalho: \`Authorization: Bearer <your-api-key>\`, também contra \`https://www.mcpemails.com/api/mcp\`.

Se você vive dentro de um editor, a [configuração de e-mail para Cursor, Cline e VS Code](/blog/email-for-ai-agents-cursor-cline-vscode) cobre esse caminho do início ao fim.

Agora a caixa de entrada. Todo provedor abaixo começa do mesmo jeito: **Painel → Caixas de entrada → Conectar caixa de entrada**, e aí você escolhe o provedor.

## Conectar cada provedor

### Gmail (senha de app)

O Gmail se conecta por padrão com uma senha de app do Google, por IMAP.

1. Ative a verificação em duas etapas na sua Conta do Google e crie uma senha de app em **myaccount.google.com/apppasswords**. São 16 letras minúsculas em quatro grupos.
2. **Painel → Caixas de entrada → Conectar caixa de entrada → Gmail.**
3. Digite seu endereço completo do Gmail, cole a senha de app e clique em **Conectar caixa de entrada**.
4. A conexão é testada no Gmail e a caixa aparece como conectada. Pronto.

Sua senha normal do Google nunca funciona aqui e nunca é necessária. Por IMAP, os marcadores do Gmail aparecem como pastas, e as buscas usam os campos estruturados do MCPEmails (remetente, assunto, data, não lidos e assim por diante) em vez dos operadores de busca do próprio Gmail. Você pode revogar a senha de app a qualquer momento na mesma página do Google. Se você usa o Google Workspace e a página de senhas de app não aparece, o administrador pode ter desativado as senhas de app para o domínio. O [passo a passo do Gmail](/blog/connect-gmail-to-claude) tem os detalhes.

### Outlook / Microsoft 365 (Entrar com a Microsoft)

O Outlook se conecta com um login da Microsoft em vez de senha. Sem senha de app e sem configurações de IMAP.

1. **Painel → Caixas de entrada → Conectar caixa de entrada → Outlook.**
2. Clique em **Conectar com a Microsoft** e faça login com sua conta Microsoft na página da Microsoft.
3. Aprove as permissões.
4. A caixa aparece como conectada. O envio sai pelo Microsoft Graph, então é uma mensagem normal da sua própria conta.

Contas pessoais do Outlook.com, Hotmail, Live e MSN se conectam assim, sem envolver administrador. Contas corporativas ou de estudante do Microsoft 365 podem precisar que um administrador de TI aprove o app primeiro: muitas organizações impedem que os funcionários aprovem sozinhos o acesso à caixa de e-mail. Se isso acontecer, o painel dá a você um link para enviar ao administrador de TI, que aprova o app uma vez para toda a organização, e aí você conecta como acima. O [guia de configuração do Outlook e Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) explica tudo passo a passo.

### iCloud (senha específica do app)

O iCloud não oferece OAuth a terceiros, então você gera uma senha específica do app. Leva um minuto a mais.

1. Acesse [appleid.apple.com](https://appleid.apple.com), faça login e abra a seção **Início de sessão e segurança**.
2. Em **Senhas específicas de apps**, crie uma nova e dê a ela o nome "MCPEmails".
3. Copie a senha gerada (ela tem o formato \`xxxx-xxxx-xxxx-xxxx\`).
4. Em **Painel → Caixas de entrada → Conectar caixa de entrada → iCloud**, digite seu endereço do iCloud e cole essa senha de app.

O iCloud roda sobre IMAP/SMTP por baixo, então você tem o mesmo conjunto de ferramentas que todo mundo.

### Fastmail (senha específica do app, não OAuth)

Uma correção rápida se você leu documentação antiga: **o Fastmail se conecta com uma senha de app, não com OAuth.** Não procure um botão "Entrar com o Fastmail": ele não existe aqui.

1. No Fastmail, abra **Settings → Privacy & Security → Integrations** (ou **App Passwords**).
2. Crie uma nova senha de app. Dê a ela acesso a e-mail (IMAP/SMTP) e o nome "MCPEmails".
3. Copie a senha que o Fastmail gera.
4. Em **Painel → Caixas de entrada → Conectar caixa de entrada → Fastmail**, digite seu endereço do Fastmail e cole a senha.

É isso: do lado do agente, o Fastmail se comporta exatamente como os outros provedores IMAP.

### IMAP genérico (Yahoo, Zoho, Yandex e os demais)

Qualquer serviço que fale IMAP/SMTP funciona por um único conector. O padrão é idêntico ao do iCloud e do Fastmail: crie uma senha de app no seu provedor e depois cole.

1. Nas configurações de segurança do seu provedor, crie uma **senha de app** (Yahoo, Zoho e Yandex escondem isso na segurança da conta). Use uma senha de app de verdade, não a senha de login: a maioria dos provedores já bloqueia IMAP com senha comum de qualquer forma.
2. **Painel → Caixas de entrada → Conectar caixa de entrada → IMAP.**
3. Digite seu endereço de e-mail e a senha de app. O MCPEmails detecta automaticamente os servidores comuns; se o seu for incomum, informe o host e a porta IMAP e SMTP que o provedor lista.
4. Salve. A caixa de entrada se conecta e está pronta.

Para as particularidades do iCloud, do Fastmail e da longa lista de provedores IMAP, o [aprofundamento em iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) é a referência de solução de problemas.

## Primeira chamada: descobrir e depois agir

Seja qual for o provedor escolhido, o primeiro movimento do agente é sempre o mesmo. Faça-o chamar \`inbox_list\` para descobrir o que está conectado e pegar o \`inbox_id\` de cada caixa de entrada: o agente nunca copia e cola um UUID. A partir daí, ele trabalha com um conjunto pequeno de ferramentas consolidadas: \`email_read\` (com um \`action\` de \`list\`, \`read\` ou \`search\`), \`email_compose\` (\`send\`, \`reply\` ou \`forward\`) e \`email_organize\` para mover, marcar e arquivar, além de \`folder\`, \`draft\`, \`schedule\` e \`contact_search\`:

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose",
    "email_organize"
  ]
}
\`\`\`

Um bom teste rápido: peça ao agente "resuma meus três e-mails não lidos mais recentes". Ele vai rodar \`inbox_list\`, depois \`email_read\` com \`action: "list"\` e \`unread: true\`, e então \`email_read\` com \`action: "read"\` em cada um. Se isso funcionar, sua conexão está ativa.

Uma ressalva que vale deixar clara desde o início: um agente dentro de um chat reage a e-mails novos verificando em um intervalo definido, em vez de ser avisado. Esse é o modelo certo para a maioria dos fluxos de trabalho, e é assim que os padrões de [triagem e resumo da caixa de entrada](/blog/ai-agent-triage-summarize-inbox) funcionam. Se o seu próprio código precisa de um aviso, os espaços de trabalho Pro e Business podem adicionar em Chaves de API um webhook que faz um POST para a sua URL quando chega e-mail novo.

## Por que é seguro fazer isso rápido

A velocidade aqui não vem de cortar caminho na segurança. O e-mail é buscado ao vivo em cada chamada e nunca é armazenado: corpos, assuntos e anexos são entregues ao agente e descartados na hora. A única coisa mantida por caixa de entrada é o seu token OAuth ou senha de app, criptografado em repouso com AES-256-GCM e descriptografado nos nossos servidores apenas quando uma requisição precisa. Ele nunca é enviado ao seu agente. O envio sempre passa pelo seu próprio provedor, então a reputação do seu domínio continua sendo sua. Se quiser a arquitetura em detalhes, leia [por que "o e-mail nunca é armazenado" importa de verdade](/blog/why-email-never-stored-matters).

## Resumindo

É isso: uma conexão de caixa de entrada, um endpoint, um punhado de ferramentas. O plano Free conecta uma caixa de entrada e não pede cartão; os planos pagos adicionam mais. Veja os [preços](/pricing). Quer testar? [Comece grátis](/signup), conecte sua caixa de entrada e cole o endpoint no seu agente.`,
};

export default translation;
