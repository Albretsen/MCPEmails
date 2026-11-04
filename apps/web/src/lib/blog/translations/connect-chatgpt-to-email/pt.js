const translation = {
  title: 'Como conectar o ChatGPT ao seu e-mail: Yahoo, iCloud, Outlook, IMAP',
  description:
    'Passo a passo: conecte Gmail, Outlook, iCloud, Fastmail ou qualquer caixa de entrada IMAP ao ChatGPT com um conector MCP personalizado, e ao OpenAI Codex com uma chave de escopo limitado. Nenhum e-mail armazenado.',
  coverAlt:
    'Conectar o ChatGPT e o OpenAI Codex ao Gmail, Outlook, iCloud, Fastmail e e-mail IMAP com o MCPEmails',
  content: `O ChatGPT não consegue acessar uma caixa de correio sozinho. Ele precisa de um servidor MCP na frente do seu e-mail, e o MCPEmails é esse servidor: você conecta uma caixa de entrada uma vez, aponta o ChatGPT para uma única URL, e ele ganha as mesmas ferramentas de e-mail, esteja o e-mail no Gmail, Outlook ou Microsoft 365, iCloud, Fastmail, Yahoo, Zoho ou em um servidor IMAP próprio.

Duas superfícies da OpenAI estão envolvidas, e elas autenticam de formas diferentes. O ChatGPT executa um fluxo OAuth no navegador, então não há chave de API para colar. O OpenAI Codex roda no seu terminal e usa uma chave bearer de escopo limitado. Mesmo endpoint, mesmas ferramentas.

**Vá direto a:** [Configuração no ChatGPT](#passo-2-adicionar-o-conector-no-chatgpt) · [OpenAI Codex](#openai-codex-no-terminal) · [Solução de problemas](#solução-de-problemas)

## O que você precisa

- **ChatGPT Go ou um plano pago, na web.** A OpenAI permite que os planos Go e pagos adicionem servidores MCP personalizados no chatgpt.com. Não é possível adicionar um pelo aplicativo de celular. Nos planos Business e Enterprise, pode ser necessário que um administrador ou proprietário adicione o servidor para o espaço de trabalho.
- **Uma conta gratuita no MCPEmails.** [Crie a sua aqui](/signup). O plano gratuito comporta uma caixa de entrada conectada e não pede cartão.
- **Uma caixa de correio.** Gmail, Outlook ou Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex ou qualquer serviço que fale IMAP e SMTP.

Se o seu plano do ChatGPT não permite adicionar um servidor MCP personalizado, a mesma caixa de entrada e a mesma URL já funcionam no [Claude](/docs/claude), no [Cursor](/docs/cursor), no [VS Code](/docs/vscode) e nos outros [clientes compatíveis](/docs/clients).

## Passo 1: conectar sua caixa de entrada ao MCPEmails

No painel do MCPEmails, abra **Caixas de entrada**, depois **Conectar caixa de entrada**, e escolha seu provedor.

### Gmail e Google Workspace

O Gmail conecta com uma senha de app do Google via IMAP. Ative a verificação em duas etapas, crie a senha de app em myaccount.google.com/apppasswords e cole as 16 letras junto com seu endereço completo do Gmail; sua senha normal do Google não funciona. Um administrador do Google Workspace pode desativar as senhas de app no domínio, então fale com ele se a opção não aparecer. O [passo a passo do Gmail](/blog/connect-gmail-to-claude) traz as etapas.

### iCloud, Fastmail, Yahoo e Zoho

Esses provedores pedem uma senha específica de app, não a senha que você digita na web. Crie uma no provedor, escolha o provedor no MCPEmails e cole a senha. O [guia de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) traz as etapas exatas.

### Outlook e Microsoft 365

O Outlook conecta com Entrar com a Microsoft, não com senha de app: escolha **Outlook**, clique em **Conectar com a Microsoft** e aprove. Contas pessoais do Outlook.com, Hotmail, Live e MSN conectam na hora. Contas corporativas ou de estudante do Microsoft 365 podem exigir que um administrador de TI aprove o app uma vez para toda a organização antes; o painel fornece um link para você enviar a ele. O [guia de Outlook e Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) traz os detalhes.

### Qualquer outra caixa de correio IMAP

Escolha **IMAP** e informe o endereço e a senha de app. As configurações mais comuns são detectadas automaticamente; um domínio personalizado pode precisar do host, da porta e do modo de segurança informados pelo seu provedor. A [matriz de provedores](/docs/providers) lista o que cada um oferece, e há uma página por provedor em [connect](/connect), incluindo [Gmail](/connect/gmail), [Outlook](/connect/outlook), [Microsoft 365](/connect/office365), [iCloud](/connect/icloud) e [IMAP genérico](/connect/imap).

Conecte mais de uma caixa de correio se o seu plano permitir. O ChatGPT as descobre com \`inbox_list\`, então você nunca cola um id de caixa de correio em um prompt.

## Passo 2: adicionar o conector no ChatGPT

1. No chatgpt.com, abra **Plugins**, depois **Personal** (Pessoal), e clique em **Add** (Adicionar) no canto superior direito.
2. Escolha **Add custom MCP server** (Adicionar servidor MCP personalizado) e dê o nome MCPEmails.
3. Em **Connection** (Conexão), cole esta URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Escolha **OAuth**, marque **I understand and want to continue** (Entendo e quero continuar) e clique em **Create as a plugin** (Criar como plugin).
5. Faça login com o MCPEmails e aprove.
6. Em um chat, digite **@** e escolha MCPEmails. A escolha vale para aquela mensagem, então mencione o MCPEmails com @ de novo quando uma pergunta seguinte precisar do seu e-mail.

Escolha OAuth, não "sem autenticação". Este servidor recusa chamadas anônimas, então um conector criado sem autenticação parece bem na configuração e falha na primeira chamada de ferramenta, que é o jeito mais confuso de descobrir. Com OAuth, o ChatGPT se registra sozinho e completa um fluxo de código de autorização com PKCE: nenhum client id para criar, nenhum client secret em lugar nenhum. A OpenAI muda esses menus de lugar de tempos em tempos, então confira a [página de configuração do ChatGPT](/docs/chatgpt) para o caminho atual.

## Passo 3: aprovar só os escopos de que você precisa

A tela de consentimento é nossa, não da OpenAI. O primeiro consentimento começa em \`read:email\`, que basta para triagem, resumos e buscas, e deixa toda ação irreversível fora de alcance enquanto você decide até onde ir. Os outros escopos são \`send:email\`, \`search:email\` e \`manage:automations\`.

Conceder pouco demais tem conserto: uma chamada que precisa de um escopo que seu token não tem volta como 403 com um erro de escopo insuficiente, então o cliente pode pedir consentimento para esse escopo e tentar de novo. O dono de uma caixa de entrada também pode exigir [aprovação humana](/blog/approve-ai-agent-email-sends) no painel, o que segura todo envio, resposta, encaminhamento, envio de rascunho e envio agendado até que uma pessoa libere.

## Passo 4: dar ao ChatGPT uma primeira tarefa segura

Comece em modo somente leitura:

> Resuma meus três e-mails não lidos mais recentes e sinalize qualquer coisa que precise de resposta hoje. Não envie, mova nem exclua nada.

O ChatGPT encontra a caixa de entrada primeiro e depois lê só as mensagens de que precisa. Quando isso funcionar, experimente:

- "Encontre a fatura da Stripe do mês passado e me diga o valor."
- "Escreva um rascunho de resposta à última mensagem do Alex, mas deixe como rascunho."
- "Mostre as newsletters desta semana que eu poderia arquivar e aguarde minha confirmação."

Para rotinas repetíveis, comece pelo [playbook de triagem da caixa de entrada](/blog/ai-agent-triage-summarize-inbox) ou pela [coleção de prompts de fluxo de trabalho](/blog/ai-agent-email-workflows-and-prompts).

## O que o ChatGPT consegue fazer depois de conectado

O MCPEmails entrega ao ChatGPT ferramentas específicas, em vez de uma senha ou de um socket IMAP bruto:

- **Ler e pesquisar:** \`email_read\` cobre list, read, read_batch, search e attachment. A pesquisa usa campos estruturados como remetente, assunto, data e status de não lido, e os marcadores do Gmail aparecem como pastas.
- **Enviar, responder e encaminhar:** \`email_compose\` envia pelo seu próprio provedor e endereço.
- **Organizar:** \`email_organize\`, \`email_search_and_move\` e \`email_delete\`.
- **Rascunhos, pastas e agendamento:** \`draft\`, \`draft_list\`, \`folder\`, \`folder_list\`, \`schedule\` e \`schedule_list\`.
- **O restante:** \`contact_search\`, \`signature_get\`, \`signature_set\`, mais \`automation\` e \`automation_read\` para regras recorrentes.

Um limite para levar em conta: o MCPEmails funciona por consulta. Não há webhooks nem eventos iniciados pelo servidor, então o ChatGPT verifica se há e-mails novos quando você pede, e não no momento em que uma mensagem chega.

## OpenAI Codex no terminal

O Codex é uma superfície diferente dos conectores do ChatGPT, e o fluxo OAuth no navegador não é o caminho ali. Um cliente de terminal autentica com um token bearer:

1. No painel, abra **Chaves de API** e crie uma chave, marcando apenas os escopos de que esse agente precisa.
2. Copie a chave na hora. Ela começa com \`mcpe_\` seguido de 64 caracteres hexadecimais e é mostrada uma única vez.
3. Registre \`https://mcpemails.com/api/mcp\` como um servidor MCP de HTTP streamable na configuração de MCP do próprio Codex, passando a chave em um cabeçalho \`Authorization: Bearer\`.

Conexões por chave e por OAuth chegam ao mesmo endpoint e veem o mesmo catálogo de ferramentas. A única diferença é de onde o token veio. Para testar o endpoint antes, o [guia de HTTP bruto](/docs/curl) tem uma chamada \`tools/list\` de uma linha, e [OAuth ou chaves de API](/blog/oauth-vs-api-keys-ai-email-access) explica quando cada caminho faz sentido.

Limite bem o escopo da chave. Somente leitura costuma ser o certo para um agente de código: um que consegue resumir uma conversa de suporte é útil, um que consegue enviar e-mails sem supervisão está em outra categoria de risco.

## Solução de problemas

- **Não aparece a opção de adicionar um servidor MCP personalizado.** Servidores MCP personalizados são adicionados no chatgpt.com em um navegador, não no aplicativo de celular, e exigem o plano Go ou um plano pago. Em um espaço de trabalho Business ou Enterprise, pode ser necessário que um administrador ou proprietário adicione.
- **O conector falha na primeira chamada de ferramenta.** Provavelmente foi criado sem autenticação. Exclua e crie de novo com OAuth.
- **O conector foi criado, mas o ChatGPT responde sem tocar no seu e-mail.** O MCPEmails não foi escolhido para aquela mensagem. Digite **@**, escolha MCPEmails e pergunte de novo.
- **O provedor rejeita sua senha.** Use uma senha de app gerada pelo provedor, não a senha de login da web. Alguns provedores só emitem uma depois que a autenticação de dois fatores está ativada.
- **Uma conexão IMAP personalizada expira por tempo.** Confirme o host, a porta e o modo TLS. A porta 993 normalmente usa TLS implícito; a porta 143 normalmente usa STARTTLS.
- **O ChatGPT conecta, mas não vê e-mails.** Confira se a caixa de entrada está ativa no painel, confirme que a conexão tem \`read:email\` e peça ao ChatGPT para chamar \`inbox_list\` primeiro.

## Perguntas frequentes

**O ChatGPT consegue ler e enviar meus e-mails?**
Por um conector MCP personalizado, sim: ler, pesquisar, enviar, responder, encaminhar, organizar e agendar, tudo limitado aos escopos que você aprova na configuração.

**Preciso de uma chave de API para o ChatGPT?**
Não. Escolha OAuth e o ChatGPT se registra sozinho e completa o fluxo. As chaves de API são para clientes que não conseguem executar um fluxo no navegador, como o Codex e scripts.

**O Codex é configurado do mesmo jeito?**
Não. O Codex é uma superfície de terminal, então usa uma chave de API de escopo limitado em um cabeçalho \`Authorization: Bearer\` em vez do fluxo OAuth no navegador. Mesmo endpoint, mesmas ferramentas.

**Meu e-mail fica armazenado nos seus servidores?**
Não. Cada mensagem é buscada ao vivo no seu provedor para a solicitação que a pediu e depois descartada. Só a credencial criptografada do provedor fica guardada. [Por que nunca armazenar e-mail importa](/blog/why-email-never-stored-matters) explica o raciocínio.

**Quanto custa?**
O Free cobre uma caixa de entrada conectada e 150 ações de e-mail faturáveis por mês-calendário UTC, com os 3 primeiros dias sem contagem. Essa franquia mensal vale para espaços de trabalho criados em ou após 2026-09-13; espaços de trabalho criados antes estão isentos. Os planos pagos adicionam caixas de entrada e ações de e-mail ilimitadas: veja os [preços](/pricing).

## Próximo passo

[Comece grátis](/signup), conecte uma caixa de entrada, adicione \`https://mcpemails.com/api/mcp\` ao ChatGPT e peça para ele resumir seus e-mails não lidos. A [página de configuração do ChatGPT](/docs/chatgpt) tem o caminho de cliques atual; a [documentação](/docs) tem a referência completa das ferramentas.`,
};

export default translation;
