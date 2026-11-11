const translation = {
  title: 'Como conectar o Claude a qualquer e-mail: iCloud, Apple Mail, Yahoo, IMAP',
  description:
    'Conecte o Claude ao iCloud, Yahoo, Outlook ou a qualquer caixa de entrada IMAP via MCP, inclusive contas que você lê no Apple Mail. Dois minutos, sem código, nada armazenado.',
  coverAlt:
    'Conectar o Claude ao Gmail, Outlook, iCloud, Fastmail, Yahoo, Zoho e e-mail IMAP com o MCPEmails',
  content: `O Claude consegue ler, pesquisar, organizar e enviar seus e-mails, mas precisa de um servidor MCP para chegar a uma caixa de entrada de verdade. O MCPEmails é essa ponte: você conecta uma caixa de entrada uma vez, adiciona um endpoint seguro ao Claude, e o Claude ganha o mesmo conjunto de ferramentas de e-mail para Gmail, Outlook e Microsoft 365, iCloud, Fastmail, Yahoo, Zoho e outros provedores IMAP.

Não há código para escrever, nenhum SDK para instalar e nenhuma chave de API quando você conecta pelo fluxo OAuth do Claude. O e-mail é buscado ao vivo no seu provedor a cada solicitação e não é armazenado pelo MCPEmails.

**Vá direto ao seu provedor:** [Gmail](#gmail-e-google-workspace) · [iCloud](#icloud-mail) · [Apple Mail](#apple-mail) · [Fastmail](#fastmail) · [Outlook](#outlook-e-microsoft-365) · [Yahoo, Zoho, Yandex ou IMAP personalizado](#yahoo-zoho-yandex-e-imap-personalizado)

## O que você precisa

- **Claude** na web (claude.ai) ou no Claude Desktop. Todos os planos do Claude podem adicionar conectores personalizados: o Free permite um, o Pro e o Max não têm limite.
- Uma conta gratuita no **MCPEmails**: [crie a sua aqui](/signup).
- Uma caixa de entrada de e-mail. O Outlook conecta com Entrar com a Microsoft. Gmail, iCloud, Fastmail, Yahoo, Zoho e a maioria dos outros provedores usam uma senha de app.

## Passo 1: conectar sua caixa de entrada ao MCPEmails

No painel do MCPEmails, abra **Caixas de entrada → Conectar caixa de entrada** e escolha seu provedor.

### Gmail e Google Workspace

Escolha **Gmail**, crie uma senha de app do Google em myaccount.google.com/apppasswords (o Google só oferece essa opção com a verificação em duas etapas ativada) e cole as 16 letras junto com seu endereço completo do Gmail. Sua senha normal do Google não funciona aqui, e você pode revogar a senha de app quando quiser. Siga o [passo a passo específico do Gmail](/blog/connect-gmail-to-claude) se um administrador do Workspace tiver desativado as senhas de app no seu domínio. Veja [configurações e limites do Gmail](/connect/gmail) e a [página de configuração do Google Workspace](/connect/google-workspace).

### iCloud Mail

Crie uma senha específica de app na sua Conta Apple, escolha **iCloud** e informe essa senha, não a senha normal da sua Conta Apple. O [passo a passo de iCloud e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) traz as etapas exatas no provedor. Veja também [Conectar o iCloud Mail ao Claude](/connect/icloud).

### Apple Mail

O Apple Mail é um aplicativo de e-mail, então o Claude se conecta à conta por trás dele, e não ao aplicativo. Um endereço do iCloud conecta como descrito acima. Uma conta do Gmail, Outlook, Yahoo ou do trabalho conecta pelo próprio provedor. Pastas guardadas apenas em "No Meu Mac" não estão em nenhum servidor, por isso o Claude não consegue vê-las. Nada precisa ficar rodando no seu Mac.

### Fastmail

Crie uma senha de app com acesso a Mail no Fastmail, escolha **Fastmail** e cole a senha no MCPEmails. Guarde a senha gerada até o teste de conexão passar. Veja [configurações do Fastmail para o Claude](/connect/fastmail).

### Outlook e Microsoft 365

O Outlook conecta com Entrar com a Microsoft, não com senha de app: escolha **Outlook**, clique em **Conectar com a Microsoft** e aprove. Contas pessoais do Outlook.com, Hotmail, Live e MSN conectam na hora. Contas corporativas ou de estudante do Microsoft 365 podem exigir que um administrador de TI aprove o app uma vez para toda a organização antes; o painel fornece um link para você enviar a ele. O [guia de Outlook e Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) traz os detalhes. Veja a [página de configuração do Outlook](/connect/outlook) ou a [página de configuração do Microsoft 365](/connect/office365).

### Yahoo, Zoho, Yandex e IMAP personalizado

Crie uma senha de app, escolha **IMAP** e informe o endereço e a senha. As configurações mais comuns são detectadas automaticamente; domínios personalizados podem precisar do host IMAP/SMTP, da porta e do modo de segurança informados pelo provedor. As configurações de cada um estão nas páginas de [Yahoo Mail](/connect/yahoo), [Zoho Mail](/connect/zoho), [Yandex Mail](/connect/yandex) e [IMAP personalizado](/connect/imap). Você também pode ver [todos os provedores compatíveis](/connect).

Você pode conectar mais de uma caixa de entrada. O Claude as descobre com \`inbox_list\`, então você não precisa colar IDs de caixa de correio em um prompt.

Precisa de ajuda provedor por provedor? Veja o [guia de configuração de dois minutos para vários provedores](/blog/connect-email-to-ai-agent-under-2-minutes), o [guia dedicado ao Gmail](/blog/connect-gmail-to-claude) ou o [guia de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude).

## Passo 2: adicionar o MCPEmails ao Claude

No claude.ai ou no Claude Desktop:

1. Abra **Personalizar → Conectores**.
2. Clique em **+ Adicionar** e depois em **Adicionar conector personalizado**.
3. Dê o nome MCPEmails e cole esta URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Clique em **Continuar**, confira as configurações de login que o Claude detectou (os padrões servem) e clique em **Adicionar**.
5. Faça login no MCPEmails e aprove o nível de acesso que você quer: **Somente leitura**, **Padrão**, **Acesso total** ou um conjunto personalizado de permissões.
6. Em um chat, clique em **+** no canto inferior esquerdo, escolha **Conectores** e ative o MCPEmails.

No plano Team ou Enterprise, um Owner adiciona o conector uma vez em **Configurações da organização → Conectores**. Os membros então abrem **Personalizar → Conectores**, localizam o MCPEmails e clicam em **Conectar**.

Essa é toda a configuração no Claude. O OAuth limita a conexão aos escopos que você aprova, e você pode revogá-la no MCPEmails quando quiser. Se você usa um cliente sem suporte a OAuth, use uma chave de API com escopos limitados; [OAuth ou chaves de API](/blog/oauth-vs-api-keys-ai-email-access) explica esse caminho. Para problemas específicos do Claude, veja a [página de configuração do Claude](/docs/claude).

## Passo 3: dar ao Claude uma primeira tarefa segura

Comece com uma solicitação somente leitura:

> Resuma meus três e-mails não lidos mais recentes e sinalize qualquer coisa que precise de resposta hoje.

O Claude primeiro encontra a caixa de entrada conectada, depois lista e lê as mensagens relevantes. Quando isso funcionar, experimente:

- "Encontre a fatura da Stripe do mês passado e me diga o valor."
- "Escreva um rascunho de resposta à última mensagem do Alex, mas não envie."
- "Mostre as newsletters desta semana que eu posso arquivar."
- "O que eu combinei na minha conversa com a Acme?"

Para rotinas repetíveis, use o [playbook de triagem da caixa de entrada](/blog/ai-agent-triage-summarize-inbox) ou as [formas de deixar o Claude gerenciar sua caixa de entrada](/blog/best-ways-to-let-claude-manage-your-inbox).

## O que o Claude consegue fazer depois de conectado

O MCPEmails dá ao Claude ferramentas de e-mail específicas, em vez de uma senha ou de uma conexão IMAP bruta:

- **Ler e pesquisar:** \`email_read\` lista mensagens, lê mensagens completas e pesquisa e-mails por remetente, assunto, data, status de não lido e outros campos estruturados. No Gmail, os marcadores aparecem como pastas.
- **Enviar, responder e encaminhar:** \`email_compose\` envia pelo seu próprio provedor e endereço.
- **Organizar:** \`email_organize\` move, marca, sinaliza e arquiva mensagens.
- **Trabalhar com rascunhos, pastas, agendamentos e contatos:** \`draft\`, \`folder\`, \`schedule\` e \`contact_search\` cobrem o restante de um fluxo de e-mail prático.

O MCPEmails funciona por consulta: o Claude verifica se há e-mails novos quando você pede, em vez de receber um evento push no instante em que um e-mail chega.

## Solução de problemas de conexão e de configuração do Claude

- **O provedor rejeita a senha:** use uma senha de app gerada pelo provedor, não a senha que você usa para entrar na web. Gere uma nova depois de ativar a autenticação de dois fatores, se for exigido.
- **Uma conexão IMAP personalizada expira por tempo:** confirme o host IMAP/SMTP, a porta e o modo TLS do provedor. A porta 993 normalmente usa TLS implícito; a porta 143 normalmente usa STARTTLS.
- **O Claude conecta, mas não vê os e-mails:** primeiro confira se a caixa de entrada está ativa no MCPEmails, depois reconecte o Claude e aprove **read:email**. Peça ao Claude para chamar **inbox_list** antes de ler mensagens.
- **O Claude lê, mas não envia:** reconecte com **send:email** e confira se a conexão com o provedor oferece SMTP ou envio nativo do provedor.

Ainda travado? Use a [matriz de provedores](/docs/providers) para conferir os recursos, depois [abra o guia de configuração](/docs#quickstart) e teste uma solicitação somente leitura antes de ativar o envio.

## É seguro conectar o Claude ao e-mail?

Sim, desde que você dê à conexão apenas o acesso de que ela precisa e mantenha uma pessoa envolvida nas ações de saída.

- **O e-mail não é armazenado.** O MCPEmails busca o conteúdo da mensagem ao vivo a cada chamada e o descarta depois da entrega. A credencial criptografada necessária para reconectar ao seu provedor é o único dado da caixa de entrada que fica guardado.
- **Seu provedor continua no controle da autenticação.** O Outlook usa OAuth, então o MCPEmails nunca vê sua senha da Microsoft. No Gmail e em outros provedores com senha de app, a senha de app é uma credencial separada, não a senha da sua conta, e você pode revogá-la quando quiser.
- **Os escopos são explícitos.** Conceda acesso somente leitura se o Claude nunca deve enviar. Adicione o acesso de envio só quando precisar, e revogue qualquer um dos dois caminhos de acesso a qualquer momento.

Trate o corpo de todo e-mail como entrada não confiável. Peça ao Claude para criar um rascunho antes de enviar, revise mensagens para destinatários externos e não deixe instruções dentro de um e-mail passarem por cima da sua intenção. O [guia de segurança para acesso a e-mail](/blog/is-it-safe-to-give-ai-agent-email-access) explica o modelo de ameaças em mais detalhe.

## Perguntas frequentes

**O Claude consegue se conectar ao Gmail, Outlook ou iCloud?**
O Gmail conecta com uma senha de app do Google, o Outlook conecta com Entrar com a Microsoft e o iCloud conecta com uma senha específica de app. Uma conta corporativa ou de estudante do Microsoft 365 pode exigir que um administrador de TI aprove o app uma vez antes. O MCPEmails também oferece suporte ao Fastmail e a IMAP genérico, o que cobre serviços como Yahoo e Zoho.

**Preciso de uma chave de API?**
Não, não para o fluxo de conector OAuth do Claude. Cole a URL do endpoint e faça login. As chaves de API são para clientes MCP que não têm OAuth integrado.

**O Claude consegue enviar e-mail?**
Sim, se você conceder \`send:email\`. Comece com acesso somente leitura ou peça ao Claude para rascunhar as respostas primeiro se quiser uma etapa de revisão.

**O MCPEmails armazena minha caixa de entrada?**
Não. As mensagens são lidas ao vivo no seu provedor e descartadas. O MCPEmails guarda apenas a credencial de conexão criptografada necessária para fazer essas solicitações ao vivo.

## Próximo passo

[Comece grátis](/signup), conecte sua caixa de entrada, adicione \`https://mcpemails.com/api/mcp\` ao Claude e peça para ele resumir seus e-mails não lidos. Para a referência completa das ferramentas MCP e os recursos por provedor, acesse a [documentação](/docs).`,
};

export default translation;
