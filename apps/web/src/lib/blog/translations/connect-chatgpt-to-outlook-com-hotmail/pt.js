const translation = {
  title: 'Como conectar o ChatGPT ao Hotmail e ao Outlook.com (contas pessoais)',
  description:
    'O plugin do Outlook no ChatGPT foi feito para contas corporativas e de estudante. Conecte uma caixa pessoal do Hotmail, Outlook.com, Live ou MSN ao ChatGPT com Entrar com a Microsoft e uma URL de servidor MCP personalizado.',
  coverAlt: 'ChatGPT conectado a uma caixa de entrada pessoal do Outlook.com ou Hotmail pelo MCPEmails',
  content: `Para conectar o ChatGPT a um endereço pessoal do Outlook.com, Hotmail, Live ou MSN, adicione a caixa ao MCPEmails com **Conectar com a Microsoft** e depois adicione uma URL ao ChatGPT como servidor MCP personalizado. O plugin do Outlook do próprio ChatGPT foi construído em torno de contas Microsoft corporativas e de estudante, e quem tenta usá-lo com um endereço pessoal relata receber a mensagem de que só contas de empresa ou de instituição de ensino podem se conectar. Um servidor MCP personalizado não tem esse limite.

Este guia é para contas pessoais da Microsoft no ChatGPT. Para o Claude, leia [Como conectar o Claude ao Hotmail e ao Outlook.com](/blog/connect-claude-to-outlook-com-hotmail). Para uma conta corporativa ou de estudante do Microsoft 365, leia o [guia do Outlook e do Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## O que o plugin do Outlook no ChatGPT aceita

O ChatGPT tem plugins de Outlook Email e Outlook Calendar. A [página de ajuda da OpenAI](https://help.openai.com/en/articles/12512241) sobre eles é escrita para organizações: algumas ações precisam de permissões da Microsoft que um administrador do Microsoft Entra deve aprovar para a organização, e os administradores do espaço de trabalho escolhem quais ações ficam ativadas. A página não diz se contas pessoais da Microsoft são aceitas.

Quem testou diz que não. Em uma [discussão no Microsoft Q&A](https://learn.microsoft.com/en-gb/answers/questions/5558072/cant-connect-outlook-to-chatgpt) de setembro de 2025, um usuário do Hotmail foi barrado na etapa de login do Outlook com a mensagem de que só contas de empresa ou de instituição de ensino podem ser conectadas. Uma resposta de abril de 2026 diz que contas pessoais do Hotmail e do Outlook.com continuavam sem conseguir conectar. A OpenAI não documentou nenhuma mudança desde então, então teste o plugin primeiro se quiser: se ele aceitar seu endereço, talvez você não precise de mais nada.

Se ele recusar, o motivo é o tipo de conta. Uma conta pessoal da Microsoft não tem organização nem administrador por trás. Não existe configuração do seu lado que mude isso.

## O que você precisa

- Uma conta pessoal da Microsoft com uma caixa do Outlook: outlook.com, hotmail.com, live.com ou msn.com, inclusive versões por país, como hotmail.com.br ou outlook.com.br.
- **Um plano pago do ChatGPT, no chatgpt.com em um navegador.** A página de ajuda da OpenAI lista servidores MCP personalizados para Business e Enterprise/Edu, com ferramentas de leitura e busca apenas no Pro, e não menciona o Go nem o Plus. O Free não pode adicionar um, e o aplicativo de celular também não.
- Uma conta no MCPEmails. [Comece grátis](/signup); o plano gratuito conecta uma caixa de entrada.

O MCPEmails conversa com o ChatGPT pelo Model Context Protocol de um lado e com a sua caixa pelo Microsoft Graph do outro.

## Passo 1: conectar sua caixa do Outlook.com ou do Hotmail

1. No painel do MCPEmails, vá em **Caixas de entrada** e clique em **Conectar caixa de entrada**.
2. Escolha **Outlook** e clique em **Conectar com a Microsoft**.
3. Entre na página da própria Microsoft com seu endereço do Outlook.com, Hotmail, Live ou MSN e conclua a verificação em duas etapas, se sua conta usar.
4. Aprove as permissões. A Microsoft pede para permitir que o MCPEmails leia e altere seus e-mails, envie e-mails como você, mantenha esse acesso e veja seu perfil básico e seu endereço de e-mail.

Você volta ao painel com a caixa conectada. Nenhum administrador participa no caso de uma conta pessoal, e você nunca digita sua senha da Microsoft no MCPEmails.

### Pule o IMAP e as senhas de app

Guias antigos mandam criar uma senha de app e informar as configurações IMAP do Outlook. A Microsoft [encerrou o login com senha para contas do Outlook em apps de e-mail que não são da Microsoft](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d) em 16 de setembro de 2024, então esse caminho não entra mais. Se você escolher **IMAP / SMTP** e digitar um endereço do Hotmail ou do Outlook.com, o painel aponta de volta para **Usar Entrar com a Microsoft**. A [página de configurações do Outlook.com](/connect/outlook) reúne os detalhes em um só lugar.

## Passo 2: adicionar o MCPEmails ao ChatGPT

1. No chatgpt.com, abra **Plugins**, depois **Personal** (Pessoais), e clique em **Add** (Adicionar) no canto superior direito.
2. Escolha **Adicionar servidor MCP personalizado** e dê o nome MCPEmails.
3. Em **Conexão**, cole esta URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Escolha **OAuth**, marque **Entendo e quero continuar** e clique em **Criar como plugin**.
5. Faça login no MCPEmails e aprove o acesso que você quer dar ao ChatGPT, por exemplo só leitura para começar.
6. Em um chat, digite **@** e escolha MCPEmails. A escolha vale para aquela mensagem, então mencione de novo com @ quando uma pergunta seguinte precisar dos seus e-mails.

Escolha OAuth, não "sem autenticação". Um conector criado sem autenticação parece bem na configuração e falha na primeira chamada. Em um espaço de trabalho Business ou Enterprise, pode ser necessário que um administrador adicione o servidor para você. A OpenAI muda esses menus de lugar de vez em quando; a [página de configuração do ChatGPT](/docs/chatgpt) tem o caminho atual.

## Passo 3: peça ao ChatGPT algo simples

Comece com somente leitura:

> Resuma os cinco e-mails não lidos mais recentes da minha caixa do Hotmail e me diga quais precisam de resposta.

Se ele responder, a conexão funciona. Depois experimente:

- "Encontre a confirmação de pedido que recebi na semana passada e me diga a data de entrega."
- "Escreva um rascunho de resposta ao último e-mail do meu locador, mas não envie."
- "Mova todas as newsletters deste mês para uma pasta chamada Leitura."

Se você também tem Gmail, iCloud, Yahoo ou uma caixa do trabalho, conecte-as ao MCPEmails também, e o ChatGPT vê todas pelo mesmo servidor. [Várias contas de e-mail no Claude e no ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica como ele as mantém separadas.

## O que o ChatGPT consegue fazer com uma caixa do Outlook.com

- Ler e pesquisar e-mails.
- Enviar, responder e encaminhar a partir do seu próprio endereço, com anexos.
- Criar e editar rascunhos, e agendar um envio para mais tarde.
- Criar pastas, inclusive subpastas, e mover, copiar e arquivar mensagens.
- Sinalizar mensagens e marcá-las como lidas ou não lidas.
- Mover mensagens para Itens Excluídos ou excluí-las permanentemente.
- Adicionar a assinatura que você definiu para a caixa a toda mensagem que ele envia.

O Outlook.com usa pastas, não marcadores, então o ChatGPT arquiva movendo a mensagem. Vale conhecer um limite do Microsoft Graph: uma pesquisa por texto não pode ser combinada com os filtros de não lidas, anexos, sinalizadas ou data. Quando uma pesquisa inclui texto, esses filtros são descartados e o resultado informa quais foram. Peça o texto primeiro e deixe o ChatGPT refinar os resultados.

O MCPEmails não empurra e-mails novos para o ChatGPT. Ele verifica quando você pede.

## Meus e-mails do Outlook.com ficam armazenados em algum lugar?

Não. Cada vez que o ChatGPT pede uma mensagem, o MCPEmails a busca ao vivo na Microsoft, entrega e descarta. O que fica guardado para a caixa é o token OAuth do seu login na Microsoft, criptografado em repouso, mais os poucos dados de que um recurso que você ativa precisa, como uma mensagem agendada esperando para sair. Para desconectar, exclua a caixa no MCPEmails ou remova o MCPEmails dos apps que têm acesso à sua conta Microsoft. [Por que "o e-mail nunca é armazenado" importa](/blog/why-email-never-stored-matters) explica o modelo.

## Perguntas frequentes

**Posso conectar o ChatGPT ao Hotmail ou ao Outlook.com?**
Sim, com um servidor MCP personalizado. Conecte o endereço ao MCPEmails com Conectar com a Microsoft, adicione \`https://mcpemails.com/api/mcp\` ao ChatGPT em Plugins, e o ChatGPT pode ler, pesquisar, enviar e organizar seus e-mails do Outlook.com, Hotmail, Live ou MSN. Adicionar um servidor MCP personalizado exige um plano pago no chatgpt.com: a OpenAI cita Business e Enterprise/Edu para suporte completo e o Pro só para ferramentas de leitura e busca.

**O plugin do Outlook no ChatGPT funciona com conta pessoal?**
A página de ajuda da OpenAI não diz que sim, e usuários relatam receber no login a mensagem de que só contas de empresa ou de instituição de ensino podem se conectar. A configuração documentada depende de um administrador do Microsoft Entra da organização, que uma conta pessoal não tem.

**Preciso de senha de app ou de configurações IMAP?**
Não. Contas pessoais da Microsoft conectam por Entrar com a Microsoft e pelo Microsoft Graph. A Microsoft não aceita mais login com senha vindo de apps de e-mail de terceiros nessas contas.

**Funciona com um endereço antigo do Hotmail?**
Sim. Endereços do Hotmail, Live, MSN e Outlook.com são o mesmo serviço de e-mail pessoal da Microsoft e conectam do mesmo jeito.

**A mesma configuração funciona no Claude?**
Sim, com a mesma URL. [Como conectar o Claude ao Hotmail e ao Outlook.com](/blog/connect-claude-to-outlook-com-hotmail) mostra o lado do Claude, e funciona em todos os planos do Claude, inclusive o Free.

## Próximo passo

[Comece grátis](/signup), conecte sua caixa do Outlook.com ou do Hotmail com a Microsoft, adicione a URL ao ChatGPT e peça um resumo dos seus e-mails não lidos. Para outros provedores, [Como conectar o ChatGPT ao seu e-mail](/blog/connect-chatgpt-to-email) cobre Gmail, iCloud e IMAP.`,
};

export default translation;
