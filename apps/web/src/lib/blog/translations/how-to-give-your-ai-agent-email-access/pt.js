const translation = {
  title: 'Como dar ao seu agente de IA acesso ao e-mail (o guia completo de 2026)',
  description:
    'Dê ao seu agente de IA acesso de leitura e envio a uma caixa de entrada real via MCP: Gmail, Outlook, iCloud, Fastmail ou IMAP. Como funciona, as ferramentas, a segurança e a configuração.',
  coverAlt: 'Como dar ao seu agente de IA acesso ao e-mail via MCP, com o MCPEmails',
  content: `Para dar a um agente de IA acesso ao e-mail, você conecta sua caixa de entrada a um servidor MCP e aponta o agente para uma única URL de endpoint. O agente então recebe um pequeno conjunto de ferramentas para ler, pesquisar e enviar e-mails. A parte difícil não é o agente: é fazer isso sem vazar sua senha em um prompt, em um log ou em um banco vetorial. Essa última milha é o assunto deste guia.

Se você só quer o caminho rápido: conecte uma caixa no painel, cole o endpoint MCP no [claude.ai](https://claude.ai), no Claude Desktop, no Cursor ou no seu próprio agente, e chame \`inbox_list\` primeiro. O resto deste texto explica o que está acontecendo de fato, por que o modelo de segurança importa e como conectar cada provedor compatível.

## O que "e-mail via MCP" significa na prática

O [Model Context Protocol](https://modelcontextprotocol.io) é uma forma padronizada de expor ferramentas a um modelo de linguagem por HTTP. Um servidor MCP de e-mail apresenta sua caixa não como IMAP bruto, mas como um punhado de verbos tipados que o agente pode chamar: listar mensagens, ler uma, pesquisar, enviar, responder. O agente raciocina sobre esses verbos. Ele nunca toca o protocolo da caixa por baixo, e nunca vê suas credenciais.

Essa é toda a ideia por trás do [MCPEmails](/). Um endpoint, um conjunto de ferramentas, qualquer cliente compatível com MCP. Se você quer a explicação da arquitetura desde o começo, o texto complementar [o que é um servidor MCP de e-mail](/blog/what-is-an-mcp-email-server) cobre isso em linguagem simples.

## Por que a última milha é difícil

Ligar um modelo ao e-mail parece trivial até você tentar de verdade. Três coisas mordem:

1. **A autenticação é diferente em cada provedor.** Outlook e Microsoft 365 querem OAuth pela identidade da Microsoft. O Gmail quer uma senha de app do Google, que o Google só deixa criar com a verificação em duas etapas ativada. iCloud e Fastmail querem uma senha específica de app. Cada um tem o próprio ciclo de renovação de token e os próprios modos de falha.
2. **Credenciais são radioativas.** Uma senha de caixa de correio parada em uma transcrição de chat ou em uma linha de log é um vazamento esperando para acontecer. Você não pode deixar o modelo guardar o segredo.
3. **O e-mail tem um formato ruim para agentes.** MIME, cabeçalhos de encadeamento, HTML contra texto simples, anexos, pastas que na verdade são marcadores. O modelo precisa de uma resposta limpa, não da RFC 5322.

A solução caseira ingênua, entregar ao modelo uma biblioteca IMAP e a sua senha, falha nas três ao mesmo tempo. A maioria dos repositórios de "servidor MCP para Gmail" no GitHub para bem aí.

## Como o MCPEmails resolve isso

Quatro decisões de projeto fazem o trabalho pesado. São o motivo de eu confiar isso à minha própria caixa.

### O e-mail é buscado ao vivo e nunca armazenado

Cada chamada de ferramenta chega ao seu provedor em tempo real: IMAP/SMTP para Gmail, iCloud, Fastmail e os demais, ou Microsoft Graph para o Outlook. Corpos, assuntos e anexos são entregues ao agente e descartados na hora. Nada é colocado em cache, indexado ou arquivado. A única coisa persistida por caixa é a credencial necessária para a próxima chamada. Se você quer a versão longa de por que isso importa, leia [por que "o e-mail nunca é armazenado" importa](/blog/why-email-never-stored-matters).

### As credenciais são criptografadas com AES-256-GCM em repouso

A senha de app ou o token OAuth de cada caixa é criptografado antes de ser gravado no banco de dados. É descriptografado nos nossos servidores só quando uma solicitação precisa, e nunca é enviado ao seu agente. A chave de criptografia é mantida como segredo do servidor, separada do banco de dados. Então até um vazamento do banco entrega a um atacante texto cifrado, não a sua caixa.

### O envio passa pelo seu próprio provedor

Quando o agente envia ou responde, o e-mail sai pelo seu Gmail, pelo seu Microsoft 365 ou pelo seu servidor SMTP. O MCPEmails nunca retransmite a partir do próprio domínio. Sua entregabilidade e a reputação do seu domínio continuam inteiramente suas, sem roleta de pasta de spam por IP compartilhado.

### É MCP padrão sobre HTTP

O servidor fala Streamable HTTP conforme a especificação MCP 2025-06-18. Nenhum SDK para instalar, nenhum cliente customizado. Ele se encaixa em qualquer coisa que fale MCP.

## As ferramentas que seu agente recebe

Um punhado de ferramentas consolidadas, baseadas em ações, cobre toda a superfície: ler, redigir, organizar, mais outras para pastas, agendamento e contatos. O agente sempre começa com \`inbox_list\` para descobrir o que está conectado e pegar o ID de cada caixa; ele nunca fixa um UUID no código.

- \`inbox_list\`: descobre as contas conectadas e suas capacidades
- \`email_read\` (ação \`list\`): paginado, do mais recente para o mais antigo, por caixa
- \`email_read\` (ação \`read\`): texto simples processado, HTML sanitizado opcional, anexos opcionais
- \`email_read\` (ação \`search\`): sintaxe nativa do provedor (operadores do Gmail, KQL do Outlook, busca textual do IMAP)
- \`email_compose\` (ação \`send\`): redige com CC/CCO, HTML e anexos de até 10 MB no total
- \`email_compose\` (ação \`reply\`): o mesmo, e define os cabeçalhos de encadeamento (In-Reply-To, References) por você
- \`email_organize\`: mover, excluir, sinalizar ou arquivar (uma ação por chamada)

Uma coisa que vale saber logo de cara: as ferramentas em si funcionam por **requisição e resposta**. O servidor responde quando o agente pergunta, e o jeito mais simples de reagir a e-mails novos é consultar em uma rotina, por exemplo \`email_read\` (ação \`list\`) com \`unread: true\`. Se você prefere ser avisado, os espaços de trabalho Pro e Business podem adicionar um webhook em **Chaves de API** no painel: o MCPEmails então faz um POST assinado para a sua URL quando chega e-mail novo, com os IDs das mensagens, que o agente abre com \`email_read\`. O [guia para construir uma resposta automática](/blog/build-email-auto-responder-mcp-agent) mostra os dois padrões.

Uma rodada de triagem matinal fica assim:

\`\`\`json
{
  "step1": "inbox_list                  → encontra o Gmail do trabalho",
  "step2": "email_read (action list)    → últimas 24 h, unread: true",
  "step3": "email_read (action read)    → corpo completo do que for urgente",
  "step4": "email_compose (action reply) → rascunha, ou só resume e espera"
}
\`\`\`

Nenhuma senha cruzou a rede. O agente teve capacidades, não credenciais. Para mais ideias, veja [7 coisas que um agente de IA pode fazer com acesso à caixa de entrada](/blog/7-things-ai-agent-can-do-with-inbox-access) e o [passo a passo aprofundado de triagem e resumo](/blog/ai-agent-triage-summarize-inbox).

## Provedores compatíveis e como cada um conecta

Você conecta uma caixa uma vez em **Painel → Caixas de entrada → Conectar caixa de entrada**. Como você se autentica depende do provedor.

### Provedores com OAuth (login, sem senha)

- **Outlook / Microsoft 365**: OAuth 2.0 via Entrar com a Microsoft, pelo Microsoft Graph em vez de IMAP. Contas pessoais do Outlook.com, Hotmail, Live e MSN conectam na hora. Contas corporativas ou de estudante do Microsoft 365 podem exigir que um administrador de TI aprove o app uma vez para toda a organização antes; o painel fornece um link para você enviar a ele. Detalhes de configuração em [conectar o Outlook e o Microsoft 365 a um agente de IA](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

### Provedores com senha de app

Gmail, iCloud, Fastmail, Yahoo, Zoho, Yandex e qualquer caixa IMAP genérica (inclusive e-mail de empresa na UOL Host, Locaweb, KingHost ou Hostinger) conectam com uma senha específica de app em vez de OAuth. Você gera a senha nas configurações de segurança do provedor e cola no MCPEmails. As senhas de app do Gmail vêm da sua Conta do Google, e o Google exige a verificação em duas etapas antes de criar uma. As senhas do iCloud vêm de account.apple.com; o Fastmail é **somente senha de app** (crie uma nas configurações do Fastmail). Todos usam o mesmo transporte IMAP/SMTP e compartilham um conjunto idêntico de recursos. O passo a passo completo está em [conectar iCloud, Fastmail ou qualquer caixa IMAP ao Claude](/blog/connect-icloud-fastmail-imap-to-claude).

## Conectando seu cliente de IA

Mesmo endpoint, mesmas ferramentas, dois caminhos de entrada, dependendo de o seu cliente falar OAuth ou não.

### Clientes com OAuth (sem chave de API)

claude.ai, Claude Desktop, Cursor e clientes parecidos conectam com OAuth 2.0 Authorization Code + PKCE e registro dinâmico de cliente (RFC 7591). No claude.ai, é **Personalizar → Conectores → Adicionar conector**, colar a URL do endpoint MCP, clicar em Conectar, entrar na sua conta do MCPEmails e aprovar. Os tokens ficam limitados exatamente ao que você aprova na tela de consentimento: **Somente leitura**, **Padrão**, **Acesso total** ou um conjunto **Personalizado** de permissões individuais. Para passo a passo detalhado, veja [configurar o Claude com sua caixa de entrada](/blog/connect-claude-to-email) e [adicionar seu e-mail ao ChatGPT](/blog/connect-chatgpt-to-email).

### Clientes sem OAuth (chave de API)

Cline, JetBrains, scripts próprios e cURL puro usam uma chave de API com escopo limitado. Crie uma em **Painel → Chaves de API**, escolha os escopos e copie (ela aparece uma única vez). Envie como \`Authorization: Bearer <chave-de-api>\`. A configuração completa desses clientes está em [e-mail para agentes de IA no Cursor, Cline e VS Code](/blog/email-for-ai-agents-cursor-cline-vscode), e a comparação entre as duas abordagens está em [OAuth ou chaves de API para acesso de IA ao e-mail](/blog/oauth-vs-api-keys-ai-email-access).

De qualquer forma, você revoga qualquer conexão no painel com um clique. Pegue a URL exata do endpoint na [documentação](/docs); copie de lá em vez de digitar à mão.

## Isso é seguro? E os limites de taxa

Sim, e o texto [é seguro dar a um agente de IA acesso ao e-mail?](/blog/is-it-safe-to-give-ai-agent-email-access) apresenta o argumento completo. O modelo guarda capacidades com escopo, não a sua senha; as credenciais são criptografadas; nada é armazenado; o envio fica no seu provedor; o acesso é revogado com um clique.

Sobre limites de taxa, cada espaço de trabalho tem um teto por minuto que cresce com o plano (veja [preços](/pricing)), e cada chave de API recebe janelas por minuto, por hora e por dia dimensionadas para esse plano, então uma chave pode usar o teto inteiro e várias chaves o compartilham. Quando você atinge um limite, o servidor devolve um erro que admite nova tentativa, com um valor \`retry_after\` em segundos. Respeite-o. E nunca repita às cegas um envio de \`email_compose\`: você vai mandar duplicados.

## Preços

Os planos são precificados por caixas conectadas. As chaves de API são ilimitadas em todos os níveis, e os níveis também diferem em limite de pico, histórico de análises, recursos de equipe e suporte.

- **Free.** Sem cartão, para sempre. Uma caixa conectada, análises de uso, central de ajuda e suporte por e-mail.
- **Personal.** Mais caixas para uma pessoa, limite de pico maior, histórico de análises mais longo, suporte prioritário por e-mail.
- **Pro.** Para uma pessoa que toca um negócio: ainda mais caixas, limite de pico maior ainda, anos de histórico de análises e webhooks de e-mail novo.
- **Business.** Tudo do Pro, mais um conjunto de caixas incluídas e um valor por caixa extra, membros ilimitados com papéis, administradores que aprovam envios retidos e um espaço de trabalho separado por cliente ou empresa.

Os preços e o número de caixas atuais estão na [página de preços](/pricing).

## Comece agora

Conecte uma caixa, cole o endpoint no seu agente e chame \`inbox_list\`. Essa é toda a integração. [Comece grátis](/signup) ou passe pelo [guia rápido](/docs#quickstart): em alguns minutos você terá um agente lendo e-mails de verdade.`,
};

export default translation;
