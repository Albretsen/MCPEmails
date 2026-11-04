const translation = {
  title: 'Várias contas de e-mail no Claude Cowork, inclusive o Outlook pessoal',
  description:
    'O Claude Cowork alcança uma conta Google pelo conector do Gmail, e o conector do Microsoft 365 recusa endereços pessoais do Outlook. Veja como dar a uma tarefa do Cowork várias caixas de entrada, de trabalho e pessoais.',
  coverAlt:
    'Contas de e-mail de trabalho e pessoais, incluindo Gmail e Outlook.com, conectadas a uma tarefa do Claude Cowork',
  content: `**O Claude Cowork usa os mesmos conectores do chat do Claude, então tem os mesmos limites de e-mail: uma conta Google pelo conector do Gmail, e só contas corporativas do Microsoft 365 pelo conector do Microsoft 365.** Um endereço pessoal do Outlook.com ou do Hotmail, um segundo Gmail ou uma caixa da empresa em um servidor IMAP precisam de um conector personalizado. Com um servidor MCP como o MCPEmails, um único conector personalizado dá a uma tarefa do Cowork todas as caixas que você conectar, cada uma pelo nome.

**Ir para:** [Conectores nativos](#o-que-os-conectores-de-e-mail-nativos-do-cowork-alcançam) · [Várias caixas](#várias-caixas-de-entrada-em-uma-tarefa-do-cowork) · [Configuração](#como-configurar) · [Permissões](#mantenha-os-envios-sob-seu-controle) · [Perguntas frequentes](#perguntas-frequentes)

## O que os conectores de e-mail nativos do Cowork alcançam

O [guia do Cowork da Anthropic](https://support.claude.com/en/articles/13345190-get-started-with-cowork) gerencia os conectores na mesma página **Personalizar → Conectores** do chat, e o chat e o Cowork agora dividem o mesmo espaço no app Claude. O que a sua conta do Claude tiver conectado é o que uma tarefa do Cowork pode usar.

- **Gmail.** O conector do Gmail no Claude lê, pesquisa, escreve rascunhos e envia. O [artigo da Anthropic](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) descreve o acesso à "conta Google que você conectou" e não diz nada sobre adicionar uma segunda. Um Gmail pessoal e um de trabalho não ficam lado a lado por ele.
- **Microsoft 365.** O [conector do Microsoft 365](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) é para contas no tenant Microsoft 365 de uma empresa. Um Administrador Global precisa dar consentimento primeiro, ele começa como somente leitura, e contas pessoais da Microsoft, como @outlook.com e @hotmail.com, não conseguem conectar.
- **Todo o resto.** Yahoo, iCloud, Fastmail, Zoho, IONOS ou o seu próprio servidor de e-mail não têm conector nativo no Claude.

Ou seja, a combinação mais comum, uma caixa de trabalho mais um Outlook.com pessoal ou um segundo Gmail, não cabe no Cowork só com os conectores nativos.

## Várias caixas de entrada em uma tarefa do Cowork

Os [conectores personalizados](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) são servidores MCP remotos, e a Anthropic os lista como disponíveis no Claude, no Cowork e no Claude Desktop. O Claude chega até eles a partir da nuvem da Anthropic, o que tem uma consequência para o Cowork: um servidor MCP local que você configurou em \`claude_desktop_config.json\` não fica disponível ali. O servidor precisa estar acessível pela internet.

O MCPEmails é um servidor MCP hospedado, então isso já está resolvido. Você conecta cada caixa a ele uma vez, adiciona uma URL ao Claude, e todas as caixas ficam nas suas tarefas do Cowork:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Qualquer combinação de provedores.** [Gmail e Google Workspace](/connect/gmail) com uma senha de app do Google, [Outlook.com, Hotmail e Live pessoais](/connect/outlook) e [Microsoft 365 corporativo](/connect/office365) com Entrar com a Microsoft, [iCloud](/connect/icloud), [Yahoo](/connect/yahoo), [Fastmail](/connect/fastmail), [Zoho](/connect/zoho) e qualquer caixa que use [IMAP e SMTP](/connect/imap).
- **Cada caixa pelo nome.** A tarefa chama \`inbox_list\` e vê cada endereço conectado com o nome de exibição, então "confira o contato@ e meu Outlook" não exige nenhuma configuração extra.
- **Respostas do endereço certo.** Cada caixa envia pelo próprio provedor, com o próprio nome de remetente e a própria assinatura.
- **Nada armazenado.** Os e-mails são buscados ao vivo no seu provedor a cada solicitação e não ficam guardados nos nossos servidores.

Um endereço pessoal do Outlook.com conecta com Entrar com a Microsoft e não precisa de administrador. Uma conta corporativa do Microsoft 365 pode precisar que o administrador de TI aprove o MCPEmails uma vez para a organização; [aprovação de administrador no Microsoft 365](/docs/microsoft-365-admin-consent) explica o que ele aprova e traz o link para enviar a ele.

## Como configurar

1. **Conecte suas caixas.** [Crie uma conta grátis no MCPEmails](/signup) e abra **Caixas de entrada** e depois **Conectar caixa de entrada**, uma vez por caixa. Dê a cada uma um nome de exibição claro, como "Outlook pessoal" ou "Vendas Acme": é isso que o Claude lê para diferenciá-las.
2. **Adicione o conector ao Claude.** Abra **Personalizar → Conectores**, clique em **+ Adicionar** e depois em **Adicionar conector personalizado**. Dê o nome MCPEmails, informe \`https://mcpemails.com/api/mcp\`, clique em **Continuar**, mantenha as configurações de login detectadas e clique em **Adicionar**. No Team e no Enterprise, um Owner adiciona, e os membros clicam em **Conectar**.
3. **Faça login e escolha o acesso.** **Somente leitura** para tarefas que só leem, **Padrão** para incluir rascunhos e envio, ou **Acesso total** para incluir agendamento, pastas e exclusão.
4. **Ative no Cowork.** Em uma tarefa, abra o menu **+** e ative o MCPEmails nos conectores.

O [guia de configuração do Claude](/blog/connect-claude-to-email) mostra cada tela, e [conectores personalizados do Claude explicados](/blog/claude-custom-connectors-explained) mostra o que um conector personalizado pode e não pode fazer.

O Cowork em si está nos planos Pro, Max, Team e Enterprise do Claude. O plano Free do MCPEmails conecta uma caixa; várias caixas exigem um plano pago, listado na [página de preços](/pricing).

## Mantenha os envios sob seu controle

Uma tarefa do Cowork percorre muitos passos sozinha, então decida antes o que ela pode fazer sem perguntar.

- **No Claude.** O guia do Cowork da Anthropic permite definir cada ferramenta de conector como **Sempre permitir**, **Precisa de aprovação** ou **Bloqueado**. Colocar as ferramentas de envio do MCPEmails em **Precisa de aprovação** faz o Claude parar antes de cada envio. No Team e no Enterprise, sua organização pode exigir aprovação para ferramentas de escrita de qualquer forma.
- **No MCPEmails.** Ative **Revisar antes de enviar** para uma caixa e escolha como: **Perguntar no chat primeiro** faz o Claude mostrar o e-mail e esperar seu sim, e **Aprovar no mcpemails.com** retém cada envio até que um proprietário ou administrador do espaço de trabalho aprove, com login feito, algo que o Claude não consegue fazer por você. Veja [aprovação humana para envios de e-mail por IA](/blog/approve-ai-agent-email-sends).
- **Rascunho primeiro.** Quando você pede um e-mail, o MCPEmails orienta o Claude a salvá-lo como rascunho naquela caixa, onde você pode ler e editar antes de qualquer envio.

E-mails são escritos por outras pessoas, e alguns são escritos para manipular uma IA. Uma tarefa que lê e-mails e também pode enviar deve ter uma dessas verificações ativada.

## Prompts para várias caixas

> Usando o MCPEmails, passe pela minha caixa de trabalho e pelo meu Outlook pessoal e liste tudo dos últimos dois dias que precisa de resposta minha. Uma lista só, com cada linha indicando a caixa. Não envie nem mova nada.

> Usando o MCPEmails, encontre a confirmação do voo da semana que vem. Pesquise em todas as caixas conectadas e me diga em qual ela está.

> Usando o MCPEmails, escreva uma resposta a partir de vendas@ para a consulta mais recente e salve como rascunho. Não envie.

Para receber o mesmo resumo toda manhã sem precisar pedir, coloque o primeiro prompt em um horário agendado: [resumo diário de e-mails com Claude e ChatGPT](/blog/daily-email-briefing-with-claude-and-chatgpt) explica as tarefas agendadas do Claude. [Várias contas de e-mail no Claude e no ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) mostra a mesma configuração no chat do Claude e no ChatGPT.

## Perguntas frequentes

**O Claude Cowork pode usar duas contas do Gmail?**
Não pelo conector nativo do Gmail no Claude, que a Anthropic descreve como alcançando a única conta Google que você conectou. Conecte as duas contas ao MCPEmails com senhas de app do Google e adicione o MCPEmails como conector personalizado; uma tarefa do Cowork passa a ver as duas.

**O Cowork consegue ler meu e-mail pessoal do Outlook.com ou do Hotmail?**
Não com o conector do Microsoft 365 no Claude, que recusa contas pessoais da Microsoft. Conecte o endereço ao MCPEmails com Entrar com a Microsoft e depois adicione o MCPEmails ao Claude. [Conectar o Claude ao Outlook.com e ao Hotmail](/blog/connect-claude-to-outlook-com-hotmail) traz o passo a passo.

**Conectores personalizados funcionam no Cowork?**
Sim. A Anthropic lista os conectores personalizados como disponíveis no Claude, no Cowork e no Claude Desktop. Eles precisam ser servidores remotos acessíveis pela internet; um servidor local do arquivo de configuração do desktop não fica disponível no Cowork.

**Preciso de um conector por caixa?**
Não. Um único conector do MCPEmails cobre todas as caixas do seu espaço de trabalho, e a mesma URL funciona no chat do Claude, no Cowork, no ChatGPT e em outros clientes MCP.

**O Claude pode enviar e-mails pelo Cowork?**
Sim, de qualquer caixa que você conectou com acesso Padrão ou Acesso total. [O Claude pode ler e enviar meus e-mails?](/blog/can-claude-read-my-email#o-claude-pode-enviar-e-mails) compara como cada conector lida com o envio.

## Próximo passo

[Comece grátis](/signup), conecte a caixa que você mais confere, adicione o MCPEmails ao Claude e pergunte a uma tarefa do Cowork o que precisa de resposta hoje. Adicione as outras caixas quando quiser uma resposta só em vez de várias.`,
};

export default translation;
