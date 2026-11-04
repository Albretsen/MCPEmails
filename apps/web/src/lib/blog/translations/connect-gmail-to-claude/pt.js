const translation = {
  title: 'Como conectar o Gmail ao Claude: conector integrado ou MCP',
  description:
    'O conector de Gmail integrado do Claude cobre uma conta do Gmail dentro do Claude. Quando você também precisa de Outlook, IMAP, várias caixas de entrada ou outros apps de IA, conecte o Gmail ao Claude via MCP em dois minutos com uma senha de app e uma URL.',
  coverAlt:
    'Como conectar o Gmail ao Claude em dois minutos via MCP: uma senha de app do Google, uma URL de endpoint, nenhum e-mail armazenado',
  content: `O Claude tem seu próprio conector de Gmail. Se tudo o que você quer é uma conta do Gmail dentro do Claude, ative esse conector nas configurações de conectores do Claude e pronto. O MCPEmails entra quando você precisa de mais: Outlook, iCloud, Yahoo ou qualquer caixa de correio IMAP ao lado do Gmail, várias caixas de entrada em um único chat, ou a mesma caixa de entrada no ChatGPT, no Cursor e em outros apps MCP. O restante deste guia configura isso.

Para conectar o Gmail ao Claude pelo MCPEmails, você faz duas coisas: conecta sua caixa de entrada do Gmail uma vez no painel do MCPEmails com uma senha de app do Google, depois cola uma única URL de endpoint nas configurações de conectores do Claude e aprova um login. É só isso: sem código, sem SDK, sem chave de API. Leva uns dois minutos, e o Claude nunca armazena seu e-mail: cada leitura e cada envio vai ao Gmail ao vivo e é descartado no momento em que o Claude recebe.

Este é o passo a passo focado, só para Gmail. Se você usa várias caixas de correio ou um provedor que não é o Gmail, o guia [conecte qualquer e-mail em menos de dois minutos](/blog/connect-email-to-ai-agent-under-2-minutes) também cobre Outlook, iCloud, Fastmail e IMAP.

## O que você vai precisar

- Uma conta do **Gmail ou Google Workspace**.
- **Claude** na web (claude.ai) ou no Claude Desktop. Todos os planos do Claude podem adicionar conectores personalizados, que é como o Claude conversa com servidores MCP. O plano Free permite um, e o Pro e o Max não têm limite.
- Uma conta gratuita no **MCPEmails**. Sem cartão de crédito, uma caixa de entrada conectada, para sempre. [Comece grátis](/signup) e deixe essa aba aberta.

O MCPEmails é a ponte no meio: ele fala o Model Context Protocol com o Claude de um lado e conversa com o Gmail do outro via IMAP e SMTP. Se quiser entender o contexto do que isso significa, veja [o que é, afinal, um servidor MCP de e-mail](/blog/what-is-an-mcp-email-server).

## Passo 1: conectar sua caixa de entrada do Gmail

No painel do MCPEmails, abra **Caixas de entrada → Conectar caixa de entrada** e escolha **Gmail**. O Gmail conecta com uma senha de app do Google por padrão:

1. Ative a verificação em duas etapas na sua conta do Google, se ainda não estiver ativa. O Google só oferece senhas de app em contas que têm esse recurso.
2. Acesse **myaccount.google.com/apppasswords** e crie uma. São 16 letras minúsculas em quatro grupos, e os espaços não importam.
3. De volta ao MCPEmails, informe seu endereço completo do Gmail, cole a senha de app e clique em **Conectar caixa de entrada**. A conexão é testada no Gmail antes de ser salva. Pronto.

Sua senha normal do Google nunca é usada. A senha de app é uma credencial separada, o MCPEmails a criptografa com AES-256-GCM, e você pode revogá-la na mesma página do Google a qualquer momento. Por baixo, a caixa de entrada conecta via IMAP e SMTP (\`imap.gmail.com\`).

### Em uma conta do Google Workspace

Um administrador do Google Workspace pode desativar as senhas de app para o domínio inteiro. Se **myaccount.google.com/apppasswords** não estiver disponível para você, peça ao seu administrador para ativar as senhas de app. A página [configurações e limites do Gmail](/connect/gmail) reúne os detalhes específicos do Gmail em um só lugar.

## Passo 2: adicionar o MCPEmails ao Claude

Agora aponte o Claude para o mesmo endpoint. Como o Claude é um cliente OAuth, você não precisa de chave de API: cola uma URL e aprova um login.

1. No **claude.ai ou no Claude Desktop**, abra **Personalizar → Conectores**.
2. Clique em **+ Adicionar** e depois em **Adicionar conector personalizado**.
3. Dê o nome MCPEmails e cole isto como URL do conector:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Clique em **Continuar**, confira as configurações de login que o Claude detectou (os padrões servem) e clique em **Adicionar**.
5. Faça login com sua conta do MCPEmails e aprove os escopos que você quer: \`read:email\`, \`send:email\` ou os dois.
6. Em um chat, clique em **+** no canto inferior esquerdo, escolha **Conectores** e ative o MCPEmails.

No plano Team ou Enterprise, um Owner adiciona o conector uma vez em **Configurações da organização → Conectores**. Os membros então abrem **Personalizar → Conectores**, localizam o MCPEmails e clicam em **Conectar**.

Esse é todo o lado do cliente. A conexão fica limitada exatamente ao que você aprovou, e você pode revogá-la no painel com um clique. Se preferir entender o caminho por chave de API (para clientes sem OAuth integrado, como o Cline ou um script próprio), leia [OAuth ou chaves de API para acesso de IA ao e-mail](/blog/oauth-vs-api-keys-ai-email-access). Vai conectar outra caixa de entrada também? A [configuração passo a passo de e-mail no Claude](/blog/connect-claude-to-email) cobre Outlook, iCloud, Fastmail e IMAP.

## Passo 3: fazer seu primeiro prompt ao Claude

Teste com algo pequeno. Peça ao Claude:

> "Resuma meus três e-mails não lidos mais recentes."

Nos bastidores, o Claude chama \`inbox_list\` para descobrir seu Gmail conectado e depois \`email_read\` para listar e ler as mensagens. Se ele responder, sua conexão está no ar. A partir daí, experimente:

- "Encontre a fatura da Stripe do mês passado e me diga o valor."
- "Escreva um rascunho de resposta educada ao último e-mail do meu locador, mas não envie ainda."
- "Arquive todas as newsletters desta semana na minha caixa de entrada."
- "O que eu combinei na minha conversa por e-mail com a Acme?"

Para um conjunto mais amplo de padrões (triagem diária, resumos automáticos e rotinas de limpeza), veja [as melhores formas de deixar o Claude gerenciar sua caixa de entrada](/blog/best-ways-to-let-claude-manage-your-inbox) e o [playbook de triagem e resumo](/blog/ai-agent-triage-summarize-inbox).

## O que o Claude consegue fazer com o seu Gmail

Depois de conectado, o Claude trabalha com um pequeno conjunto de ferramentas consolidadas, então faz muito mais do que ler:

- **Ler e pesquisar:** \`email_read\` (listar, ler e pesquisar por remetente, destinatário, assunto, status de não lido ou intervalo de datas).
- **Enviar e responder:** \`email_compose\` (enviar, responder, encaminhar). As mensagens saem pelo Gmail como e-mails normais do seu próprio endereço, então a reputação do seu domínio continua sendo sua.
- **Organizar:** \`email_organize\` (mover, copiar, sinalizar, arquivar). Os marcadores do Gmail aparecem como pastas, então uma mensagem com vários marcadores aparece em várias pastas, movê-la altera seus marcadores, e arquivar a remove da Caixa de entrada.
- **Rascunhos, pastas, agendamento, contatos:** \`draft\`, \`folder\`, \`schedule\` e \`contact_search\` completam o conjunto.

O Claude também tem um conector de Gmail próprio, e ele também consegue enviar. [O Claude consegue ler meu e-mail e enviar e-mails?](/blog/can-claude-read-my-email) compara esse conector com o MCPEmails, caixa de correio por caixa de correio.

Uma coisa para saber desde já: o MCPEmails funciona por consulta. Não há webhooks push, então o Claude reage a e-mails novos quando você pede para verificar, não no instante em que uma mensagem chega. Para quase todo fluxo de trabalho de assistente, esse é exatamente o modelo certo.

## É seguro conectar o Gmail ao Claude?

Versão curta: sim, e o design foi feito em torno disso.

- **Seu e-mail nunca é armazenado.** Corpos, assuntos e anexos são buscados ao vivo a cada chamada, entregues ao Claude e descartados imediatamente. O que fica guardado por caixa de entrada é a credencial criptografada, a sua senha de app, mais os poucos dados de que um recurso que você ativa precisa, como uma mensagem agendada esperando para sair. Veja [por que "e-mail nunca armazenado" realmente importa](/blog/why-email-never-stored-matters).
- **Você controla o escopo.** Aprove somente leitura e o Claude literalmente não consegue enviar. Aprove os dois e você ainda pode revogar qualquer um a qualquer momento.
- **Sem compartilhar senha.** Sua senha normal do Google nunca chega ao MCPEmails. Uma senha de app é uma credencial separada que você pode revogar em myaccount.google.com/apppasswords a qualquer momento, ou pode excluir a caixa de entrada no MCPEmails.

O modelo de ameaças completo (o que é criptografado, o que um invasor veria e não veria) está em [é seguro dar a um agente de IA acesso ao e-mail?](/blog/is-it-safe-to-give-ai-agent-email-access)

## Perguntas frequentes

**Preciso de uma chave de API para conectar o Gmail ao Claude?**
Não. O Claude tem suporte a OAuth, então você cola a URL do endpoint e aprova um login. As chaves de API são só para clientes sem OAuth integrado.

**O Claude armazena minhas mensagens do Gmail?**
Não. O e-mail é buscado ao vivo no Gmail a cada solicitação e descartado logo depois que o Claude o lê. Nada dos e-mails que o Claude lê fica guardado; o que fica guardado é a sua credencial criptografada (a senha de app).

**O Claude consegue enviar e-mail pelo meu Gmail?**
Sim, se você conceder o escopo \`send:email\`. Os envios saem pelo Gmail como mensagens normais da sua própria conta. Conceda somente leitura se preferir que o Claude nunca envie.

**Funciona com o plano gratuito do Claude?**
Sim. O plano Free do Claude pode adicionar um conector personalizado, o que basta para o MCPEmails, e o Pro e o Max não têm limite. O lado do MCPEmails é gratuito e sem cartão.

**O MCPEmails vai ver minha senha do Google?**
Não. Você cola uma senha de app, uma credencial separada que o Google gera e que você pode revogar a qualquer momento. Sua senha normal do Google nunca é digitada em lugar nenhum do MCPEmails.

## Resumindo

É isso: uma senha de app do Google, uma URL de endpoint, e o Claude consegue ler, pesquisar e enviar seus e-mails de verdade, sem nunca armazená-los. O plano Free não custa nada, não pede cartão e conecta uma caixa de entrada; o Personal custa $9/mês para até três caixas de entrada, e o Pro conecta até 10 (veja os [preços](/pricing)).

Pronto para começar? [Conecte seu Gmail grátis](/signup), cole o endpoint no Claude e peça para ele resumir seus e-mails não lidos.`,
};

export default translation;
