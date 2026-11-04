const translation = {
  title: 'Várias contas de e-mail no Claude e no ChatGPT: todas as caixas, um só conector',
  description:
    'Como usar várias contas de e-mail no Claude e no ChatGPT ao mesmo tempo, incluindo caixas da empresa na IONOS, Zoho, Namecheap, Google Workspace ou no seu próprio servidor, com um conector MCP que funciona nos dois.',
  coverAlt:
    'Várias contas de e-mail pessoais e de trabalho conectadas ao Claude e ao ChatGPT por meio de um único conector MCP',
  content: `Você quer fazer uma pergunta e receber a resposta de todas as caixas de e-mail que administra: seu próprio endereço, contato@, vendas@, a caixa de notas fiscais, talvez um Gmail pessoal. Este guia mostra como colocar várias contas de e-mail no Claude e no ChatGPT ao mesmo tempo, o que os conectores integrados já cobrem e onde você precisa de um servidor MCP no lugar deles.

**Ir para:** [Conectores integrados](#o-que-os-conectores-integrados-fazem) · [Um conector para todas as caixas](#um-conector-para-todas-as-caixas) · [Configuração no Claude](#adicionar-ao-claude) · [Configuração no ChatGPT](#adicionar-ao-chatgpt) · [Planos](#quantas-caixas-cada-plano-conecta)

## O que os conectores integrados fazem

Os dois assistentes trazem conectores de e-mail próprios, e eles mudaram rápido, então aqui está o cenário no momento em que este texto foi escrito (setembro de 2026).

- **ChatGPT.** Desde o fim de agosto de 2026, os plugins próprios de Gmail, Google Agenda e Contatos do Google aceitam mais de uma conta nos planos Plus, Pro, Business e Enterprise, então um Gmail pessoal e um de trabalho podem estar na mesma conversa. Em setembro, a OpenAI estendeu as múltiplas contas a outros plugins. Se todas as suas caixas de e-mail são contas Google, o plugin do próprio ChatGPT pode ser tudo de que você precisa.
- **Claude.** A central de ajuda da Anthropic descreve o conector do Gmail como alcançando "a conta Google que você conectou". Uma conta Google por conexão.

Nenhum dos dois foi feito para a caixa de e-mail que uma empresa realmente usa no próprio domínio quando esse domínio não está no Google nem na Microsoft: IONOS, Zoho Mail, Namecheap Private Email, STRATO, Migadu, uma hospedagem com cPanel ou o seu próprio servidor. Essas caixas falam IMAP e SMTP, e alcançá-las exige algo que fale IMAP.

## Um conector para todas as caixas

O MCPEmails é um servidor MCP hospedado. Você conecta cada caixa de e-mail a ele uma vez, e seu cliente de IA alcança todas por uma única URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Qualquer combinação de provedores.** Gmail e Google Workspace (senha de app do Google), Outlook e Microsoft 365 (Entrar com a Microsoft), iCloud, Fastmail, Yahoo, Zoho, Yandex e qualquer caixa de e-mail que fale IMAP e SMTP. Há uma página por provedor em [connect](/connect), incluindo [IONOS](/connect/ionos), [Zoho Mail](/connect/zoho), [Namecheap](/connect/namecheap), [STRATO](/connect/strato), [Migadu](/connect/migadu), [Google Workspace](/connect/google-workspace) e [Microsoft 365](/connect/office365).
- **As mesmas caixas nos dois assistentes.** É um servidor MCP padrão, então a mesma conexão funciona no Claude e no ChatGPT, e também no Cursor, no VS Code e em outros clientes MCP. Adicione uma caixa de e-mail uma vez e todos os clientes a enxergam.
- **O agente sabe qual caixa é qual.** Ele chama \`inbox_list\` e recebe todos os endereços conectados com o nome de exibição de cada um. Todas as outras ferramentas nomeiam a caixa em que atuam, então basta dizer "em vendas@" em linguagem natural.
- **As respostas saem do endereço certo.** Cada caixa envia pelo próprio provedor ou servidor SMTP, com o próprio nome de remetente e assinatura. Uma resposta a uma conversa em suporte@ sai de suporte@.

Os e-mails são buscados ao vivo a cada requisição e não são armazenados. A única exceção é uma mensagem que você agenda para mais tarde, que fica guardada até ser enviada.

## Conectar as caixas de e-mail

No painel do MCPEmails, abra **Caixas de entrada** e depois **Conectar caixa de entrada**, uma vez por caixa:

- **Caixa da empresa em domínio próprio.** Escolha **IMAP** e digite o endereço. Os provedores comuns são reconhecidos pelo endereço, e um domínio do Google Workspace é reconhecido pelos registros de e-mail, então as configurações se preenchem sozinhas. Use a senha ou a senha de app que o seu provedor exige.
- **Gmail ou Google Workspace.** Uma senha de app do Google por IMAP. O Google só oferece uma depois que a verificação em duas etapas está ativada, e no Workspace o administrador pode desativar senhas de app e IMAP.
- **Outlook ou Microsoft 365.** Entrar com a Microsoft. Uma conta corporativa ou de estudante pode precisar que o administrador de TI aprove o app uma vez para toda a organização.

Dê a cada caixa um nome de exibição claro, como "Acme Vendas" em vez de "trabalho2". É o que o agente lê para distingui-las, e é o nome que os destinatários veem.

## Adicionar ao Claude

No claude.ai ou no Claude Desktop:

1. Abra **Personalizar → Conectores**.
2. Clique em **+ Adicionar** e depois em **Adicionar conector personalizado**. Dê o nome MCPEmails, cole \`https://mcpemails.com/api/mcp\` e clique em **Continuar**.
3. Mantenha as configurações de login detectadas, clique em **Adicionar**, faça login no MCPEmails e aprove.
4. Em um chat, clique em **+** no canto inferior esquerdo, escolha **Conectores** e ative o MCPEmails.

O plano Free do Claude permite um conector personalizado, e Pro e Max não têm limite. No Team e no Enterprise, um Owner adiciona o conector em **Configurações da organização → Conectores** e os membros clicam em **Conectar** em **Personalizar → Conectores**.

Todas as caixas que você conectou estão disponíveis agora. O [guia do Claude](/blog/connect-claude-to-email) tem os detalhes.

## Adicionar ao ChatGPT

O ChatGPT Go e os planos pagos podem adicionar um servidor MCP personalizado em chatgpt.com no navegador; o app para celular não consegue. No Business e no Enterprise, um administrador ou proprietário pode precisar adicioná-lo.

1. Abra **Plugins**, depois **Personal** (Pessoal), clique em **Add** (Adicionar) no canto superior direito e escolha **Add custom MCP server** (Adicionar servidor MCP personalizado).
2. Dê o nome MCPEmails, cole \`https://mcpemails.com/api/mcp\` em **Connection** (Conexão), escolha **OAuth**, marque **I understand and want to continue** (Entendo e quero continuar) e clique em **Create as a plugin** (Criar como plugin).
3. Faça login com o MCPEmails e aprove.
4. Em um chat, digite **@** e escolha MCPEmails. A escolha vale para aquela mensagem, então mencione com @ de novo quando uma mensagem seguinte precisar do seu e-mail.

O [guia do ChatGPT](/blog/connect-chatgpt-to-email) cobre os menus e os erros mais comuns.

## Prompts que usam várias caixas

> Passe por vendas@ e contato@ e liste todos os pedidos de informação desta semana que ninguém respondeu. Uma única lista combinada, marcando de qual caixa cada um veio. Não envie nem mova nada.

> Encontre a fatura da Hetzner de agosto. Procure em todas as caixas conectadas e me diga em qual delas está.

> Escreva um rascunho de resposta de suporte@ para a reclamação de entrega mais recente. Me mostre antes de enviar.

Uma chamada alcança uma caixa, então "procure em todas as caixas" é o agente rodando a busca uma vez por caixa e juntando as respostas. Peça uma única lista combinada, ou você recebe um relatório por conta. [Gerenciar várias contas de e-mail com IA](/blog/manage-multiple-email-accounts-with-ai) aprofunda o escopo, a identidade do remetente e a revisão por caixa.

## Mantenha uma pessoa no botão de enviar

Ative **Revisar antes de enviar** em qualquer caixa e todo envio, resposta, encaminhamento, envio de rascunho e envio agendado a partir dela espera sua aprovação no painel. A configuração é por caixa, então a caixa de notas fiscais pode ficar retida enquanto a sua envia livremente. Está incluída em todos os planos, inclusive no Free. Veja [aprovação humana para envios de e-mail por IA](/blog/approve-ai-agent-email-sends).

## Quantas caixas cada plano conecta

- **Free:** uma caixa de e-mail.
- **Personal:** três caixas de e-mail.
- **Pro:** até 10 caixas de e-mail, em um único login.
- **Business:** 10 caixas incluídas e US$ 3 por mês para cada caixa extra, e para quando uma segunda pessoa precisa de um login próprio.

Uma empresa com contato@, vendas@ e notasfiscais@ mais o seu próprio endereço são quatro caixas, o que é Pro. Os preços atuais estão na [página de preços](/pricing), e [MCPEmails para empresas](/for/business) mostra como uma pessoa administra todas as caixas da empresa a partir de um único agente.

## Perguntas frequentes

**O Claude consegue usar mais de uma conta de e-mail ao mesmo tempo?**
Sim, por meio de um servidor MCP. Conecte cada caixa de e-mail ao MCPEmails, adicione um conector personalizado ao Claude, e o Claude enxerga todas e nomeia a caixa em cada chamada.

**O ChatGPT consegue usar mais de uma conta de e-mail?**
O plugin próprio do Gmail agora aceita várias contas Google. Para caixas que não estão no Google, como um endereço da empresa na IONOS, na Zoho ou em uma hospedagem com cPanel, adicione o MCPEmails como conector personalizado e todas as caixas conectadas ficam disponíveis.

**Preciso de um conector separado para cada caixa?**
Não. Uma única URL de conector cobre todas as caixas do seu espaço de trabalho no MCPEmails, e a mesma URL funciona no Claude, no ChatGPT e em outros clientes MCP.

**A resposta vai sair do endereço certo?**
Sim. Cada caixa envia pelo próprio provedor ou servidor de e-mail, com o próprio nome de exibição e assinatura. Para enviar de outro endereço em uma caixa IMAP, adicione-o nas configurações dessa caixa no painel e verifique com o código enviado por e-mail para esse endereço. O Outlook envia do endereço conectado, e um endereço de remetente não verificado é recusado.

**Os e-mails de todas essas contas ficam armazenados?**
Não. O conteúdo das mensagens é buscado ao vivo no seu provedor a cada requisição e descartado. O que fica guardado é a credencial criptografada de cada caixa. Veja [segurança](/security).

## Próximo passo

[Comece grátis](/signup) com a sua caixa mais movimentada, adicione o conector do MCPEmails ao Claude ou ao ChatGPT e pergunte o que precisa de resposta hoje. Adicione as outras caixas quando quiser uma resposta só em vez de várias.`,
};

export default translation;
