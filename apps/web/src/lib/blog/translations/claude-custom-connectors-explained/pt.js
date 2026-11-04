const translation = {
  title: 'Conectores personalizados do Claude: planos, configuração, OAuth e segurança',
  description:
    'O que são os conectores personalizados do Claude, quais planos e apps têm suporte, como adicionar um servidor MCP remoto pela URL, opções de login, controles de administrador e dicas de segurança.',
  coverAlt: 'Conectores personalizados do Claude: um servidor MCP remoto adicionado ao Claude pela URL',
  content: `Os **conectores personalizados do Claude** permitem adicionar qualquer servidor remoto do [Model Context Protocol](https://modelcontextprotocol.io) ao Claude colando a URL dele. Depois de adicionar um, o Claude pode chamar as ferramentas desse servidor nos seus chats: consultar um banco de dados, abrir um chamado ou, no exemplo prático no fim deste guia, ler e enviar seus e-mails.

Os detalhes de planos e menus abaixo vêm das páginas de ajuda da própria Anthropic, conferidas em 26 de outubro de 2026. A interface do Claude muda com frequência; se algum rótulo estiver diferente, a referência é o [guia de conectores personalizados da Anthropic](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## O que é um conector personalizado do Claude?

Um conector personalizado do Claude é um servidor MCP remoto que você adiciona ao Claude pela URL, em vez de escolher no Connectors Directory (diretório de conectores). O servidor roda na internet, oferece um conjunto de ferramentas e normalmente pede que você faça login com OAuth. O Claude então chama essas ferramentas em seu nome, dentro das permissões que você aprovou.

Vale saber três coisas logo de início:

- **A Anthropic não verifica conectores personalizados.** Os itens do diretório trazem os selos Verified ou Community. Um conector adicionado pela URL liga o Claude a um serviço que a Anthropic não revisou, então você está confiando em quem opera o servidor.
- **A conexão parte da nuvem da Anthropic, não do seu computador.** A Anthropic diz que isso vale em todos os clientes do Claude, incluindo claude.ai, Claude Desktop, Cowork e os apps para celular. O servidor precisa estar acessível pela internet pública. Um servidor em rede privada ou atrás de uma VPN não conecta, a menos que o firewall libere as faixas de IP da Anthropic ou que ele seja acessado pelo que a Anthropic chama de MCP tunnel.
- **Você adiciona uma vez por conta, não uma vez por dispositivo.**

Se MCP ainda é novidade para você, [o que é um servidor MCP de e-mail](/blog/what-is-an-mcp-email-server) explica o protocolo usando o e-mail como exemplo.

## Como os conectores personalizados diferem dos conectores do diretório e das extensões de desktop

O Claude tem três formas de alcançar uma ferramenta externa:

- **Conectores do diretório** aparecem no Connectors Directory do Claude. Você navega por eles em **Personalizar → Conectores** e clica em **Conectar**. Os conectores do Gmail e do Microsoft 365 no Claude fazem parte desse grupo.
- **Conectores personalizados** são servidores MCP remotos adicionados pela URL. São o assunto deste guia.
- **Extensões de desktop** são servidores MCP locais empacotados como arquivos \`.mcpb\` e instalados em **Settings → Extensions** (Configurações → Extensões) no app Claude para desktop. Elas rodam no seu próprio computador. Servidores locais configurados em \`claude_desktop_config.json\` são mais um mecanismo separado e não ficam disponíveis no claude.ai nem no Cowork.

O Claude Code adiciona o mesmo tipo de servidor remoto pelo terminal; a [página de configuração do Claude Code](/docs/claude-code) mostra o comando para o MCPEmails. Para ver como um servidor MCP genérico e um conector nativo de um único provedor se comportam de forma diferente, veja [conectores nativos e MCP comparados](/native-connectors-vs-mcp).

## Quais planos e apps do Claude têm conectores personalizados

Segundo a central de ajuda da Anthropic, em outubro de 2026:

- **Planos:** os conectores personalizados estão disponíveis nos planos Free, Pro, Max, Team e Enterprise. O plano Free é limitado a um conector personalizado; Pro e Max não têm limite.
- **Apps em que você os adiciona:** claude.ai na web, Claude Desktop e Cowork.
- **Celular:** um conector que você conecta na web ou no Claude Desktop fica disponível no Claude para iOS e Android na próxima vez que você entrar por lá. A Anthropic descreve a instalação de conectores no celular como beta e diz que a web e o app para desktop são o caminho principal para conectores personalizados, então configure primeiro em um computador.
- **Quem pode adicionar em um plano empresarial:** nos planos Team, só Owners e Primary Owners. Nos planos Enterprise, Owners, Primary Owners e pessoas com uma função personalizada que inclua gerenciar as bibliotecas da organização.

## Como adicionar um conector personalizado no Free, Pro ou Max

1. Abra **Personalizar → Conectores** no claude.ai ou no Claude Desktop.
2. Clique em **+ Adicionar** e depois em **Adicionar conector personalizado**.
3. Informe um nome e a URL do servidor e clique em **Continuar**.
4. Revise as configurações de login que o Claude detectou. Os padrões costumam estar certos, e a próxima seção explica as opções.
5. Clique em **Adicionar** e depois faça login no serviço.

Não é possível alterar as configurações de autenticação de um conector depois de adicioná-lo. Para mudar, remova o conector e adicione de novo. Para remover, abra **Personalizar → Conectores** e use **Remove** (Remover) ou o menu de três pontos ao lado dele.

## Como as organizações adicionam conectores personalizados no Team e no Enterprise

Nos planos Team e Enterprise, adicionar um conector e conectar-se a ele são duas etapas separadas:

1. **Um Owner adiciona para a organização.** Abra **Configurações da organização → Conectores**, clique em **Adicionar**, escolha **Custom** (Personalizado) e depois **Web**, se o Claude pedir um tipo. Informe o nome e a URL e conclua as mesmas telas de autenticação.
2. **Cada membro conecta com a própria conta.** Os membros abrem **Personalizar → Conectores**, encontram o conector, que normalmente traz o selo **Custom**, e clicam em **Conectar**.

Como cada pessoa faz login individualmente, o Claude alcança apenas o que aquela pessoa alcança no serviço conectado. A exceção é um conector configurado com uma credencial compartilhada, como uma chave de API: todos que o usam recebem o acesso daquela credencial.

Os Owners também podem limitar o que um conector pode fazer em toda a organização. Cada ferramenta pode ficar como **Sempre permitir**, **Precisa de aprovação** ou **Bloqueado**, e os usuários não podem passar por cima da configuração da organização. O próprio exemplo da Anthropic é parecido com o caso de e-mail abaixo: deixar o Claude pesquisar e resumir e-mails, mas impedir que envie mensagens.

Membros que não podem adicionar um conector precisam que um Owner faça isso. O botão **Request** (Solicitar) que o Claude oferece vale para itens do diretório; para uma URL personalizada, envie a URL diretamente ao seu Owner.

## Opções de login: OAuth, registro automático ou sem login

O Claude mostra até três grupos de configurações quando você adiciona um conector. Os valores detectados costumam estar certos.

**Authentication** (Autenticação) define quando as pessoas fazem login:

- **Sign in now** (Fazer login agora): cada usuário passa pelo login OAuth do servidor antes de usar o conector. É a escolha certa para um servidor que guarda dados pessoais.
- **Sign in when needed** (Fazer login quando necessário): o Claude conecta sem credenciais e pede que os usuários façam login quando o servidor exigir.
- **No sign-in** (Sem login): qualquer pessoa com a URL pode usar o conector. Isso também cobre servidores que esperam uma chave de API fixa, que você adiciona como cabeçalho de requisição.

**OAuth client** (Cliente OAuth) define como o Claude se identifica para o sistema de login do servidor. Fica oculto quando você escolhe No sign-in:

- **Use Claude's published identity** (Usar a identidade publicada do Claude) é a recomendação da Anthropic. O servidor lê os dados do Claude em um Client ID Metadata Document hospedado pela Anthropic, então não é preciso configurar nada, desde que o servidor aceite esse método.
- **Register automatically** (Registrar automaticamente) usa o OAuth Dynamic Client Registration, que a maioria dos servidores MCP aceita.
- **Use your own OAuth client** (Usar seu próprio cliente OAuth) serve para um client ID que você mesmo registrou no servidor.

**Request headers** (Cabeçalhos de requisição) guardam credenciais fixas, como uma chave de API ou um bearer token. O Claude os armazena com segurança, não os mostra de novo depois que você salva e os envia em toda requisição, até quatro cabeçalhos por conector. A Anthropic marca os cabeçalhos de requisição como um beta disponível para um grupo limitado de organizações, então essa seção pode não aparecer para você.

A diferença na prática: com OAuth, cada pessoa faz login como ela mesma, aprova permissões específicas e pode revogar o acesso sem que ninguém compartilhe um segredo. Com uma chave fixa, uma única credencial dá o mesmo acesso a todos que usam o conector. [OAuth ou chaves de API para acesso de IA ao e-mail](/blog/oauth-vs-api-keys-ai-email-access) aprofunda essa escolha.

## Como ativar um conector em um chat

Adicionar um conector não faz todos os chats usarem esse conector. Em uma conversa, clique no botão **+** no canto inferior esquerdo, abra **Conectores** e ative ou desative cada conector naquele chat. O Claude também pode sugerir sozinho um app conectado quando ele fizer sentido para o pedido.

Para controlar ferramentas individuais, abra **Personalizar → Conectores**, selecione o conector e defina cada ferramenta, ou cada grupo de ferramentas de leitura e de escrita, como **Sempre permitir**, **Precisa de aprovação** ou **Bloqueado**. Quando o Claude pedir para rodar uma ferramenta, escolha **Allow always** (Permitir sempre) só para servidores e ferramentas em que você confia para rodar sem supervisão.

## Checklist de segurança antes de conectar

As orientações da Anthropic se resumem a cinco pontos:

- **Conecte apenas servidores operados por organizações em que você confia.** O servidor decide o que as ferramentas dele fazem e pode mudar isso depois.
- **Leia as permissões na tela de login.** Conceda o conjunto mais restrito que resolve a tarefa e negue o que parecer desnecessário.
- **Trate a saída das ferramentas como não confiável.** Uma página web, um chamado ou um e-mail pode conter texto escrito para manipular o Claude. A Anthropic diz que o Claude tem proteções nativas contra prompt injection, mas você ainda deve acompanhar o que entra e o que sai.
- **Bloqueie ou condicione as ações de escrita de que você não precisa.** Enviar, excluir e mover são os pontos em que os erros ficam visíveis para outras pessoas.
- **Cuidado com o Research.** A Anthropic observa que o Research pode chamar ferramentas de conectores automaticamente, sem perguntar a cada vez, então desative as ferramentas de escrita antes de usá-lo com um conector.

## Exemplo prático: e-mail no Claude com o MCPEmails

O e-mail põe tudo isso à prova: uma caixa de correio guarda dados privados, e enviar é uma ação real. O MCPEmails é um servidor MCP hospedado que conecta Gmail, Outlook e Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex e outras caixas IMAP, e as apresenta ao Claude como um único conector personalizado.

**1. Conecte uma caixa ao MCPEmails.** [Crie uma conta](/signup) e abra **Painel → Caixas de entrada → Conectar caixa de entrada**. Outlook e Microsoft 365 usam Entrar com a Microsoft, a maioria dos outros provedores usa uma senha específica de app, e as [páginas de provedores](/connect) listam as configurações de cada um. A [página de configuração do Claude](/docs/claude) tem a versão curta dos passos 1 e 2.

**2. Adicione o conector no Claude.** Em **Personalizar → Conectores**, clique em **+ Adicionar** e depois em **Adicionar conector personalizado**, dê o nome MCPEmails, informe a URL abaixo e clique em **Continuar**:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

**3. Escolha as configurações de login.** Escolha **Sign in now**. Para o cliente OAuth, qualquer uma das duas primeiras opções funciona: o MCPEmails aceita a identidade publicada do Claude e o registro automático. Deixe os cabeçalhos de requisição vazios, já que o OAuth não precisa de chave de API.

**4. Faça login e escolha o acesso.** Clique em **Adicionar**, entre no MCPEmails e aprove as permissões na tela de consentimento. O Claude pede primeiro só \`read:email\`, e a tela abre na opção somente leitura correspondente. Adicione \`send:email\`, \`manage:drafts\`, \`manage:folders\` ou \`delete:email\` só quando um fluxo de trabalho precisar. Um token sem \`send:email\` não consegue enviar, não importa o que peçam ao Claude. Se um pedido posterior precisar de uma permissão que você não concedeu, o MCPEmails responde com um erro \`insufficient_scope\` que indica o escopo que falta. Ao reconectar, marque essa permissão na tela de consentimento. A [página de acesso somente leitura](/docs/read-only-access) mostra exatamente o que uma concessão somente leitura pode e não pode fazer.

**5. Defina as permissões das ferramentas no Claude.** O MCPEmails separa leitura e escrita em ferramentas diferentes. \`email_read\`, \`inbox_list\`, \`folder_list\` e \`draft_list\` só leem, enquanto \`email_compose\` envia, responde e encaminha, e \`email_delete\` exclui. Essa divisão permite deixar \`email_compose\` em **Precisa de aprovação** e \`email_delete\` em **Bloqueado**, enquanto a leitura fica em **Sempre permitir**. A [referência de ferramentas](/docs#tools) lista todas.

**6. Comece com uma tarefa somente leitura.** Ative o conector em um chat novo e peça ao Claude para listar suas caixas de entrada e resumir seus cinco e-mails não lidos mais recentes, sem enviar, mover nem excluir nada. Há mais prompts para começar no [guia para conectar o Claude ao e-mail](/blog/connect-claude-to-email).

Um conector cobre todas as caixas que você conectar, e é assim que [várias contas de e-mail acabam no mesmo chat do Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt). Para ver quais caixas os conectores nativos do Claude alcançam sem isso, leia [o Claude pode ler meus e-mails?](/blog/can-claude-read-my-email)

Em uma equipe, o Owner adiciona a mesma URL uma vez em **Configurações da organização → Conectores**, e cada membro clica em **Conectar** e entra com a própria conta do MCPEmails. Cada pessoa vê apenas as caixas que a própria conta alcança. Para que os e-mails de saída esperem por uma pessoa, independentemente do que o Claude decidir, o proprietário de uma caixa pode ativar a aprovação de envio no painel do MCPEmails: todo envio, resposta, encaminhamento, envio de rascunho e envio agendado fica retido até alguém aprovar, e uma solicitação sem decisão expira em 24 horas. [Aprovar envios de e-mail de agentes de IA](/blog/approve-ai-agent-email-sends) mostra essa configuração.

Quanto aos dados, o MCPEmails busca os e-mails ao vivo no seu provedor a cada solicitação e não armazena o conteúdo das mensagens. Guarda apenas o token OAuth ou a senha de app criptografados de que precisa para acessar a caixa. Resultados que contêm texto da caixa são marcados como conteúdo não confiável, então o Claude é avisado de que um e-mail pedindo para encaminhar ou excluir algo é um dado a relatar, não uma instrução. A [visão geral de segurança](/security) e [é seguro dar a um agente de IA acesso ao e-mail?](/blog/is-it-safe-to-give-ai-agent-email-access) tratam do modelo de ameaças.

## Solução de problemas com conectores personalizados

- **Não existe o botão Adicionar conector personalizado.** Nos planos Team e Enterprise, os membros não podem adicionar conectores personalizados. Peça a um Owner para adicionar a URL em **Configurações da organização → Conectores**.
- **Não dá para adicionar um segundo conector no Free.** O plano Free permite um conector personalizado. Remova o que você não usa mais ou mude para um plano pago do Claude.
- **A conexão expira ou falha.** O Claude conecta a partir da nuvem da Anthropic, então o servidor precisa estar acessível pela internet pública. A URL hospedada do MCPEmails está. Um servidor que você mesmo roda, como a [versão auto-hospedada](/self-hosting), precisa de um endereço HTTPS público ou de um firewall que libere as faixas de IP da Anthropic. A versão auto-hospedada faz login com uma chave de API em vez de OAuth, então o Claude só consegue usá-la onde a seção Request headers estiver disponível.
- **Você escolheu as configurações de login erradas.** As configurações de autenticação não podem ser editadas. Remova o conector e adicione de novo; depois os membros reconectam.
- **O conector está conectado, mas o Claude não o usa.** Abra **+ → Connectors** naquele chat e confira se a chave dele está ativada e se a ferramenta de que você precisa não está em **Bloqueado**.
- **Ele não aparece no celular.** Conecte primeiro na web ou no Claude Desktop e depois entre de novo no app para celular.
- **Uma ação de e-mail é negada.** Falta um escopo no token. Reconecte o conector e aprove o escopo de que essa ação precisa, ou revogue a concessão antiga no painel do MCPEmails em **Chaves de API**, onde a conexão do Claude aparece como \`OAuth:\` seguido do nome do cliente. A [página de configuração do Claude](/docs/claude) lista as demais correções específicas do Claude.

## Perguntas frequentes

**O que são os conectores personalizados do Claude?**
São servidores MCP remotos que você adiciona ao Claude pela URL. O Claude chama as ferramentas do servidor nos seus chats depois que você faz login e aprova as permissões. Estão disponíveis nos planos Free, Pro, Max, Team e Enterprise, e o plano Free permite um.

**Os conectores personalizados funcionam no Claude Desktop e no celular?**
Sim. Você os adiciona no claude.ai, no Claude Desktop ou no Cowork, e um conector conectado ali fica disponível nos apps para iOS e Android na próxima vez que você entrar.

**Quem pode adicionar um conector personalizado em um plano Team ou Enterprise?**
No Team, Owners e Primary Owners. No Enterprise, também pessoas com uma função personalizada que inclua gerenciar as bibliotecas da organização. Depois, os membros conectam individualmente.

**Um conector personalizado é seguro?**
Ele é tão seguro quanto o servidor por trás dele e as permissões que você concede. A Anthropic não verifica conectores personalizados, então conecte apenas servidores em que você confia, aprove as permissões mais restritas e condicione ou bloqueie as ações de escrita.

**Preciso de uma chave de API para usar o MCPEmails como conector personalizado do Claude?**
Não. O Claude faz login no MCPEmails com OAuth. As chaves de API servem para clientes MCP sem fluxo OAuth, como scripts.

## Próximo passo

[Crie uma conta grátis no MCPEmails](/signup), conecte uma caixa e adicione \`https://mcpemails.com/api/mcp\` como conector personalizado no Claude. Se sua caixa usa IMAP e não tem uma predefinição com nome, o [guia do conector IMAP para o Claude](/blog/claude-imap-connector) explica as configurações do servidor.`,
};

export default translation;
