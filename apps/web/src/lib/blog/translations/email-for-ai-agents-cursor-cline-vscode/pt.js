const translation = {
  title: 'Como configurar e-mail para agentes de IA no Cursor, Cline e VS Code',
  description: 'Dê ao seu agente de programação acesso ao e-mail no Cursor, Cline e VS Code. O Cursor usa OAuth; o Cline e clientes personalizados usam uma chave de API com escopo via MCP. Configuração completa.',
  coverAlt: 'Configuração de acesso ao e-mail para agentes de IA de programação no Cursor, Cline e VS Code via MCP',
  content: `Vamos à versão curta. Para dar a um agente de programação no seu editor acesso a uma caixa de entrada real, aponte-o para um único endpoint MCP: \`https://www.mcpemails.com/api/mcp\`. O Cursor fala OAuth, então você cola essa URL e faz login. O Cline, a configuração MCP direta do VS Code e qualquer script personalizado não fazem o fluxo OAuth, então se autenticam com uma chave de API com escopo enviada em um cabeçalho \`Authorization: Bearer\`. Mesmo endpoint, mesmas ferramentas, duas formas de entrar.

Este guia cobre os dois caminhos, mostra como gerar uma chave de API com escopo exatamente \`read:email\` e \`send:email\`, e termina com um fluxo de desenvolvimento que eu realmente uso: o agente faz a triagem da minha caixa de entrada e envia respostas sem eu sair do editor. Se você quer ver o panorama geral primeiro, o guia principal sobre [como dar ao seu agente de IA acesso ao e-mail](/blog/how-to-give-your-ai-agent-email-access) é o ponto de partida.

## Antes de configurar qualquer cliente: conecte uma caixa de entrada

O servidor MCP não é dono dos seus e-mails. Ele intermedeia uma conexão ao vivo com o provedor que você já usa, busca as mensagens na hora da chamada e as descarta. Nada dos seus e-mails fica armazenado. Por isso, o primeiro passo acontece no painel, não no editor.

Vá em **Painel → Caixas de entrada → Conectar caixa de entrada** e escolha um provedor:

- **Gmail** → uma senha de app do Google via IMAP. Ative a verificação em duas etapas, crie uma em myaccount.google.com/apppasswords e cole as 16 letras junto com seu endereço completo do Gmail. Um administrador do Google Workspace pode desativar as senhas de app para o domínio.
- **Outlook / Microsoft 365** → OAuth com Entrar com a Microsoft, sem senha de app. Contas pessoais do Outlook.com, Hotmail, Live e MSN conectam na hora. Uma conta corporativa ou educacional do Microsoft 365 pode precisar que um administrador de TI aprove o app uma vez para toda a organização antes; o painel oferece um link para você enviar a ele.
- **iCloud, Fastmail, Yahoo, Zoho ou qualquer servidor IMAP genérico** → uma senha específica de app. Gere-a nas configurações do provedor (no iCloud, em appleid.apple.com) e cole.

O Fastmail funciona só com senha de app, não com OAuth, então não procure por lá uma tela de consentimento no estilo do Google. Se você usa iCloud ou Fastmail, o [passo a passo de configuração de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) traz os detalhes de cada provedor. No Outlook, veja [como conectar o Outlook e o Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Depois que uma caixa está conectada, o agente chega até ela pelas ferramentas. Você nunca cola um UUID nem uma senha na configuração do editor.

## Cursor: cole a URL, faça login, pronto

O Cursor aceita OAuth 2.0 para servidores MCP, que é o caminho sem dor. Não há chave de API nem segredo para gerenciar em um arquivo de configuração.

1. Abra as configurações do Cursor e encontre a seção de servidores MCP.
2. Adicione um novo servidor com a URL \`https://www.mcpemails.com/api/mcp\`.
3. O Cursor abre uma janela do navegador. Entre na sua conta do MCPEmails e aprove o nível de acesso que o agente deve ter: **Somente leitura**, **Padrão**, **Acesso total** ou um conjunto personalizado de permissões.
4. A conexão fica verde e as ferramentas de e-mail aparecem na lista de ferramentas do Cursor.

Por baixo dos panos, isso é OAuth 2.0 com authorization code e PKCE, e o token que o Cursor guarda tem escopo exatamente igual ao que você aprovou. Se você concedeu só \`read:email\`, o agente literalmente não consegue enviar. Quando terminar, revogue a conexão em **Painel → Chaves de API** (as concessões OAuth também ficam ali) com um clique, e o acesso do Cursor acaba na hora.

O Claude Desktop e o claude.ai seguem o mesmo fluxo de colar e aprovar, se você também os usa.

## Cline, VS Code direto e scripts personalizados: use uma chave de API

O Cline, a configuração \`mcp\` pura do VS Code, o JetBrains e qualquer coisa que você mesmo programe não implementam o handshake OAuth. Para esses, você cria uma chave de API e a envia como bearer token. Essa também é a escolha certa para jobs de CI e automações via cron, em que não há uma pessoa para clicar em uma tela de aprovação.

### Passo 1: crie uma chave de API com escopo

Em **Painel → Chaves de API**, clique em **Criar chave**. Dê um nome que você vá reconhecer depois (\`cline-laptop\`, \`triage-cron\`) e escolha os escopos:

- \`read:email\` para listar, pesquisar e ler.
- \`send:email\` para enviar e responder.

Conceda só o que o cliente precisa. Um assistente de triagem somente leitura não tem por que ter \`send:email\`. A chave aparece uma única vez: copie assim que ela surgir, porque não dá para vê-la de novo. Se perder, você gera outra; não há como recuperar.

### Passo 2: coloque a chave na configuração do cliente

No Cline (e na maioria das configurações MCP do VS Code), adicione o servidor ao JSON de configuração MCP com o cabeçalho bearer:

\`\`\`json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

Uma chamada cURL direta para confirmar que a chave funciona antes de mexer em qualquer editor:

\`\`\`bash
curl -s https://www.mcpemails.com/api/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

Se voltar uma lista de ferramentas, você está conectado. Um erro \`-32001\` significa que a chave é inválida, e um \`-32004\` (HTTP 403) significa que falta a ela um escopo de que a ferramenta precisa. Nenhum dos dois adianta repetir, então corrija a chave em vez de ficar tentando em loop. Não faça commit da chave. Leia-a de uma variável de ambiente e mantenha-a fora do git. Se você está decidindo qual modelo de autenticação usar em cada lugar, [OAuth ou chaves de API para acesso de IA ao e-mail](/blog/oauth-vs-api-keys-ai-email-access) mostra os prós e contras.

## As ferramentas que o seu agente recebe

Os dois caminhos expõem a mesma superfície. Algumas ferramentas consolidadas, baseadas em ações, dão conta do trabalho:

- \`inbox_list\`: sempre chame esta primeiro para descobrir as caixas conectadas e os IDs delas.
- \`email_read\` (ação \`list\`): paginada, das mais novas para as mais antigas.
- \`email_read\` (ação \`read\`): texto simples já processado, HTML sanitizado opcional, anexos.
- \`email_read\` (ação \`search\`): pesquisa por remetente, assunto, data, status de não lida e outros campos estruturados, traduzida para a pesquisa própria de cada provedor.
- \`email_compose\` (ação \`send\`): escreve com CC/CCO, HTML e anexos de até 10 MB.
- \`email_compose\` (ação \`reply\`): define os cabeçalhos In-Reply-To e References para você, para que a conversa continue intacta.

Há outras para sinalizações e movimentações (\`email_organize\`), pastas, envio agendado e contatos, mas essas poucas fazem a maior parte do trabalho real.

## Um fluxo de desenvolvimento que vale a pena

É aqui que compensa. Eu deixo uma chave de leitura e envio configurada no editor e conto com o agente nas partes do dia que eu perderia para a caixa de entrada.

Triagem da manhã, digitada direto no painel de chat:

> Chame inbox_list e depois liste os não lidos da minha caixa de trabalho nas últimas 12 horas. Agrupe em: precisa de resposta, para conhecimento e ruído. Para o grupo "para conhecimento", me dê uma linha para cada.

O agente roda \`inbox_list\`, depois \`email_read\` com a ação \`list\` e \`unread\` definido, lê os que importam e devolve um resumo organizado. Quando vejo um que quero responder, continuo:

> Responda à mensagem do designer terceirizado confirmando que quinta às 14h funciona, de forma curta.

Ele chama \`email_compose\` com a ação \`reply\`, a conversa é mantida, e a resposta sai pelo meu próprio Gmail, então chega a partir do meu endereço, com a reputação do meu domínio. Para ver prompts de triagem em mais detalhes, leia [como fazer um agente de IA triar e resumir sua caixa de entrada](/blog/ai-agent-triage-summarize-inbox).

Uma limitação: as ferramentas MCP só respondem a chamadas, nunca iniciam uma. Se você quer que o agente reaja a mensagens que chegam, faça polling, chamando \`email_read\` com a ação \`list\` e \`unread: true\` em um intervalo definido, ou deixe um webhook de e-mail novo acordar o seu código (os espaços de trabalho Pro e Business adicionam um em Chaves de API no painel, e ele envia os IDs das mensagens para a sua URL). De um jeito ou de outro, isso molda a forma como você constrói qualquer coisa reativa, como uma [resposta automática via MCP](/blog/build-email-auto-responder-mcp-agent).

## Limites de taxa para acesso por script

Se você usa o servidor a partir de um cron job ou de um loop de agente apertado, fique de olho nos limites. Cada plano tem um teto por minuto para o espaço de trabalho inteiro, e cada chave de API tem janelas por minuto, por hora e por dia dimensionadas para o plano, então uma chave pode usar todo o teto por minuto do plano e várias chaves o dividem. Respostas bem-sucedidas de \`tools/call\` trazem \`RateLimit-Limit\`, \`RateLimit-Remaining\` e \`RateLimit-Reset\`, e uma resposta 429 traz \`Retry-After\`. Veja a [página de preços](/pricing) para o teto de cada plano.

Quando você atinge um limite de taxa, o servidor devolve um erro que pode ser repetido (código \`-32003\`) com \`data.retry_after\` em segundos. Respeite: espere esse tempo e tente de novo. Mas nem tudo pode ser repetido: se um espaço de trabalho atingir um limite de uso do plano, a chamada devolve um resultado de ferramenta normal com \`isError: true\` e um bloco \`_meta["com.mcpemails/usage_limit"]\`, sem \`retry_after\`, e nenhuma quantidade de novas tentativas resolve antes de \`reset_at\`. E nunca repita às cegas um envio com \`email_compose\` após uma falha genérica; você vai disparar duplicatas. Verifique primeiro se ele foi mesmo enviado.

## Para fechar

O Cursor conecta você com uma URL e um login. Todo o resto usa uma chave com escopo e um cabeçalho bearer. Os dois acessam o mesmo endpoint e as mesmas ferramentas, e os dois mantêm suas credenciais fora do repositório e fora do contexto do modelo. Usa o ChatGPT ou o Codex fora do editor? O [guia de configuração de e-mail no ChatGPT](/blog/connect-chatgpt-to-email) cobre os dois.

[Comece grátis](/signup) e conecte sua primeira caixa de entrada, ou leia a [documentação](/docs) para ver a referência completa das ferramentas.`,
};

export default translation;
