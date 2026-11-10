const translation = {
  title: 'Como conectar o Yahoo Mail ao ChatGPT e ao Claude',
  description:
    'O ChatGPT e o Claude não têm conector para o Yahoo Mail. Conecte o Yahoo aos dois com uma senha de aplicativo do Yahoo e uma única URL MCP, para a IA ler, pesquisar, enviar e organizar seus e-mails.',
  coverAlt: 'Yahoo Mail conectado ao ChatGPT e ao Claude pelo MCPEmails',
  content: `O ChatGPT não consegue ler o Yahoo Mail sozinho, e o Claude também não. Os plugins de e-mail do ChatGPT cobrem Gmail, Outlook e iCloud Mail. Os do Claude cobrem Gmail e contas corporativas do Microsoft 365. Para conectar o Yahoo Mail a qualquer um dos dois, você coloca um servidor MCP na frente da caixa de correio. Com o MCPEmails, isso exige uma senha de aplicativo do Yahoo e uma URL, e a mesma caixa do Yahoo passa a funcionar no ChatGPT, no Claude e em outros apps de IA.

**Ir para:** [Por que não existe opção nativa](#por-que-o-chatgpt-e-o-claude-ainda-não-leem-o-yahoo-mail) · [Senha de aplicativo](#passo-1-criar-uma-senha-de-aplicativo-no-yahoo) · [ChatGPT](#passo-3a-adicionar-ao-chatgpt) · [Claude](#passo-3b-adicionar-ao-claude) · [Perguntas frequentes](#perguntas-frequentes)

## Por que o ChatGPT e o Claude ainda não leem o Yahoo Mail

A [lista de apps conectados](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt) da OpenAI tem plugins para Gmail, Outlook e, desde 27 de outubro de 2026, [iCloud Mail](/blog/chatgpt-icloud-mail-plugin). Não há plugin para o Yahoo Mail. Os conectores próprios do Claude são para Gmail e Microsoft 365, como [O Claude pode ler meus e-mails?](/blog/can-claude-read-my-email) explica.

O que aparece quando você pesquisa, no lugar disso:

- **Extensões de navegador** que adicionam um botão do ChatGPT dentro do Yahoo Mail na web. Elas ajudam a escrever a mensagem que está aberta na tela. O ChatGPT em si continua sem acesso à sua caixa de entrada, então não consegue pesquisar nela nem trabalhar por você.
- **Plataformas de automação** que repassam mensagens individuais do Yahoo a um modelo de IA quando um gatilho dispara. Servem para um fluxo fixo, não para fazer perguntas sobre seus e-mails em um chat.
- **Copiar e colar** mensagens no chat, o que funciona para um e-mail de cada vez.

Um servidor MCP é o caminho que entrega à IA a sua caixa de correio de verdade. O ChatGPT e o Claude aceitam um como conector personalizado, e é o servidor que faz o login no Yahoo.

## O que você precisa

- Um endereço do Yahoo Mail: yahoo.com, uma versão por país como yahoo.com.br, ou o endereço ymail.com ou rocketmail.com com que você se cadastrou.
- **Para o ChatGPT:** o plano Go ou um plano pago, no chatgpt.com em um navegador. A OpenAI não permite que o plano Free adicione um servidor MCP personalizado, e não dá para adicionar um pelo aplicativo de celular.
- **Para o Claude:** qualquer plano, inclusive o Free, que permite um conector personalizado.
- Uma conta gratuita no MCPEmails. [Crie a sua aqui](/signup); o plano gratuito conecta uma caixa de entrada.

## Passo 1: criar uma senha de aplicativo no Yahoo

O Yahoo não deixa outros apps entrarem com a sua senha normal do Yahoo, então você cria uma senha de aplicativo para o MCPEmails. A [página de ajuda do Yahoo](https://br.ajuda.yahoo.com/kb/SLN15241.html) traz os passos:

1. Entre no Yahoo e abra a página **Segurança de sua conta do Yahoo**.
2. Em **Conexões externas**, clique em **Criar senha de aplicativo**.
3. Digite um nome, por exemplo MCPEmails, e clique em **Gerar senha**.
4. Copie a senha. O Yahoo a mostra uma única vez.

Se a opção não aparecer, ative a verificação em duas etapas na mesma página e procure de novo. Para revogar o acesso mais tarde, exclua essa senha de aplicativo na mesma tela.

## Passo 2: conectar o Yahoo Mail ao MCPEmails

1. No painel do MCPEmails, abra **Caixas de entrada** e clique em **Conectar caixa de entrada**.
2. Escolha **Yahoo Mail**.
3. Informe seu endereço completo do Yahoo e cole a senha de aplicativo.

As configurações do servidor são preenchidas para você. O MCPEmails testa o login no Yahoo antes de salvar a caixa, então uma senha errada falha aqui, e não depois, no meio de um chat. A [página de configurações do Yahoo Mail](/connect/yahoo) lista os dados de IMAP e SMTP e os erros mais comuns.

Um endereço da AOL é uma conta separada, com senha de aplicativo própria. Conecte-o como AOL, com as [configurações da AOL](/connect/aol).

## Passo 3a: adicionar ao ChatGPT

1. No chatgpt.com, abra **Plugins**, depois **Personal** (Pessoal), e clique em **Add** (Adicionar).
2. Escolha **Adicionar servidor MCP personalizado** e dê o nome MCPEmails.
3. Em **Conexão**, cole:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Escolha **OAuth**, confirme, clique em **Criar como plugin** e faça login no MCPEmails.
5. Em um chat, digite **@** e escolha MCPEmails. Repita quando uma pergunta seguinte precisar dos seus e-mails.

A OpenAI muda esses menus de lugar de tempos em tempos. A [página de configuração do ChatGPT](/docs/chatgpt) tem o caminho atual e as soluções para os erros mais frequentes.

## Passo 3b: adicionar ao Claude

1. No claude.ai ou no Claude Desktop, abra **Personalizar** e depois **Conectores**.
2. Clique em **+ Adicionar** e depois em **Adicionar conector personalizado**.
3. Dê o nome MCPEmails, cole \`https://mcpemails.com/api/mcp\`, clique em **Continuar** e depois em **Adicionar**.
4. Clique em **Conectar**, faça login no MCPEmails e aprove o acesso que você quer dar ao Claude.

Em um chat, clique em **+**, escolha **Conectores** e ative o MCPEmails. A [página de configuração do Claude](/docs/claude) cobre os planos Team e Enterprise, em que um proprietário adiciona o conector primeiro.

Você pode fazer os dois. Uma conta do MCPEmails atende ao ChatGPT e ao Claude ao mesmo tempo, com a mesma caixa do Yahoo.

## O que o ChatGPT e o Claude conseguem fazer com o Yahoo Mail

Comece com algo somente leitura:

> Resuma meus e-mails não lidos do Yahoo de hoje e me diga quais mensagens precisam de resposta.

Quando isso funcionar, a IA pode:

- Ler e pesquisar seus e-mails por remetente, assunto, data ou status de não lido.
- Enviar, responder e encaminhar a partir do seu endereço do Yahoo, com anexos.
- Salvar rascunhos para você terminar e agendar um envio para mais tarde.
- Criar pastas e mover, arquivar, sinalizar ou excluir mensagens.
- Assinar cada mensagem com a assinatura que você definiu para a caixa.

Alguns pedidos que combinam com uma caixa do Yahoo:

- "Encontre todas as newsletters que recebi este mês e mova para uma pasta chamada Leitura. Me mostre a lista antes."
- "Escreva um rascunho de resposta ao último e-mail do meu locador, mas deixe como rascunho."
- "O que a companhia aérea me mandou sobre a minha reserva na semana passada?"

O MCPEmails não empurra e-mails novos para a IA. Ele verifica quando você pede, o que funciona bem para colocar a leitura em dia e fazer limpeza.

## É seguro?

Seus e-mails do Yahoo nunca ficam armazenados no MCPEmails. Cada mensagem é buscada ao vivo no Yahoo quando o ChatGPT ou o Claude pede, e depois descartada. Só a senha de aplicativo fica guardada, criptografada. Sua senha real do Yahoo nunca é digitada em lugar nenhum além do próprio Yahoo.

Você escolhe o que cada app de IA pode fazer quando aprova a conexão: só ler, ou ler e enviar. Quem é dono da caixa também pode segurar todo envio para aprovação no painel. [É seguro dar a um agente de IA acesso ao e-mail?](/blog/is-it-safe-to-give-ai-agent-email-access) cobre os riscos que vale conhecer, como instruções escondidas dentro de um e-mail.

## Solução de problemas

- **O Yahoo rejeita a senha.** Use uma senha de aplicativo, não a sua senha do Yahoo, e cole sem espaços.
- **Não aparece a opção de criar senha de aplicativo.** Ative a verificação em duas etapas na página de segurança da conta primeiro.
- **O ChatGPT não tem a opção de adicionar servidor MCP personalizado.** Você precisa do plano Go ou de um plano pago, no chatgpt.com em um navegador.
- **A IA responde sem ler seus e-mails.** No ChatGPT, mencione o MCPEmails com @ naquela mensagem. No Claude, confira se o MCPEmails está ativado em Conectores.
- **Você tem Yahoo e outra caixa de correio.** Conecte as duas ao MCPEmails. [Várias contas de e-mail no Claude e no ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica como a IA as distingue.

## Perguntas frequentes

**O ChatGPT consegue ler o Yahoo Mail?**
Sozinho, não: o ChatGPT não tem plugin para o Yahoo Mail. Conecte o Yahoo Mail a um servidor MCP como o MCPEmails com uma senha de aplicativo do Yahoo, adicione \`https://mcpemails.com/api/mcp\` ao ChatGPT como servidor MCP personalizado, e o ChatGPT passa a ler, pesquisar e enviar seus e-mails do Yahoo.

**O Claude funciona com o Yahoo Mail?**
Sim, por um conector personalizado. Os conectores de e-mail próprios do Claude cobrem Gmail e Microsoft 365, então o Yahoo passa por um servidor MCP. Conectores personalizados funcionam em todos os planos do Claude, inclusive o Free.

**Preciso da minha senha do Yahoo?**
Não. O Yahoo não a aceita vinda de outros apps. Crie uma senha de aplicativo em Conexões externas, na página de segurança da sua conta, e use essa.

**A mesma configuração funciona no ChatGPT e no Claude?**
Sim. Conecte a caixa do Yahoo uma vez e adicione a mesma URL em cada app. Cada um faz login no MCPEmails separadamente, com as próprias permissões.

**Como desconecto?**
Remova a caixa no MCPEmails ou exclua a senha de aplicativo na página de segurança da conta do Yahoo. Qualquer uma das duas opções corta o acesso.

## Próximo passo

[Comece grátis](/signup), conecte sua caixa do Yahoo com uma senha de aplicativo e adicione uma URL ao ChatGPT ou ao Claude. [O que é senha de app?](/blog/what-is-an-app-password) explica essa etapa para Yahoo, AOL, iCloud e outros.`,
};

export default translation;
