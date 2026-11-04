const translation = {
  title: 'O que é senha de app? Onde criar uma em cada provedor de e-mail',
  description:
    'O que é uma senha de app, por que apps de e-mail e conectores de IA precisam de uma, onde criá-la no Gmail, iCloud, Yahoo, AOL, Fastmail e Zoho, e como revogá-la.',
  coverAlt: 'Uma senha de app conectando uma caixa de entrada a um agente de IA pelo MCPEmails',
  content: `Uma **senha de app** é uma senha separada que o seu provedor de e-mail gera para um único app, para que esse app possa entrar na sua caixa de correio sem a senha real da sua conta. Você a cria nas configurações de segurança da conta, cola uma vez no app de e-mail ou no conector e a exclui quando quiser cortar o acesso daquele app. Sua senha normal, e todos os outros apps, continuam funcionando.

Se você está conectando uma caixa ao Thunderbird, ao Apple Mail ou a um agente de IA por meio de um servidor MCP como o MCPEmails, uma senha de app ausente ou errada é o motivo mais comum de falha no login. Este guia explica o que é uma senha de app, por que clientes IMAP precisam de uma, onde cada grande provedor a gera e como revogá-la.

**Ir para:** [Onde criar](#onde-criar-uma-senha-de-app-em-cada-provedor) · [Como revogar](#como-revogar-uma-senha-de-app) · [Notas de segurança](#notas-de-segurança) · [Perguntas frequentes](#perguntas-frequentes)

## O que é uma senha de app?

Uma senha de app é uma credencial longa, gerada aleatoriamente, ligada à sua conta de e-mail, mas emitida para um único aplicativo. Três coisas a diferenciam da senha que você digita no webmail:

- **O provedor a gera.** Você não escolhe. O Google gera um código de 16 caracteres, a Apple mostra uma no formato \`abcd-efgh-ijkl-mnop\`, e a maioria dos provedores a mostra uma única vez.
- **Ela substitui sua senha onde não dá para pedir um segundo fator.** Apps de e-mail se conectam via IMAP (leitura) e SMTP (envio), e esses protocolos não conseguem mostrar uma solicitação de autenticação de dois fatores. A senha de app é a forma que o provedor encontrou de deixar esse tipo de cliente entrar sem enfraquecer o login na web.
- **Ela pode ser revogada sozinha.** Exclua a senha e só o app que a usava perde o acesso. Nada mais muda na conta.

O Google a descreve como uma senha de 16 dígitos que autoriza um app ou dispositivo a acessar sua Conta do Google (na prática, o código tem 16 letras). A Apple chama a mesma ideia de **senha específica de app**, o Zoho de **application-specific password**, o GMX e o WEB.DE de **App-Passwort**. Todos significam a mesma coisa.

## Por que clientes IMAP e conectores de IA precisam de uma

Muitos provedores de e-mail não aceitam mais sua senha normal vinda de um app de e-mail de terceiros, especialmente depois que a autenticação de dois fatores é ativada. Um app de e-mail para desktop, o app de e-mail nativo do celular ou um servidor que lê e-mails em seu nome falam IMAP e SMTP, e no Google, na Apple, no Yahoo, na AOL, no Fastmail e no Yandex a credencial que esses protocolos aceitam é uma senha de app.

Um conector de IA está exatamente na mesma situação. Quando o Claude ou o ChatGPT trabalha com sua caixa de entrada por meio de [um servidor MCP de e-mail](/blog/what-is-an-mcp-email-server), não é a IA que entra na sua caixa. Quem entra é o servidor MCP, via IMAP e SMTP, do mesmo jeito que o Thunderbird faria. Então, para iCloud, Yahoo, AOL, Fastmail, Gmail e provedores parecidos, o servidor precisa de uma senha de app, e o cliente de IA recebe só um token com escopo limitado para o servidor. O [guia de OAuth e chaves de API para acesso ao e-mail](/blog/oauth-vs-api-keys-ai-email-access) trata dessa segunda camada.

O erro mais comum é colar a senha que você usa no site do provedor. É o principal motivo de um app de e-mail ou conector de IA não conseguir entrar. Senhas de app geradas têm um formato reconhecível, então o formulário de conexão do MCPEmails confere o que você cola para Gmail, iCloud, Yahoo, Yandex e Fastmail e avisa antes que a tentativa chegue ao provedor, que de outra forma a contaria como um login com falha. Se você tem certeza de que o valor está certo, clicar em **Conectar** de novo envia mesmo assim.

## Onde criar uma senha de app em cada provedor

Cada item abaixo diz onde fica o gerador e o que precisa estar ativado antes. A página de configuração de cada provedor, no link, traz as configurações IMAP e SMTP e o passo a passo completo.

- **Gmail e Google Workspace:** ative a **Verificação em duas etapas** e depois crie uma em \`myaccount.google.com/apppasswords\`. O código tem 16 letras, mostradas em quatro grupos; os espaços não importam. O Google lista três casos em que a opção não aparece: algumas contas de trabalho, escola ou outras organizações (no Workspace, isso é uma configuração do seu administrador), a **Proteção Avançada** e a verificação em duas etapas configurada só com chaves de segurança. Configuração: [Gmail](/connect/gmail), [Google Workspace](/connect/google-workspace).
- **iCloud Mail:** a autenticação de dois fatores é obrigatória. Em \`account.apple.com\`, abra **Início de sessão e segurança**, depois **Senhas específicas de apps**, e gere uma. Você pode ter até 25 ativas ao mesmo tempo. Configuração: [iCloud Mail](/connect/icloud).
- **Yahoo Mail:** na página **Segurança da conta** do Yahoo, em **Conexões externas**, escolha **Criar senha de aplicativo**, dê um nome e gere. Configuração: [Yahoo Mail](/connect/yahoo), e [como usar o Yahoo Mail no ChatGPT e no Claude](/blog/connect-yahoo-mail-to-chatgpt-and-claude).
- **AOL Mail:** na página **Account Security** da AOL, escolha **Generate app password** (Gerar senha de app; algumas contas mostram **Generate and manage app passwords**), depois **Get Started** (Começar), dê um nome e gere. A AOL pede que você faça isso em um navegador que já usa para entrar no AOL Mail há vários dias, e não em uma janela anônima. Uma senha de app do Yahoo não abre uma caixa da AOL, mesmo que os dois rodem na mesma plataforma. Configuração: [AOL Mail](/connect/aol).
- **verizon.net:** a Verizon encerrou o serviço de e-mail, e as caixas verizon.net que restaram agora são contas AOL. Então você cria uma senha de app da **AOL** e entra com seu endereço verizon.net completo. Configuração: [verizon.net](/connect/verizon).
- **Fastmail:** vá em **Settings**, **Privacy & Security**, **Connected apps & API tokens**, **Manage app passwords and access**, **New app password** (Configurações, Privacidade e segurança, Apps conectados e tokens de API, Gerenciar senhas de app e acesso, Nova senha de app). Mantenha o nível de acesso padrão, **Mail, Contacts & Calendars**; uma senha só para Files não consegue entrar no e-mail. O Fastmail conecta apenas com senha de app, e o plano Basic do Fastmail não permite criar uma. Configuração: [Fastmail](/connect/fastmail).
- **Zoho Mail:** primeiro ative o **IMAP Access** no Zoho Mail, em **Settings**, **Mail Accounts**. Sem autenticação de dois fatores, sua senha do Zoho funciona; com autenticação de dois fatores, login federado (por exemplo, entrar com o Google) ou SAML, crie uma application-specific password na sua conta Zoho e use essa. Configuração: [Zoho Mail](/connect/zoho).
- **Yandex Mail:** ative o IMAP em **Mail clients** nas configurações do Yandex Mail e, na página de segurança em \`id.yandex.com\`, abra **App passwords** e crie uma para um cliente de e-mail. O Yandex a mostra uma vez. Configuração: [Yandex Mail](/connect/yandex).
- **GMX:** primeiro ative o acesso **POP3/IMAP** nas configurações de e-mail. Sem autenticação de dois fatores, sua senha normal do GMX funciona; com ela, crie um App-Passwort em **Account verwalten**, **Login & Sicherheit**, **App-Passwörter (für externe Apps)**, **Neues App-Passwort erstellen**. O GMX o mostra uma vez. Configuração: [GMX](/connect/gmx).
- **WEB.DE:** igual ao GMX: ative o acesso **POP3/IMAP** e crie um App-Passwort no mesmo lugar se a autenticação de dois fatores estiver ativa. Configuração: [WEB.DE](/connect/web-de).
- **Outlook.com, Hotmail e Live:** sem senha de app. A Microsoft diz que a Autenticação Básica, o login com senha do qual as senhas de app dependem, não está mais disponível para nenhuma conta do Outlook desde 16 de setembro de 2024, então uma senha de app não abre a caixa. O MCPEmails conecta essas contas com **Entrar com a Microsoft** pelo Microsoft Graph. Configuração: [Outlook.com](/connect/outlook); contas corporativas estão no [guia do Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Qualquer outro caso, como uma caixa na sua hospedagem ou no seu próprio domínio, segue o mesmo padrão: gere uma senha de app se o provedor oferecer, senão use a senha da caixa, e informe as configurações do servidor manualmente. A [página de IMAP genérico](/connect/imap) e a [lista completa de provedores](/connect) cobrem esses casos.

## Como criar uma e conectar sua caixa de entrada

Os passos são os mesmos em todo lugar, só mudam os nomes dos menus:

1. Ative a autenticação de dois fatores na conta de e-mail, se o provedor exigir.
2. Abra a página de senhas de app indicada acima, dê à senha o nome do app (por exemplo \`MCPEmails\`) e gere.
3. Copie na hora. A maioria dos provedores não a mostra de novo.
4. No MCPEmails, abra **Caixas de entrada**, depois **Conectar caixa de entrada**, escolha seu provedor e cole seu endereço de e-mail completo e a senha de app.
5. Adicione \`https://mcpemails.com/api/mcp\` ao seu cliente de IA. O [guia do Claude](/blog/connect-claude-to-email) e o [guia do ChatGPT](/blog/connect-chatgpt-to-email) mostram essa parte.

Se o login continuar sendo recusado, o [guia do conector IMAP](/blog/claude-imap-connector) lista as outras causas comuns: IMAP desativado, o servidor regional errado ou um nome de usuário que não é o endereço completo.

## Como revogar uma senha de app

Revogar é a forma de encerrar o acesso de um app sem mexer em mais nada. Exclua a senha no mesmo lugar em que você a criou:

- **Google:** \`myaccount.google.com/apppasswords\` e depois **Remover** ao lado do item. Alterar a senha da sua Conta do Google também revoga todas as senhas de app.
- **Apple:** **Início de sessão e segurança**, **Senhas específicas de apps**, e então remova uma ou use **Revogar Todas**. Alterar ou redefinir a senha da sua Conta Apple revoga todas automaticamente.
- **Yahoo e AOL:** a página de segurança da conta (**Segurança da conta**, **Conexões externas** no Yahoo; **Account Security**, **Generate and manage app passwords** na AOL) e depois **Delete** (Excluir) ao lado daquela senha de app. Aqui, alterar a senha principal **não** revoga as senhas de app, então excluir o item é a única forma de cortar o acesso de um cliente.
- **Fastmail, Zoho, Yandex, GMX, WEB.DE:** remova da mesma lista de senhas de app em que você a criou. No Yandex, sair em todos os dispositivos também redefine todas as senhas de app.

Do lado do MCPEmails, **Desconectar caixa de entrada** no painel apaga a senha de app armazenada junto com a conexão. Fazer as duas coisas é a forma limpa de encerrar uma integração: o provedor para de aceitar a senha, e o MCPEmails deixa de guardá-la.

## Notas de segurança

- **Crie uma por app.** Uma senha de app separada e com nome para cada cliente permite revogar uma sem quebrar as outras, e a lista na sua conta mostra quem ainda tem acesso.
- **Trate como uma senha.** Uma senha de app entra sem pedir seu segundo fator, e é justamente para isso que ela existe. Não cole em um chat com uma IA, em um documento compartilhado nem em um chamado de suporte. No MCPEmails, ela vai só no formulário de conexão.
- **Normalmente dá acesso total ao e-mail.** Na maioria dos provedores, uma senha de app pode ler, enviar e excluir e-mails, não apenas parte disso. Restrinja o que a sua IA pode fazer no conector: o MCPEmails permite aprovar \`read:email\` sem \`send:email\`, e o [guia de segurança do acesso ao e-mail](/blog/is-it-safe-to-give-ai-agent-email-access) mostra como revisar os envios.
- **Saiba onde ela fica guardada.** O MCPEmails mantém a senha de app criptografada com AES-256-GCM, só a descriptografa no servidor para acessar seu provedor e nunca a repassa ao cliente de IA. Suas mensagens são buscadas ao vivo e não ficam armazenadas. [Por que isso importa](/blog/why-email-never-stored-matters).
- **O Google recomenda o Sign in with Google (Fazer login com o Google) onde o app oferecer.** O Google diz que senhas de app não são recomendadas e são desnecessárias na maioria dos casos. Elas existem para apps que não conseguem usar esse login, o que inclui clientes IMAP que só aceitam senha.

## Perguntas frequentes

**O que é uma senha de app?**
Uma senha de app é uma senha gerada aleatoriamente que o seu provedor de e-mail emite para um único app ou dispositivo, como um app de e-mail ou um conector de e-mail com IA. Ela permite que esse app entre via IMAP e SMTP sem a sua senha principal, e você pode excluí-la a qualquer momento para revogar só aquele app.

**A senha de app é a mesma coisa que a senha do meu e-mail?**
Não. A senha do seu e-mail é a que você escolheu e digita no webmail. Uma senha de app é gerada pelo provedor, usada por um único app, e na maioria dos provedores sua senha normal não funciona no lugar dela.

**Por que preciso de uma senha de app para conectar o e-mail a um agente de IA?**
Porque o servidor MCP que dá acesso à IA entra na sua caixa via IMAP e SMTP, como qualquer app de e-mail, e a maioria dos provedores só aceita uma senha de app nesse caso. O Outlook.com é a principal exceção: ele conecta com Entrar com a Microsoft.

**A senha de app expira?**
Ela para de funcionar quando você a exclui. O Google e a Apple também revogam todas as senhas de app quando você altera a senha principal da conta, enquanto no Yahoo e na AOL elas continuam válidas depois de uma troca de senha, até você excluí-las.

**Perdi minha senha de app. Consigo vê-la de novo?**
Não. A maioria dos provedores a mostra uma única vez. Exclua a antiga, gere uma nova e cole a nova no app. No MCPEmails, abra a caixa e escolha **Reconectar**.

## Próximo passo

[Crie uma conta grátis no MCPEmails](/signup), gere uma senha de app no seu provedor e conecte a caixa. A [matriz de provedores](/docs/providers) mostra o que cada provedor oferece depois de conectado.`,
};

export default translation;
