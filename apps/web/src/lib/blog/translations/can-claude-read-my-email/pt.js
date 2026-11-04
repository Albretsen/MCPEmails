const translation = {
  title: 'O Claude pode ler e enviar meus e-mails? Caixa por caixa',
  description:
    'Sim, no Gmail e em contas corporativas do Microsoft 365, com os conectores do próprio Claude. Yahoo, iCloud, Outlook.com, caixas IMAP e vários provedores ao mesmo tempo precisam de um servidor MCP.',
  coverAlt:
    'Claude lendo e enviando e-mails de caixas do Gmail, Microsoft 365, Yahoo, iCloud e IMAP',
  content: `**Sim, o Claude pode ler e enviar seus e-mails, mas só de uma caixa de correio que você conectou a ele.** O Claude tem dois conectores de e-mail próprios: um para o Gmail e outro para contas corporativas do Microsoft 365. O conector do Gmail lê, pesquisa e envia, e por padrão pede sua aprovação antes de cada envio. O conector do Microsoft 365 lê e pesquisa, e só envia depois que um administrador ativa as ferramentas de escrita. Yahoo, iCloud, um endereço pessoal do Outlook.com, uma caixa da empresa em um servidor IMAP ou vários provedores em uma só conexão precisam de um servidor MCP como o MCPEmails.

Esta página mostra em qual caso você se encaixa. As informações sobre os produtos da Anthropic e do Google foram lidas nas páginas oficiais de cada um em outubro de 2026. Esses produtos mudam com frequência, então cada seção traz o link da página em que se baseia.

**Ir para:** [Gmail](#gmail-o-conector-próprio-do-claude) · [Microsoft 365](#outlook-e-microsoft-365-só-contas-corporativas) · [O que os conectores nativos não cobrem](#o-que-os-conectores-nativos-não-cobrem) · [MCPEmails](#como-o-mcpemails-cobre-essa-lacuna) · [Envio](#o-claude-pode-enviar-e-mails) · [Perguntas frequentes](#perguntas-frequentes)

## Gmail: o conector próprio do Claude

O conector do Gmail aparece no diretório de conectores do Claude como feito pelo Google e roda no servidor MCP do Gmail do Google (\`gmailmcp.googleapis.com\`). Você o ativa nas configurações de conectores do Claude e entra com sua conta Google.

O que ele faz, segundo o [artigo de ajuda da Anthropic](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) e a [página no diretório](https://claude.com/connectors/gmail):

- **Ler e pesquisar** seus e-mails com perguntas em linguagem natural, e ler conversas inteiras.
- **Escrever rascunhos, enviar, responder e encaminhar.** O artigo da Anthropic cita as quatro ações.
- **Organizar** com marcadores e mover mensagens ou conversas para a lixeira.
- **Perguntar antes.** Por padrão, o Claude pede sua aprovação antes de cada envio, resposta ou encaminhamento. Nos planos Team e Enterprise, um proprietário precisa primeiro ativar o conector para a organização, e é ele quem decide se os membros podem deixar essas ações rodarem sem pergunta.

Onde ele para:

- **Anexos.** O artigo da Anthropic diz que o Claude vê só os metadados dos anexos, não o conteúdo.
- **Uma conta Google.** O artigo fala em acesso à "conta Google que você conectou" e não menciona como adicionar uma segunda.

O Google também documenta o mesmo servidor MCP do Gmail como parte do seu [Workspace Developer Preview Program](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server). Quem participa desse programa pode adicioná-lo a outros clientes MCP por conta própria, com um cliente OAuth próprio do Google Cloud. Essa versão documentada lista ferramentas para pesquisar, ler conversas, criar rascunhos e alterar marcadores, e nenhuma ferramenta de envio: você revisa o rascunho e envia pelo Gmail.

Se o Gmail é sua única caixa e o Claude é seu único app de IA, o conector nativo pode ser tudo de que você precisa.

## Outlook e Microsoft 365: só contas corporativas

O conector do Microsoft 365 no Claude lê e-mails do Outlook em contas que pertencem ao tenant Microsoft 365 de uma empresa.

- **Leitura e pesquisa** cobrem sua caixa principal, a pasta Arquivo Morto e as caixas compartilhadas que você pode abrir.
- **O envio vem desativado.** O conector começa como somente leitura. Depois que as ferramentas de escrita são ativadas, o Claude pode enviar e encaminhar e-mails e criar, editar e excluir rascunhos. As ferramentas de escrita recusam mensagens com anexos.
- **Um administrador precisa aprovar.** Um Administrador Global do Microsoft Entra da sua organização precisa dar consentimento antes que qualquer pessoa ali possa conectar, e de novo antes que as ferramentas de escrita funcionem.
- **Contas pessoais são recusadas.** O [artigo da Anthropic](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) é claro: endereços como @outlook.com e @hotmail.com não podem ser usados para conectar.

Ou seja, um endereço pessoal do Outlook.com, Hotmail ou Live não tem caminho nativo até o Claude. [Conectar o Claude ao Outlook.com e ao Hotmail](/blog/connect-claude-to-outlook-com-hotmail) mostra o caminho que funciona.

## O que os conectores nativos não cobrem

Somando os dois, estas são as caixas que nenhum conector nativo alcança:

- **Yahoo Mail e AOL.**
- **iCloud Mail.**
- Endereços **pessoais do Outlook.com, Hotmail e Live**.
- **Caixas da empresa em um servidor IMAP**: Fastmail, Zoho Mail, IONOS, STRATO, uma hospedagem com cPanel ou seu próprio servidor.
- **Uma segunda conta Google.** O artigo da Anthropic descreve uma conta Google conectada e não menciona como adicionar outra.
- **Vários provedores em uma só conexão**, para que uma única pergunta pesquise ao mesmo tempo o contato@, seu próprio endereço e um Gmail pessoal.

O Fastmail e o Zoho Mail têm servidores MCP próprios, que você pode adicionar ao Claude como conectores personalizados. Cada um alcança só as caixas do próprio provedor. Nenhum dos dois artigos de ajuda do Claude fala em agendar um envio. A [comparação entre os conectores nativos do Claude e do ChatGPT](/native-connectors-vs-mcp) lista cada recurso com a fonte e a data em que foi verificado.

## Como o MCPEmails cobre essa lacuna

O MCPEmails é um servidor MCP hospedado. Você conecta cada caixa a ele uma vez, adiciona uma única URL de conector ao Claude, e o Claude passa a ler, pesquisar e enviar de todas as caixas conectadas:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Qualquer provedor.** [Yahoo Mail](/connect/yahoo), [iCloud Mail](/connect/icloud), [Outlook.com pessoal](/connect/outlook) e [Microsoft 365 corporativo](/connect/office365) (ambos com Entrar com a Microsoft), [Gmail](/connect/gmail) com uma senha de app do Google, [Fastmail](/connect/fastmail) com uma senha de app, [Zoho Mail](/connect/zoho) e qualquer caixa que use [IMAP e SMTP](/connect/imap). A [lista completa de provedores](/connect) tem uma página de configurações para cada servidor.
- **Várias caixas no mesmo chat.** O Claude chama \`inbox_list\` e vê cada endereço conectado pelo nome, então "pesquise em vendas@ e no meu Gmail" funciona em uma só conversa. [Várias contas de e-mail no Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica essa configuração.
- **Enviar do endereço certo.** Cada caixa envia pelo próprio provedor, com o próprio nome de remetente e a própria assinatura.
- **Agendar e organizar.** O Claude pode agendar um envio e mover, sinalizar, arquivar ou excluir e-mails em todas as caixas conectadas, quando você dá a ele Acesso total.
- **Ler anexos.** O Claude pode [extrair o texto de um anexo em PDF, CSV ou HTML](/blog/extract-email-attachments-for-ai) sem que o arquivo fique guardado.
- **As mesmas caixas em outros apps.** É um servidor MCP padrão, então a mesma configuração funciona também no ChatGPT, Cursor, VS Code e outros clientes MCP.

Os e-mails são buscados ao vivo no seu provedor a cada solicitação e não ficam armazenados. O que fica guardado: a credencial criptografada de cada caixa, uma mensagem agendada até ser enviada, e um envio retido para revisão até ser aprovado, rejeitado ou expirar. Os dados ficam armazenados em Estocolmo.

### Adicione ao Claude

1. [Crie uma conta grátis no MCPEmails](/signup) e conecte uma caixa em **Caixas de entrada** e depois **Conectar caixa de entrada**.
2. No claude.ai ou no Claude Desktop, abra **Personalizar → Conectores**, clique em **+ Adicionar** e depois em **Adicionar conector personalizado**. Dê o nome MCPEmails, informe \`https://mcpemails.com/api/mcp\`, clique em **Continuar**, mantenha as configurações de login detectadas e clique em **Adicionar**.
3. Entre no MCPEmails quando o Claude pedir e escolha quanto acesso o Claude recebe: **Somente leitura**, **Padrão** (inclui envio e rascunhos) ou **Acesso total** (inclui agendamento, pastas e exclusão).

O [guia passo a passo de configuração do Claude](/blog/connect-claude-to-email) mostra cada tela e cada provedor, e a [página de configuração do Claude](/docs/claude) trata dos erros de conector.

## O Claude pode enviar e-mails?

Sim. Muitas páginas ainda dizem que o Claude só lê seus e-mails, mas os artigos de ajuda atuais da Anthropic dizem outra coisa. Se o Claude pode enviar depende do conector e do que você permitiu ao conectá-lo.

### O conector do Gmail no Claude

Segundo o [artigo da Anthropic sobre o Google Workspace](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors), relido no fim de outubro de 2026, o conector do Gmail pode escrever rascunhos, listar seus rascunhos salvos e enviar, responder e encaminhar. Por padrão, o Claude pede sua aprovação antes de cada envio, resposta ou encaminhamento. Nos planos Team e Enterprise, um proprietário ativa o conector e decide se os membros podem deixar essas ações rodarem sem pergunta a cada vez.

Ele envia da única conta Google que você conectou. O Claude vê só os metadados dos anexos, não o conteúdo.

### O conector do Microsoft 365 no Claude

Ele começa como somente leitura. Depois que as ferramentas de escrita são ativadas, o que exige que um Administrador Global do Microsoft Entra aprove as permissões ampliadas, o Claude pode enviar e encaminhar e-mails e criar, editar e excluir rascunhos. As ferramentas de escrita recusam qualquer mensagem com anexo, e endereços pessoais do Outlook.com e do Hotmail não conseguem conectar.

### Como o MCPEmails envia

Pelo MCPEmails, o Claude envia de qualquer caixa conectada: Gmail, Outlook, iCloud, Yahoo, uma caixa IMAP da empresa e outras. Você decide até onde ele pode ir, em quatro lugares.

- **O acesso que você concede.** Ao adicionar o MCPEmails ao Claude, você escolhe **Somente leitura** (o Claude não envia nem cria rascunhos), **Padrão** (inclui rascunhos e envio) ou **Acesso total** (inclui agendamento, pastas e exclusão). Você também pode limitar a conexão a algumas das suas caixas.
- **Rascunho primeiro.** Quando você pede ao Claude para escrever um e-mail, o MCPEmails orienta o Claude a salvar o e-mail como rascunho na sua caixa em vez de enviá-lo. No Claude e no ChatGPT, o rascunho abre em um cartão editável no chat, onde você pode alterar destinatários, assunto e texto, salvar ou enviar com alguns segundos para desfazer. Ele também fica na pasta Rascunhos do seu app de e-mail.
- **Revisar antes de enviar.** Configurado por caixa no painel. **Perguntar no chat primeiro** faz o Claude mostrar o e-mail na conversa e esperar seu sim antes de enviar. **Aprovar no mcpemails.com** retém todo envio, resposta, encaminhamento e envio de rascunho até que um proprietário ou administrador do espaço de trabalho aprove, com login no MCPEmails em um navegador; o Claude não consegue aprovar sozinho. Veja [aprovação humana para envios de e-mail por IA](/blog/approve-ai-agent-email-sends).
- **Um comprovante após cada envio.** O Claude mostra o endereço de envio, os destinatários, o assunto e se há uma cópia na sua pasta Enviados, ou o motivo de um envio ter falhado.

Cada caixa envia pelo próprio provedor, então a mensagem sai do seu endereço real, com seu nome de remetente e sua assinatura, e a resposta chega na sua caixa de entrada de sempre. O Claude também pode [agendar um e-mail para mais tarde](/blog/schedule-email-with-claude-and-chatgpt).

### O Claude pode enviar e-mails sem perguntar?

- **O conector do Gmail no Claude** pergunta antes de cada envio, resposta e encaminhamento por padrão.
- **O conector do Microsoft 365 no Claude** não envia nada até que as ferramentas de escrita sejam ativadas.
- **O MCPEmails** só envia sem mais perguntas se você concedeu acesso de envio e deixou **Revisar antes de enviar** desligado para aquela caixa. As permissões de ferramentas do próprio Claude somam mais uma camada: em **Personalizar → Conectores** você pode definir cada ferramenta do MCPEmails como sempre permitida, sujeita a aprovação ou bloqueada.

Qualquer que seja o caminho, trate o que está dentro de um e-mail como dado, não como instrução. Uma mensagem pode conter texto escrito para manipular uma IA, e uma etapa de revisão pega isso antes que algo saia da sua caixa. O [guia de segurança do acesso ao e-mail](/blog/is-it-safe-to-give-ai-agent-email-access) explica os riscos em mais detalhes.

## Perguntas frequentes

**O Claude pode ler meus e-mails?**
Sim, depois que uma caixa é conectada. Contas do Gmail e contas corporativas do Microsoft 365 conectam pelos conectores próprios do Claude. Yahoo, iCloud, Outlook.com pessoal e caixas IMAP conectam por um servidor MCP como o MCPEmails, adicionado ao Claude como conector personalizado.

**O Claude pode enviar e-mails?**
Sim. O conector do Gmail no Claude pode enviar, responder e encaminhar, e por padrão pede sua aprovação antes. O conector do Microsoft 365 envia depois que as ferramentas de escrita são ativadas. Pelo MCPEmails, o Claude envia de qualquer caixa conectada se você deu acesso de envio ao conectar, e salva primeiro como rascunho um e-mail que você pede para ele escrever.

**O conector do Gmail no Claude envia e-mails?**
Sim. A Anthropic lista envio, resposta e encaminhamento para o conector do Gmail, cada um pedindo sua aprovação por padrão. Ele envia da única conta Google que você conectou.

**O Claude pode ler meu Gmail?**
Sim, com o conector nativo do Gmail no Claude, para a conta Google que você conectar. Para usar mais de uma conta Google, ou o Gmail junto com outros provedores no mesmo chat, conecte-as pelo MCPEmails com uma senha de app do Google.

**O Claude acessa meu e-mail do Outlook ou do Hotmail?**
Contas corporativas e educacionais do Microsoft 365 podem usar o conector do Microsoft 365 no Claude depois que um administrador o aprova. Endereços pessoais do Outlook.com e do Hotmail não podem. O MCPEmails conecta os dois com Entrar com a Microsoft, embora uma conta corporativa ainda possa precisar que o administrador de TI aprove o app uma vez para a organização.

**O Claude lê e-mails do Yahoo ou do iCloud?**
Não com um conector nativo. Conecte a caixa ao MCPEmails com uma senha de app do Yahoo ou da Apple e depois adicione o MCPEmails ao Claude. O [guia do Yahoo Mail para ChatGPT e Claude](/blog/connect-yahoo-mail-to-chatgpt-and-claude) traz o passo a passo, e [o plugin do iCloud Mail no ChatGPT explicado](/blog/chatgpt-icloud-mail-plugin) compara a nova opção de iCloud da OpenAI.

**O Claude lê várias contas de e-mail ao mesmo tempo?**
Sim, pelo MCPEmails. Cada caixa que você conecta aparece no Claude pela mesma URL de conector, e o Claude indica a caixa em cada chamada.

**O MCPEmails armazena meus e-mails?**
Não. O conteúdo das mensagens é buscado ao vivo no seu provedor a cada solicitação e descartado assim que a resposta é enviada. Veja em [segurança](/security) o que fica guardado.

## Próximo passo

Se todos os seus e-mails estão em uma conta do Gmail, experimente primeiro o conector do Gmail no Claude. Para qualquer outro caso, [comece grátis](/signup), conecte uma caixa, adicione \`https://mcpemails.com/api/mcp\` ao Claude e pergunte o que precisa de resposta hoje.`,
};

export default translation;
