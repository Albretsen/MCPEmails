const translation = {
  title: 'Conector IMAP para o Claude: como conectar qualquer e-mail IMAP ao Claude',
  description:
    'Configure um conector IMAP para o Claude com qualquer caixa de e-mail que tenha IMAP/SMTP: servidores, senhas de app, portas TLS, segurança, limitações e solução de problemas.',
  coverAlt: 'Claude conectado a uma caixa de e-mail IMAP e SMTP por meio do MCPEmails',
  content: `Um **conector IMAP para o Claude** permite que o Claude trabalhe com caixas de e-mail que não têm integração nativa com o Claude: Fastmail, iCloud Mail, Yahoo, Zoho, Yandex, um e-mail no seu próprio domínio ou praticamente qualquer provedor que ofereça IMAP e SMTP.

O Claude não faz login no servidor de e-mail nem lida diretamente com a senha da sua caixa. O MCPEmails fica no meio. Ele se conecta ao provedor por IMAP para os e-mails recebidos e por SMTP para os enviados, e apresenta ao Claude um conjunto consistente de ferramentas do [Model Context Protocol](https://modelcontextprotocol.io). Essa distinção importa: IMAP e SMTP cuidam da caixa de e-mail, enquanto o MCP dá ao Claude ações seguras e estruturadas, como ler, buscar, responder e mover.

Este guia cobre o conector genérico e a configuração do lado do Claude. Se você usa iCloud ou Fastmail e quer as telas exatas de senha de app e os nomes de servidor, deixe o [guia específico para iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) aberto ao lado.

## O que o conector IMAP do Claude faz de verdade

A conexão tem três partes:

1. **Seu provedor de e-mail** oferece IMAP para ler e organizar mensagens, e SMTP para enviar.
2. **O MCPEmails** guarda a credencial de e-mail criptografada, conversa com esses servidores e transforma as respostas deles em ferramentas de e-mail previsíveis.
3. **O Claude** se conecta ao endpoint MCP e chama apenas as ferramentas permitidas pelos escopos que você aprovou.

Por isso o Claude nunca precisa de uma biblioteca IMAP, de uma configuração SMTP ou de uma senha no prompt. Depois de conectado, ele usa \`inbox_list\` para descobrir a caixa de e-mail, \`email_read\` para listar, ler, buscar ou baixar anexos, \`email_compose\` para enviar, responder e encaminhar, e \`email_organize\` para mover, copiar, marcar ou arquivar mensagens. Ferramentas separadas cobrem pastas, rascunhos, agendamento, contatos e exclusão; a lista completa está na [referência de ferramentas](/docs#tools).

## O que você precisa antes de configurar

Reúna estes valores na página de ajuda do seu provedor de e-mail ou com o administrador. Você também pode consultar as [configurações IMAP e SMTP verificadas de cada provedor](/connect):

- **Endereço de e-mail:** por exemplo, \`you@example.com\`. É o endereço mostrado na caixa de entrada conectada.
- **Nome de usuário de login:** normalmente o endereço de e-mail completo. Alguns provedores de domínio próprio usam um nome de usuário IMAP/SMTP diferente.
- **Host e porta IMAP:** por exemplo, \`imap.example.com\` na porta \`993\` para IMAP com TLS implícito. Essa conexão cuida de leitura, busca, pastas e ações nas mensagens.
- **Host e porta SMTP:** por exemplo, \`smtp.example.com\` na porta \`465\` ou \`587\`. A porta \`465\` usa TLS implícito; a \`587\` faz o upgrade com STARTTLS. Essa conexão cuida de enviar, responder e encaminhar.
- **Senha:** de preferência uma senha de app revogável, criada para acesso por clientes de e-mail.

Não tente adivinhar os nomes dos servidores a partir do domínio se o provedor publica as configurações. A hospedagem de e-mail costuma ser separada da hospedagem do site, e um endereço em domínio próprio pode usar um login específico do provedor, diferente do endereço visível.

Use uma **senha de app** sempre que o provedor oferecer uma. Ela é separada da senha principal da conta e pode ser revogada sem mudar a senha que você usa para entrar. Os provedores geralmente exigem a verificação em duas etapas antes de deixar você criar uma. Alguns também exigem que você ative o acesso IMAP nas configurações de e-mail primeiro.

O MCPEmails inclui predefinições para [iCloud](/connect/icloud), [Yahoo](/connect/yahoo), [Zoho](/connect/zoho) e [Yandex](/connect/yandex), além de um fluxo próprio de senha de app para o [Fastmail](/connect/fastmail). Essas opções preenchem os hosts e portas conhecidos para você. Escolha **Generic IMAP** (IMAP genérico) para outro provedor ou para o seu próprio servidor de e-mail e informe os valores você mesmo. Veja a [página de configuração de IMAP genérico](/connect/imap).

## Passo 1: conectar a caixa de e-mail IMAP/SMTP

1. [Crie sua conta no MCPEmails ou faça login](/signup) e abra **Painel → Caixas de entrada → Conectar caixa de entrada**.
2. Selecione o provedor pelo nome quando ele estiver na lista. Caso contrário, selecione **IMAP / SMTP**.
3. Informe o endereço de e-mail e a senha de app. No conector genérico, informe também o host e a porta IMAP, o host e a porta SMTP e um nome de usuário de login separado, se o seu provedor tiver dado um.
4. Salve a conexão. O MCPEmails valida a credencial no servidor IMAP antes de guardar a caixa de entrada, então um login recusado ou um endpoint TLS inacessível falha aqui, e não depois, dentro do Claude.

Os padrões seguros habituais são IMAP \`993\` e SMTP \`465\` ou \`587\`. Eles não são intercambiáveis: use a porta e o modo de segurança documentados pelo provedor. O MCPEmails trata a porta SMTP \`587\` como STARTTLS e as outras portas SMTP configuradas como TLS implícito. Conexões sem suporte a TLS são recusadas.

## Passo 2: adicionar o MCPEmails como conector no Claude

Com a caixa de e-mail conectada, aponte o Claude para o MCPEmails:

1. No claude.ai, abra **Personalizar → Conectores**.
2. Escolha **Add connector** (Adicionar conector) e informe \`https://www.mcpemails.com/api/mcp\`.
3. Selecione **Conectar**, faça login no MCPEmails e aprove apenas as permissões que o fluxo de trabalho precisa.

Por exemplo, um resumidor precisa de acesso de leitura e busca, mas não de envio ou exclusão. Um fluxo de resposta precisa de acesso de envio. O gerenciamento de pastas e a exclusão permanente têm escopos próprios, então você pode manter as ações destrutivas indisponíveis até que sejam realmente úteis. Veja o [passo a passo de conexão do Claude ao e-mail](/blog/connect-claude-to-email) para o fluxo do lado do cliente em mais detalhes.

Depois, faça um teste rápido:

\`\`\`
Use inbox_list para encontrar minha caixa de entrada IMAP. Liste minhas cinco mensagens não lidas mais recentes e resuma cada uma. Não envie, mova nem exclua nada.
\`\`\`

Começar com \`inbox_list\` permite que o Claude obtenha o \`inbox_id\` correto em vez de depender de um UUID copiado.

## O que o Claude consegue fazer por IMAP

Quando a conexão funciona, o Claude consegue:

- Listar e ler mensagens buscadas ao vivo no provedor.
- Buscar por remetente, destinatário, assunto, texto do corpo, status de leitura, marcação e datas.
- Baixar ou extrair anexos compatíveis dentro dos limites documentados de tamanho e formato.
- Enviar novas mensagens por SMTP, ou responder e encaminhar preservando o contexto relevante da mensagem.
- Mover, copiar, marcar, arquivar e organizar e-mails em pastas IMAP.
- Criar e gerenciar rascunhos, agendar mensagens e buscar contatos onde a ferramenta oferece a operação.
- Mover e-mails para a Lixeira ou, com permissão explícita de exclusão e \`permanent: true\`, apagá-los permanentemente no IMAP.

Essa última capacidade merece cuidado. A exclusão permanente por IMAP pula a Lixeira e pode ser irreversível. O MCPEmails expõe a exclusão como uma ferramenta destrutiva separada, e o cliente MCP controla o comportamento de confirmação, mas mesmo assim conceda \`delete:email\` apenas aos fluxos que precisam dele.

## Limitações importantes do IMAP

Um conector IMAP é abrangente, mas não torna todos os provedores iguais.

- **Sem push de e-mails recebidos no Claude:** as ferramentas MCP funcionam por requisição e resposta, então nada aciona o Claude quando uma mensagem chega. Um fluxo baseado em chat consulta em intervalos, por exemplo listando os e-mails não lidos. O seu próprio código pode, em vez disso, ser acordado por um webhook de e-mail novo, que os espaços de trabalho Pro e Business adicionam em Chaves de API.
- **A busca varia conforme o transporte:** filtros estruturados de remetente, assunto, texto e data funcionam em todos os provedores, mas o IMAP genérico não suporta o filtro de busca \`has_attachment\`. A sintaxe de busca nativa de cada provedor não é portável.
- **Pastas não são marcadores do Gmail:** o IMAP move uma mensagem entre pastas, enquanto o Gmail pode aplicar vários marcadores a uma mesma mensagem. A diferença prática está explicada em [marcadores do Gmail vs. pastas IMAP](/blog/gmail-labels-vs-imap-folders-ai-agents).
- **Enviar exige SMTP:** um login IMAP que funciona prova que o Claude alcança os e-mails recebidos, não que o host, a porta ou a permissão de envio SMTP estão corretos. Teste uma mensagem inofensiva de saída antes de confiar em um fluxo de resposta.
- **As políticas do provedor continuam valendo:** cotas da caixa, limites de envio, limites de conexões simultâneas, controles de spam e restrições do administrador permanecem em vigor.

## Solução de problemas em uma conexão IMAP do Claude

### “Authentication failed” ao conectar a caixa de entrada

Use uma senha de app, não a senha que você usa no site do provedor. Confirme que a verificação em duas etapas e o acesso IMAP estão ativados, se o provedor exigir. Copie de novo a senha gerada, sem espaços no início ou no fim. Se o endereço está em domínio próprio, verifique se o nome de usuário de login é o e-mail completo ou um nome de conta separado.

### O servidor não responde ou o TLS falha

Confira a grafia do host e use as portas seguras documentadas pelo provedor. Comece com IMAP \`993\`; para SMTP, use a porta documentada \`465\` ou \`587\`. O hostname do site, o hostname do painel de controle ou o domínio puro não são necessariamente um servidor de e-mail. Em um servidor próprio, confirme também que o firewall aceita conexões de fora da sua rede e que o certificado TLS corresponde ao hostname de e-mail.

### O Claude lê, mas não consegue enviar

As configurações IMAP estão funcionando, mas o SMTP é separado. Confira de novo o hostname e a porta SMTP, confirme que a credencial tem acesso SMTP ou de “mail” e verifique se o provedor permite envio autenticado para o endereço de remetente. As senhas de app do Fastmail, por exemplo, devem ser criadas com acesso **Mail (IMAP/SMTP)**, e não com acesso somente leitura.

### O Claude não encontra a caixa de e-mail

Peça ao Claude para chamar \`inbox_list\` de novo. Se a caixa de entrada não aparecer, verifique o status dela no painel do MCPEmails e reconecte se a senha de app foi revogada ou trocada. Se a caixa aparecer mas uma ação for negada, reconecte o conector do Claude ou atualize a chave de API com o escopo necessário.

### Os resultados da busca são mais restritos que o esperado

Comece com campos estruturados como \`from\`, \`subject\`, \`text\`, \`since\` e \`before\`, e especifique quais pastas buscar quando for preciso. Não copie a sintaxe de operadores do Gmail para uma busca IMAP genérica esperando o mesmo comportamento. Lembre que o filtro por presença de anexo é ignorado no IMAP genérico.

## Segurança: as credenciais ficam fora do Claude

O MCPEmails guarda o token OAuth ou a senha de app IMAP necessários para as chamadas futuras, criptografados em repouso com AES-256-GCM. O conteúdo comum da caixa de e-mail é buscado ao vivo quando uma ferramenta roda e não é mantido entre as chamadas. O tráfego usa TLS, e você pode revogar uma senha de app no provedor ou desconectar a caixa de entrada pelo painel.

Esse limite claro é o principal motivo para usar uma ponte MCP em vez de colar credenciais de e-mail em um chat ou em uma configuração local: o Claude recebe capacidades de e-mail com escopo definido, não as chaves da caixa. Para os detalhes de armazenamento e modelo de ameaças, leia [por que “o e-mail nunca é armazenado” importa](/blog/why-email-never-stored-matters) e a [visão geral de segurança](/security).

## Resumindo

Um conector IMAP para o Claude é uma conexão IMAP/SMTP com uma caixa de e-mail, apresentada ao Claude como ferramentas MCP. Reúna as configurações seguras do servidor, crie uma senha de app revogável, conecte a caixa de entrada no MCPEmails e adicione \`https://www.mcpemails.com/api/mcp\` no Claude. Teste primeiro o acesso somente leitura, adicione escopos de envio ou destrutivos de forma consciente e use a lista de solução de problemas acima se o provedor recusar a conexão.

Quer testar? [Conecte uma caixa de entrada IMAP](/signup) ou use o [guia de configuração por provedor](/blog/connect-icloud-fastmail-imap-to-claude) para os detalhes de iCloud e Fastmail.`,
};

export default translation;
