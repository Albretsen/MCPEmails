const translation = {
  title: 'Como conectar o Claude ao Hotmail e ao Outlook.com (contas pessoais)',
  description:
    'O conector do Microsoft 365 no Claude agora aceita uma conta pessoal da Microsoft nos planos Free, Pro, Max e Ultra. Quando isso basta, e como conectar o Hotmail, Outlook.com, Live ou MSN ao Claude com anexos, várias caixas ou um plano Team por uma URL de conector personalizado.',
  coverAlt: 'Claude conectado a uma caixa de entrada pessoal do Outlook.com ou Hotmail pelo MCPEmails',
  content: `Há dois jeitos de conectar o Claude a um endereço pessoal do Outlook.com, Hotmail, Live ou MSN. O conector do Microsoft 365 do próprio Claude aceita uma conta pessoal da Microsoft nos planos Free, Pro, Max e Ultra, sem nenhum administrador envolvido. O outro caminho é o MCPEmails: adicione a caixa com **Conectar com a Microsoft** e depois adicione uma URL ao Claude como conector personalizado. O segundo caminho cobre o que o conector nativo deixa de fora: anexos, várias caixas atrás de uma só conexão, os planos Team e Enterprise, e a mesma caixa no ChatGPT ou em qualquer outro cliente MCP. Um endereço antigo do hotmail.com funciona do mesmo jeito que um novo do outlook.com nos dois.

Este guia é para contas pessoais da Microsoft no Claude. Se o seu e-mail é uma conta corporativa ou educacional do Microsoft 365, leia o [guia do Outlook e do Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## O que o conector do Microsoft 365 no Claude faz com uma conta pessoal

O artigo [Conectar ao Microsoft 365](https://support.claude.com/en/articles/15183774-connect-to-microsoft-365) da Anthropic agora cobre contas pessoais. Nos planos Free, Pro, Max e Ultra, você mesmo conecta uma conta do Outlook.com, Hotmail, Live ou MSN; nenhum administrador é necessário. O conector alcança o Outlook e o OneDrive, e as ferramentas de escrita estão incluídas, então o Claude pode redigir e enviar e-mails e gerenciar eventos da agenda depois de perguntar a você primeiro.

Três limites do mesmo artigo importam para o e-mail:

- **Nada de anexos nas ferramentas de escrita.** O Claude não consegue enviar, encaminhar nem redigir um e-mail com anexo por ele.
- **Não nos planos Team e Enterprise.** Esses planos não veem a opção de conta pessoal, então um endereço pessoal do Hotmail ao lado de um plano corporativo não tem caminho nativo.
- **Só dentro do Claude, para a conta com que você entra.** O Gmail tem conector próprio; iCloud, Yahoo e caixas IMAP não têm nenhum, e nada passa para o ChatGPT ou outro cliente MCP.

Contas corporativas ou educacionais são outro caso: um Administrador Global do Microsoft Entra ainda precisa consentir antes que alguém na organização possa conectar. O [guia do Outlook e do Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) e a [página de consentimento do administrador](/docs/microsoft-365-admin-consent) tratam disso.

Se uma caixa pessoal do Outlook.com no Claude, sem anexos, é tudo de que você precisa, o conector nativo resolve. O resto deste guia é o caminho para todo o restante.

## Do que você precisa

- Uma conta pessoal da Microsoft com uma caixa do Outlook: um endereço em outlook.com, hotmail.com, live.com ou msn.com, incluindo versões de outros países, como hotmail.co.uk, outlook.de ou live.no.
- O Claude na web ou o Claude Desktop. A Anthropic oferece conectores personalizados em todos os planos do Claude, inclusive o Free, que permite um conector personalizado.
- Uma conta no MCPEmails. [Comece grátis](/signup) e deixe a aba aberta.

O MCPEmails fica entre os dois. De um lado, ele conversa com o Claude pelo Model Context Protocol; do outro, com a sua caixa do Outlook.com pelo Microsoft Graph.

## Passo 1: conecte sua caixa do Outlook.com ou do Hotmail

1. No painel do MCPEmails, vá em **Caixas de entrada** e clique em **Conectar caixa de entrada**.
2. Escolha **Outlook** e clique em **Conectar com a Microsoft**.
3. Entre na página da própria Microsoft com seu endereço do Outlook.com, Hotmail, Live ou MSN e conclua a verificação em duas etapas, se sua conta usar.
4. Revise as permissões e aprove. A Microsoft pede para permitir que o MCPEmails leia e altere seus e-mails, envie e-mails como você, mantenha esse acesso e veja seu perfil básico e seu endereço de e-mail.

Você volta ao painel com a caixa conectada. Nenhum administrador participa no caso de uma conta pessoal, e você nunca digita sua senha da Microsoft no MCPEmails.

### Não use IMAP nem senha de app

Muitos guias antigos mandam criar uma senha de app e informar as configurações IMAP do Outlook. Isso não funciona mais: a Microsoft [encerrou o login com senha para contas do Outlook em apps de e-mail que não são da Microsoft](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d) em 16 de setembro de 2024. Se você escolher **IMAP / SMTP** e digitar um endereço do Hotmail ou do Outlook.com, o painel mostra um aviso com o botão **Usar Entrar com a Microsoft**, que leva de volta à opção Outlook. A [página de configurações do Outlook.com](/connect/outlook) reúne os detalhes do provedor em um só lugar.

## Passo 2: adicione o MCPEmails ao Claude como conector personalizado

No claude.ai ou no Claude Desktop:

1. Abra **Personalizar → Conectores**.
2. Clique em **+ Adicionar** e depois em **Adicionar conector personalizado**.
3. Dê um nome, por exemplo MCPEmails, e cole esta URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Clique em **Continuar**, mantenha as configurações de autenticação que o Claude detectar e clique em **Adicionar**.
5. Clique em **Conectar**, entre na sua conta do MCPEmails e aprove as permissões que você quer dar ao Claude, por exemplo \`read:email\` para ler e-mails e \`send:email\` para enviá-los.

Para usar em um chat, clique em **+** no canto inferior esquerdo da caixa de mensagem, escolha **Conectores** e ative o MCPEmails. Não há chave de API para criar nem arquivo de configuração para editar. Em um plano Team ou Enterprise, só um owner pode adicionar um conector personalizado; os membros depois o encontram em **Personalizar → Conectores** e clicam em **Conectar**. Se o Claude travar em alguma dessas telas, a [página de configuração do Claude](/docs/claude) trata dos problemas mais comuns.

## Passo 3: peça ao Claude algo simples

Comece com um pedido somente leitura:

> Resuma os cinco e-mails não lidos mais recentes da minha caixa do Hotmail e diga quais precisam de resposta.

O Claude usa a ferramenta \`email_read\` para listar e abrir as mensagens. Se ele responder, a conexão está funcionando. Depois experimente:

- "Encontre a confirmação de pedido que recebi na semana passada e me diga a data de entrega."
- "Escreva um rascunho de resposta para o último e-mail do meu locador, mas não envie."
- "Mova todas as newsletters deste mês para uma pasta chamada Leitura."

Se você também tem Gmail, iCloud ou uma caixa corporativa, conecte do mesmo jeito, e o Claude vê todas pelo mesmo conector. [Várias contas de e-mail no Claude e no ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica como o Claude as mantém separadas.

## O que o Claude pode fazer com uma caixa do Outlook.com

Depois de conectado, o Claude trabalha com as mesmas ferramentas de e-mail que usa para qualquer outro provedor:

- Ler e pesquisar e-mails.
- Enviar, responder e encaminhar a partir do seu próprio endereço, com anexos.
- Criar e editar rascunhos, e agendar um envio para mais tarde.
- Criar pastas, inclusive subpastas, e mover, copiar e arquivar mensagens.
- Sinalizar mensagens e marcá-las como lidas ou não lidas.
- Mover mensagens para Deleted Items (Itens Excluídos) ou excluí-las permanentemente.
- Adicionar a assinatura que você definiu para aquela caixa em cada mensagem que ele envia.

O Outlook.com organiza os e-mails em pastas, não em marcadores, então o Claude arquiva um e-mail movendo-o para uma pasta. Vale conhecer um limite do Microsoft Graph: uma pesquisa por texto não pode ser combinada com os filtros de não lidas, anexos, sinalizadas ou data. Quando uma pesquisa inclui texto, esses filtros são descartados, e o resultado informa ao Claude quais foram. Peça primeiro o texto e deixe o Claude refinar os resultados.

O MCPEmails não envia novos e-mails ao Claude por conta própria. O Claude verifica quando você pede, o que funciona bem para triagem e resumos.

## Meus e-mails do Outlook.com ficam armazenados em algum lugar?

Não. Cada vez que o Claude pede uma mensagem, o MCPEmails a busca ao vivo na Microsoft, entrega ao Claude e descarta. O que fica guardado para a caixa é o token OAuth do seu login na Microsoft, criptografado em repouso, mais os poucos dados de que um recurso que você ativa precisa, como uma mensagem agendada esperando para sair. Para desconectar, exclua a caixa no MCPEmails ou remova o MCPEmails dos apps que têm acesso à sua conta Microsoft. [Por que "o e-mail nunca é armazenado" importa](/blog/why-email-never-stored-matters) explica o modelo, e [é seguro dar a um agente de IA acesso ao e-mail?](/blog/is-it-safe-to-give-ai-agent-email-access) mostra o que observar, como instruções escondidas dentro de um e-mail.

## Perguntas frequentes

**Posso conectar o Claude ao Outlook.com ou ao Hotmail?**
Sim, de dois jeitos. No Free, Pro, Max ou Ultra, o conector nativo do Microsoft 365 no Claude aceita uma conta pessoal da Microsoft diretamente, sem anexos. Para anexos, várias caixas, um plano Team ou Enterprise, ou a mesma caixa no ChatGPT, conecte o endereço ao MCPEmails com Conectar com a Microsoft, adicione \`https://mcpemails.com/api/mcp\` ao Claude em Personalizar → Conectores, e o Claude pode ler, pesquisar, enviar e organizar seus e-mails do Outlook.com, Hotmail, Live ou MSN.

**Por que o conector do Microsoft 365 no Claude recusa meu endereço do Hotmail?**
Verifique o plano. A Anthropic diz que contas pessoais da Microsoft conectam no Free, Pro, Max e Ultra, e que os planos Team e Enterprise não veem essa opção. Um endereço corporativo ou educacional é diferente: ele precisa que um Administrador Global do tenant do Microsoft Entra consinta primeiro. Em um plano Team ou Enterprise, o MCPEmails como conector personalizado é o caminho para um endereço pessoal.

**Preciso de senha de app ou de configurações IMAP?**
Não. Contas pessoais da Microsoft conectam por Entrar com a Microsoft e pelo Microsoft Graph. A Microsoft não aceita mais login com senha vindo de apps de e-mail de terceiros nessas contas, então uma senha de app não entraria de qualquer forma.

**Funciona com um endereço antigo do Hotmail?**
Sim. Endereços do Hotmail, Live, MSN e Outlook.com são o mesmo serviço de e-mail pessoal da Microsoft, então todos conectam do mesmo jeito. Se a conta Microsoft com que você entra não tiver uma caixa do Outlook, o MCPEmails recusa a conexão e avisa.

**A mesma configuração funciona no ChatGPT?**
Sim. A URL é a mesma, e [conectar o ChatGPT ao Hotmail e ao Outlook.com](/blog/connect-chatgpt-to-outlook-com-hotmail) mostra o lado do ChatGPT, onde você a adiciona como servidor MCP personalizado.

## Próximo passo

[Comece grátis](/signup), conecte sua caixa do Outlook.com ou do Hotmail com a Microsoft, adicione a URL ao Claude e peça um resumo dos seus e-mails não lidos. Para todos os outros provedores, o [guia de configuração de e-mail no Claude](/blog/connect-claude-to-email) cobre Gmail, iCloud, Fastmail e IMAP.`,
};

export default translation;
