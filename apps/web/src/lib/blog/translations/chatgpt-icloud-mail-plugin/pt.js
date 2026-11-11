const translation = {
  title: 'Plugin do iCloud Mail no ChatGPT: configuração, limites e outras contas',
  description:
    'Como conectar o iCloud Mail ao ChatGPT com o novo plugin da OpenAI, o que ele alcança e o que não alcança, por que suas outras contas do Apple Mail não aparecem e como usar o iCloud também no Claude.',
  coverAlt: 'iCloud Mail conectado ao ChatGPT e ao Claude',
  content: `Em 27 de outubro de 2026, a OpenAI adicionou ao ChatGPT um plugin do iCloud Mail e um plugin do iCloud Calendar. O plugin de Mail permite que o ChatGPT pesquise, leia, rascunhe e envie e-mails em uma caixa do iCloud, usando uma senha específica de app da Apple. Ele cobre só o iCloud: contas do Gmail, do Outlook ou do trabalho que você adicionou ao app Mail do iPhone ou do Mac ficam fora de alcance, e o Claude não tem opção própria para o iCloud.

Este guia explica como configurar o plugin, o que ele faz, os problemas que as pessoas encontram e o que usar quando você precisa do iCloud no Claude ou de várias caixas de entrada em um só lugar.

**Ir para:** [Configuração](#como-conectar-o-icloud-mail-ao-chatgpt) · [O que ele faz](#o-que-o-plugin-do-icloud-mail-consegue-fazer) · [Não funciona?](#o-plugin-do-icloud-não-funciona) · [Outras contas](#por-que-suas-outras-contas-do-apple-mail-não-aparecem) · [Claude](#icloud-mail-no-claude) · [Perguntas frequentes](#perguntas-frequentes)

## Como conectar o iCloud Mail ao ChatGPT

A [página de ajuda sobre apps conectados](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt) da OpenAI diz que os plugins estão sendo liberados para todos os planos do ChatGPT, inclusive o Free, na web, no app para desktop e no iOS. Mail e Calendar são plugins separados, então conectar um não conecta o outro.

1. **Ative a autenticação de dois fatores** na sua Conta Apple, se estiver desligada. A Apple [só emite senhas específicas de app](https://support.apple.com/pt-br/102654) para contas protegidas por ela.
2. **Crie uma senha específica de app.** Entre em account.apple.com, abra **Início de sessão e segurança**, escolha **Senhas específicas de apps** e gere uma. Dê o nome ChatGPT para encontrá-la depois.
3. **Abra o plugin no ChatGPT.** Vá em **Configurações**, depois **Plugins**, e escolha **iCloud Mail**.
4. **Informe seu endereço do iCloud e a senha específica de app.** A OpenAI pede um endereço terminado em @icloud.com, @me.com ou @mac.com.

Sua senha normal da Conta Apple não funciona aqui. A Apple dá a apps de outros desenvolvedores dois caminhos: um app compatível pode ser autorizado com a própria Conta Apple, e todos os outros usam uma senha específica de app. O plugin da OpenAI usa a senha, o mesmo tipo que um app de e-mail de terceiros usa.

## O que o plugin do iCloud Mail consegue fazer

Pela página de ajuda da OpenAI e pela cobertura de lançamento do [9to5Mac](https://9to5mac.com/2026/10/27/icloud-mail-and-calendar-plugins-now-work-with-chatgpt/) e de outros, o plugin de Mail consegue:

- Pesquisar seus e-mails do iCloud e ler mensagens.
- Resumir o que chegou, por exemplo os não lidos de hoje.
- Rascunhar respostas e enviar e-mails.
- Consultar seus contatos do iCloud. A consulta de contatos é somente leitura, e não há plugin separado de Contatos ou Lembretes neste lançamento.

Nem a página da OpenAI nem a cobertura de lançamento dizem que o plugin consegue mover mensagens para pastas ou excluí-las, então não conte com limpeza da caixa até a OpenAI documentar isso. Contas gerenciadas por uma empresa ou escola podem estar bloqueadas pelas configurações de apps do espaço de trabalho.

Desconectar o plugin no ChatGPT não exclui a senha específica de app na Apple. Para cortar o acesso de vez, remova a senha em account.apple.com, em **Início de sessão e segurança**, **Senhas específicas de apps**.

## O plugin do iCloud não funciona?

As causas mais comuns, mais ou menos na ordem em que as pessoas esbarram nelas:

- **Sua senha da Apple é recusada.** Use uma senha específica de app. Se **Senhas específicas de apps** não aparece em account.apple.com, a autenticação de dois fatores está desligada.
- **O plugin não está na lista.** A OpenAI ainda está liberando o recurso, então ele pode não ter chegado à sua conta. Em um espaço de trabalho Business ou Enterprise, um administrador também pode ter desativado o plugin.
- **Seu endereço é recusado.** O plugin de Mail pede um endereço @icloud.com, @me.com ou @mac.com. Se você só usa um domínio próprio pelo iCloud+, informe o endereço do iCloud da mesma Conta Apple.
- **Você trocou a senha da Conta Apple.** A Apple revoga todas as senhas específicas de app quando você altera ou redefine a senha, e o mesmo acontece com **Revogar Todas**. Crie uma nova senha específica de app e reconecte.
- **A mensagem está no Gmail ou no Outlook, não no iCloud.** Veja a próxima seção.

## Por que suas outras contas do Apple Mail não aparecem

O app Mail do iPhone ou do Mac mostra todas as contas que você adicionou a ele em uma só lista. O ChatGPT não lê o app Mail. O plugin entra direto nos servidores de e-mail do iCloud da Apple, então enxerga a caixa do iCloud e nada mais. Uma conta do Gmail, do Outlook.com, do Yahoo ou do trabalho que fica ao lado do iCloud no Apple Mail é invisível para ele.

Para Gmail e Outlook, o ChatGPT tem plugins separados que você também pode conectar. Dois poréns:

- **Yahoo, AOL, Fastmail, Zoho e caixas de empresa em IMAP (UOL, Locaweb, KingHost, Hostinger) não têm plugin no ChatGPT.** [Yahoo Mail no ChatGPT e no Claude](/blog/connect-yahoo-mail-to-chatgpt-and-claude) cobre esse caso.
- **Um endereço pessoal do Outlook.com ou do Hotmail** pode ser recusado pelo plugin do Outlook no ChatGPT. [Como conectar o ChatGPT ao Outlook.com e ao Hotmail](/blog/connect-chatgpt-to-outlook-com-hotmail) explica o motivo e o que funciona no lugar.

Cada plugin é uma conexão própria, com login próprio, e é preciso dizer ao ChatGPT qual deles usar.

## iCloud Mail no Claude

O Claude tem dois conectores de e-mail próprios, um para o Gmail e outro para contas corporativas do Microsoft 365. Não há opção de iCloud no Claude. A Apple até permite que um app de terceiros compatível autorize o iCloud Mail com a Conta Apple em vez de uma senha específica de app, mas o Claude não tem um conector assim, e o MCPEmails conecta o iCloud com uma senha específica de app via IMAP. [O Claude pode ler meus e-mails?](/blog/can-claude-read-my-email) percorre as opções do Claude caixa por caixa.

Para usar o iCloud no Claude, você adiciona um servidor MCP que guarda a conexão com o iCloud, e é isso que o MCPEmails é. Ele se conecta ao iCloud do mesmo jeito que o plugin da OpenAI, com uma senha específica de app via IMAP, e depois serve a caixa a qualquer app que fale o Model Context Protocol: Claude, ChatGPT, Cursor e os outros [clientes compatíveis](/docs/clients).

1. [Crie uma conta gratuita no MCPEmails](/signup). O plano gratuito conecta uma caixa de entrada.
2. No painel, abra **Caixas de entrada**, clique em **Conectar caixa de entrada**, escolha **iCloud Mail** e cole seu endereço do iCloud com uma senha específica de app nova. A [página de configurações do iCloud](/connect/icloud) tem os dados do servidor e as particularidades da Apple com o nome de usuário.
3. No Claude, abra **Personalizar**, depois **Conectores**, clique em **+ Adicionar**, escolha **Adicionar conector personalizado** e cole \`https://mcpemails.com/api/mcp\`. A [página de configuração do Claude](/docs/claude) tem o caminho completo de cliques.

O Claude então consegue ler, pesquisar, enviar, responder, agendar e organizar seus e-mails do iCloud, inclusive mover mensagens entre pastas.

## Quando o plugin basta, e quando não basta

Use o plugin da OpenAI se o iCloud é sua única caixa e o ChatGPT é seu único app de IA. Ele é gratuito em todos os planos e leva dois minutos.

O MCPEmails vale a pena quando:

- **Você usa o Claude**, ou alterna entre Claude, ChatGPT e uma ferramenta de código, e quer a mesma caixa em cada um.
- **Você tem mais de uma caixa de correio.** Conecte iCloud, Gmail, Yahoo, Outlook.com e caixas IMAP da empresa a uma conta, e todo cliente vê todas elas por uma única URL. [Várias contas de e-mail no Claude e no ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) mostra como o agente as mantém separadas.
- **Você quer arquivar e limpar e-mails**, não só ler: pastas, movimentações, arquivamento, envios agendados e regras permanentes.

No ChatGPT, o MCPEmails é adicionado como servidor MCP personalizado, o que a OpenAI lista para Business e Enterprise/Edu no chatgpt.com, com ferramentas de leitura e busca apenas no Pro, e não no Free. A [página de configuração do ChatGPT](/docs/chatgpt) traz os passos.

Seus e-mails nunca ficam armazenados no MCPEmails. Cada mensagem é buscada ao vivo na Apple quando o agente pede, e só a senha específica de app criptografada fica guardada. Revogar essa senha na Apple desconecta a caixa na hora.

## Perguntas frequentes

**O ChatGPT consegue ler meu e-mail do iCloud?**
Sim. Conecte o plugin do iCloud Mail em Configurações, Plugins, com seu endereço do iCloud e uma senha específica de app da Apple. A OpenAI diz que o recurso está sendo liberado para todos os planos do ChatGPT na web, no desktop e no iOS.

**O plugin do iCloud no ChatGPT vê minhas contas do Gmail ou do Outlook no Apple Mail?**
Não. Ele entra nos servidores de e-mail do iCloud, não no app Mail, então só vê e-mails guardados no iCloud. Conecte as outras contas com o plugin de cada uma, ou por um servidor MCP como o MCPEmails.

**Por que o ChatGPT rejeita minha senha da Apple?**
Porque o plugin da OpenAI usa uma senha específica de app, não a senha da sua Conta Apple. A Apple só deixa apps de terceiros compatíveis entrarem com a própria Conta Apple; os demais, inclusive este plugin e o MCPEmails, usam uma senha específica de app. Crie uma em account.apple.com, em Início de sessão e segurança, Senhas específicas de apps. A autenticação de dois fatores precisa estar ativada.

**O Claude tem conector para o iCloud?**
Não. Os conectores de e-mail próprios do Claude cobrem o Gmail e contas corporativas do Microsoft 365. Adicione o iCloud ao Claude como conector personalizado por um servidor MCP: conecte a caixa ao MCPEmails com uma senha específica de app e cole \`https://mcpemails.com/api/mcp\` no Claude.

**Como desconecto o iCloud do ChatGPT por completo?**
Desconecte o plugin nas configurações do ChatGPT e depois remova a senha específica de app em account.apple.com. Desconectar só no ChatGPT deixa a senha válida na Apple.

## Próximo passo

Se o iCloud no ChatGPT é tudo o que você precisa, o plugin resolve. Para ter a mesma caixa do iCloud no Claude, ou ao lado das suas outras caixas, [comece grátis](/signup), conecte o iCloud com uma senha específica de app e cole uma URL no seu app de IA. O [guia de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) detalha a etapa da senha.`,
};

export default translation;
