const translation = {
  title: 'Como conectar o Claude ao Apple Mail: iCloud, Gmail, Outlook, Yahoo',
  description:
    'Conecte o Claude às contas do Apple Mail (iCloud, Gmail, Outlook.com, Yahoo, IMAP) para ler, pesquisar, escrever rascunhos e enviar e-mails de qualquer dispositivo, inclusive do iPhone.',
  coverAlt: 'As contas do iCloud, Gmail, Outlook e Yahoo do Apple Mail conectadas ao Claude via MCP',
  content: `Para conectar o Claude ao Apple Mail, você conecta as contas de e-mail que o Apple Mail mostra, e não o app Mail em si. O Apple Mail é um cliente: ele sincroniza uma conta do iCloud, Gmail, Outlook.com, Yahoo ou outra conta IMAP a partir dos servidores do provedor. O MCPEmails conecta o Claude a essas mesmas contas do lado do servidor, então o Claude vê a mesma caixa de entrada, as mesmas pastas, rascunhos e e-mails enviados que o Apple Mail, e funciona no claude.ai, no Claude Desktop e no app Claude do seu iPhone. Seu Mac não precisa estar ligado.

## O Claude consegue se conectar ao Apple Mail?

Sim, pelas contas que estão nele. O Apple Mail não tem uma conexão própria em que o Claude possa entrar, então o caminho confiável é:

1. Ver quais contas o Apple Mail usa.
2. Conectar cada conta ao MCPEmails, um servidor MCP hospedado.
3. Adicionar o MCPEmails ao Claude como conector personalizado, com uma única URL.

Depois disso, o Claude pode ler, pesquisar, escrever rascunhos, enviar, agendar e organizar e-mails em todas as contas conectadas, dentro do acesso que você conceder. As alterações aparecem no Apple Mail do Mac e do iPhone na próxima sincronização, porque os dois olham para a mesma caixa de correio.

## Por que conectar a conta e não o app Mail

Os servidores MCP para Apple Mail que você encontra no GitHub rodam no seu Mac e funcionam pelo próprio app Mail, com AppleScript ou lendo o índice local do Mail. Isso funciona, com limites que vêm do próprio desenho:

- Só roda em um Mac, com o servidor instalado e o Mail disponível.
- O Claude no iPhone, em um PC com Windows ou na web não consegue alcançá-lo, porque a conexão fica naquele único Mac.
- Se o Mac estiver em repouso ou fechado, o servidor fica inacessível.

Um conector personalizado no Claude funciona ao contrário. A central de ajuda da Anthropic diz que a conexão com um servidor MCP parte dos servidores da Anthropic, não do seu dispositivo, em todos os clientes do Claude, incluindo os apps para celular. Uma conexão do lado do servidor com a sua conta de e-mail se encaixa nesse modelo: não há nada para instalar, e o mesmo conector funciona onde quer que você abra o Claude.

## Passo 1: veja quais contas o Apple Mail usa

- **No Mac:** no Mail, escolha **Mail → Settings** (Mail → Ajustes) e clique em **Accounts** (Contas).
- **No iPhone ou iPad:** abra **Settings → Apps → Mail → Mail Accounts** (Ajustes → Apps → Mail → Contas de e-mail).

Cada conta dessa lista se conecta ao MCPEmails de uma destas formas:

- **iCloud** (@icloud.com, @me.com, @mac.com): uma senha específica de app da Apple. Configurações na [página do iCloud](/connect/icloud).
- **Google**: uma senha de app do Google. Configurações na [página do Gmail](/connect/gmail).
- **Outlook.com, Hotmail, Live ou Microsoft 365**: Entrar com a Microsoft. Uma conta corporativa ou educacional pode precisar que o administrador de TI aprove o MCPEmails uma vez. Detalhes na [página do Outlook](/connect/outlook).
- **Yahoo**: uma senha de app do Yahoo. Configurações na [página do Yahoo Mail](/connect/yahoo).
- **Outra (IMAP)**: as configurações IMAP e SMTP do seu provedor. Veja a [página de IMAP personalizado](/connect/imap).

Se o seu provedor não está nessa lista, [cada provedor compatível](/connect) tem a própria página com as configurações do servidor.

## Passo 2: conecte cada conta ao MCPEmails

Crie uma [conta grátis no MCPEmails](/signup), abra o painel, vá em **Caixas de entrada → Conectar caixa de entrada** e escolha o provedor.

### iCloud Mail

A Apple não aceita a senha da sua Conta Apple vinda de outros apps. Você precisa de uma senha específica de app:

1. Entre em [account.apple.com](https://account.apple.com).
2. Em **Início de sessão e segurança**, selecione **Senhas específicas de apps**.
3. Selecione **Generate an app-specific password** (Gerar uma senha específica de app), dê o nome \`MCPEmails\` e copie a senha que a Apple mostrar.
4. No MCPEmails, escolha **iCloud**, informe seu endereço do iCloud e cole essa senha.

Sua Conta Apple precisa ter autenticação de dois fatores para isso. Um detalhe importante: alterar a senha da Conta Apple revoga todas as senhas específicas de app, então depois de uma troca de senha você gera uma nova e reconecta. O [guia de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) traz mais detalhes.

### Gmail

O Apple Mail entra no Google com a sua conta Google. O MCPEmails usa uma senha de app do Google via IMAP, que o Google oferece quando a verificação em duas etapas está ativada. Escolha **Gmail** e cole a senha de 16 letras junto com seu endereço. O [guia do Gmail](/blog/connect-gmail-to-claude) trata das contas do Workspace em que um administrador desativou as senhas de app.

### Outlook.com, Hotmail e Microsoft 365

Escolha **Outlook** e clique em **Conectar com a Microsoft**. Não há senha para colar.

### Yahoo e outras contas IMAP

Crie uma senha de app no seu provedor, escolha **Yahoo** ou **IMAP / SMTP** e informe o endereço e a senha. Os provedores mais comuns preenchem as configurações do servidor a partir do endereço.

Conecte cada conta do Apple Mail que o Claude deve alcançar; quantas caixas você pode adicionar depende do seu [plano](/pricing). O Claude as encontra com \`inbox_list\`, então você nunca cola um ID de conta em um prompt.

## Passo 3: adicione o MCPEmails ao Claude

No claude.ai ou no Claude Desktop:

1. Abra **Personalizar → Conectores**.
2. Clique em **+ Adicionar** e depois em **Adicionar conector personalizado**.
3. Informe um nome como \`MCPEmails\` e cole a URL do conector:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Siga as telas e clique em **Adicionar**. Depois clique em **Conectar**, entre no MCPEmails e escolha o quanto o Claude pode fazer: **Somente leitura**, **Padrão** (inclui envio, rascunhos e contatos), **Acesso total** (inclui pastas, agendamento e exclusão) ou **Personalizado**.

Não há chave de API nem arquivo de configuração. Em um plano Team ou Enterprise, um owner adiciona primeiro o conector em **Configurações da organização → Conectores**, e os membros depois clicam em **Conectar** nele. A [página de configuração do Claude](/docs/claude) explica cada passo e os erros mais comuns.

### Usando no iPhone

A central de ajuda da Anthropic diz que um conector adicionado no claude.ai ou no Claude Desktop fica disponível na próxima vez que você entrar no app Claude para iOS ou Android. Adicione uma vez na web e depois pergunte ao Claude sobre seus e-mails pelo celular. O app Mail do iPhone não precisa estar aberto, e seu Mac não precisa estar ligado.

## O que o Claude vê, e o que não vê

O Claude trabalha com a cópia de cada conta que fica no servidor, que é a cópia que o Apple Mail sincroniza. Isso significa:

- **As pastas que você criou na conta ficam visíveis.** Uma caixa que você criou dentro da conta do iCloud ou do Gmail fica no servidor, então o Claude pode listá-la, pesquisá-la e mover e-mails para ela, se você concedeu acesso às pastas.
- **Os rascunhos aparecem no Apple Mail.** Quando o Claude salva um rascunho, ele vai para a pasta Rascunhos daquela conta, então você pode abri-lo no Apple Mail, editar e enviar você mesmo.
- **Os e-mails enviados ficam arquivados.** Uma mensagem que o Claude envia é salva na pasta Enviados da conta, como uma enviada pelo Apple Mail. Se um servidor de e-mail recusar essa cópia, o resultado do Claude informa.
- **As caixas "No Meu Mac" não ficam visíveis.** A Apple as guarda só no Mac em que você as criou, então nenhuma conexão com o servidor consegue vê-las. Mova o que o Claude precisa encontrar para uma caixa dentro da conta.
- **Contas POP podem estar incompletas.** Uma conta que o Apple Mail usa via POP pode ter removido e-mails antigos do servidor depois de baixá-los para o Mac. O MCPEmails conecta via IMAP, então o Claude só alcança o que ainda está no servidor.

Os e-mails são buscados ao vivo no seu provedor a cada solicitação e não são armazenados pelo MCPEmails. A única exceção é uma mensagem que você agenda para mais tarde, que fica guardada até ser enviada.

## Prompts para testar

Comece com algo somente leitura:

> Resuma meus e-mails não lidos de hoje no iCloud e no Gmail. Uma lista só, indicando de qual conta veio cada mensagem.

> Encontre a confirmação de voo que recebi no mês passado e me diga o código da reserva.

> Escreva um rascunho de resposta para a última mensagem do meu locador, mas não envie. Vou terminar no Apple Mail.

Para mais rotinas, veja [formas de deixar o Claude cuidar da sua caixa de entrada](/blog/best-ways-to-let-claude-manage-your-inbox) e o [roteiro de triagem da caixa de entrada](/blog/ai-agent-triage-summarize-inbox). Se você usa várias contas, [gerenciar várias contas de e-mail com IA](/blog/manage-multiple-email-accounts-with-ai) mostra como garantir que as respostas saiam do endereço certo.

## Conectando o ChatGPT às mesmas contas

A URL do conector é um servidor MCP padrão, então o ChatGPT pode alcançar as mesmas contas do Apple Mail. Você o adiciona no chatgpt.com como servidor MCP personalizado; a central de ajuda da OpenAI diz que essa etapa é só pela web. Quais planos e funções de workspace podem adicionar um muda com frequência, então a [página de configuração do ChatGPT](/docs/chatgpt) mantém os passos atuais, e o [guia de e-mail no ChatGPT](/blog/connect-chatgpt-to-email) trata dos erros mais comuns.

## Mantenha o controle

- **Conceda só o necessário.** Escolha **Somente leitura** na tela de consentimento se o Claude nunca deve enviar.
- **Revise os envios antes.** Ative **Revisar antes de enviar** para uma conta no painel, e todo envio dela espera sua aprovação. Veja [aprovação humana para envios de e-mail por IA](/blog/approve-ai-agent-email-sends).
- **Revogue quando quiser.** Remova a senha específica de app em account.apple.com ou revogue a conexão do Claude em **Chaves de API** no painel do MCPEmails.

Trate todo e-mail como texto não confiável: uma mensagem pode conter instruções dirigidas a uma IA. O [guia de segurança do acesso ao e-mail](/blog/is-it-safe-to-give-ai-agent-email-access) explica os riscos, e a página de [segurança](/security) mostra como as credenciais são criptografadas e onde os dados ficam armazenados.

## Perguntas frequentes

**Como conecto o Claude ao Apple Mail?**
Conecte as contas que o Apple Mail usa (iCloud, Gmail, Outlook.com, Yahoo ou IMAP) ao MCPEmails e depois adicione \`https://mcpemails.com/api/mcp\` como conector personalizado no Claude, em Personalizar, Conectores. O Claude passa a ler e enviar por essas contas, e os resultados aparecem no Apple Mail.

**Preciso de um Mac para isso?**
Não. Nada roda no seu Mac. O Claude alcança suas contas de e-mail pelo MCPEmails, então funciona no claude.ai, no Claude Desktop para Windows ou Mac e no app Claude para iPhone e Android.

**Funciona com o Apple Mail no iPhone?**
Sim. O app Mail do iPhone e o Claude trabalham nas mesmas contas. Adicione o conector uma vez no claude.ai e ele fica disponível no app Claude do iPhone na próxima vez que você entrar.

**Por que a senha da minha Conta Apple é recusada?**
O iCloud só aceita uma senha específica de app vinda de outros apps. Gere uma em account.apple.com, em Início de sessão e segurança, e cole essa senha no lugar.

**O Claude consegue ver minhas pastas No Meu Mac?**
Não. Essas caixas existem só no seu Mac. Mova as mensagens para uma caixa dentro da sua conta do iCloud ou de outro provedor, e o Claude poderá vê-las.

**Meus e-mails ficam armazenados?**
Não. Cada solicitação busca os e-mails ao vivo no seu provedor e os descarta. As exceções são as mensagens que você agenda, guardadas até serem enviadas, e a credencial criptografada de cada conta, que o MCPEmails mantém. O passo a passo completo para cada provedor está no [guia para conectar o Claude ao e-mail](/blog/connect-claude-to-email).

## Próximo passo

[Comece grátis](/signup), conecte sua conta do iCloud, adicione o conector no Claude e pergunte o que precisa de resposta hoje. Depois abra o Apple Mail e você verá a mesma caixa de entrada que o Claude acabou de ler.`,
};

export default translation;
