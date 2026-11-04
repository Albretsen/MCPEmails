const translation = {
  title: 'Resumo diário de e-mails com Claude e ChatGPT: sua caixa de entrada resumida no horário certo',
  description:
    'Três formas de receber um resumo diário da sua caixa de entrada: uma tarefa agendada no Claude, uma tarefa agendada no ChatGPT ou um resumo matinal que o MCPEmails coloca na sua caixa sem nenhum chat aberto. Configuração, prompts e limites.',
  coverAlt:
    'Um resumo diário de e-mails do Claude e do ChatGPT com as novas mensagens das caixas conectadas',
  content: `**Você pode receber um resumo diário dos seus e-mails no Claude ou no ChatGPT dando duas coisas ao assistente: acesso à sua caixa de correio e um horário.** Os dois assistentes já rodam tarefas agendadas. As do Claude executam um prompt a cada hora, diariamente, semanalmente ou em dias úteis, e as do ChatGPT rodam em um horário definido em todos os planos. Aponte a tarefa para a sua caixa por meio de um conector, e toda manhã o resumo estará esperando por você.

Existe um terceiro caminho que dispensa qualquer chat: o MCPEmails pode colocar um resumo matinal direto na sua caixa de entrada no horário que você escolher. Este guia cobre os três, com os prompts a usar e o que cada um não consegue fazer.

**Ir para:** [Claude](#um-resumo-diário-de-e-mails-com-o-claude) · [ChatGPT](#um-resumo-agendado-da-caixa-de-entrada-no-chatgpt) · [Resumo matinal](#o-resumo-matinal-sem-precisar-de-chat) · [Qual escolher](#qual-escolher) · [Prompts](#prompts-para-um-resumo-útil) · [Perguntas frequentes](#perguntas-frequentes)

## Primeiro, dê ao assistente acesso à sua caixa

Uma tarefa agendada só resume os e-mails que consegue alcançar. O conector do Gmail do próprio Claude alcança uma conta Google, e o conector do Microsoft 365 alcança contas corporativas depois que um administrador o aprova. O ChatGPT tem o próprio app do Gmail. Para qualquer outro caso, ou para várias caixas em um único resumo, conecte-as por um servidor MCP.

O MCPEmails é um servidor MCP hospedado. Você conecta cada caixa uma vez e depois adiciona uma única URL de conector ao Claude ou ao ChatGPT:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Ele funciona com Gmail e Google Workspace, Outlook e Microsoft 365, iCloud, Yahoo, Fastmail, Zoho e qualquer caixa que use IMAP e SMTP. Cada caixa conectada aparece no assistente pelo nome, então um único resumo pode cobrir ao mesmo tempo seu endereço, o contato@ e um Gmail pessoal. [Várias contas de e-mail no Claude e no ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica essa configuração.

Um resumo só lê, então conecte com acesso **Somente leitura** quando a tela de consentimento perguntar. Assim, uma tarefa que roda enquanto você está fora não consegue enviar, mover nem excluir nada, diga o que disser o e-mail que ela lê. [Acesso somente leitura](/docs/read-only-access) lista exatamente o que essa conexão pode fazer.

## Um resumo diário de e-mails com o Claude

As tarefas agendadas do Claude fazem parte do Cowork no app Claude, em todos os planos pagos (Pro, Max, Team e Enterprise). Segundo o [artigo de ajuda da Anthropic](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork), uma tarefa pode rodar a cada hora, diariamente, semanalmente, em dias úteis ou só quando você a inicia, e usa os mesmos conectores das suas outras tarefas. As tarefas rodam remotamente, então mantêm o horário mesmo com o computador em repouso ou o app fechado, a menos que a tarefa precise de arquivos ou apps locais.

1. **Adicione o MCPEmails ao Claude.** Abra **Personalizar → Conectores**, clique em **+ Adicionar** e depois em **Adicionar conector personalizado**. Dê o nome MCPEmails, informe \`https://mcpemails.com/api/mcp\`, clique em **Continuar**, mantenha as configurações de login detectadas e clique em **Adicionar**. Entre no MCPEmails e escolha **Somente leitura**. O [guia de configuração do Claude](/blog/connect-claude-to-email) mostra cada tela.
2. **Crie a tarefa.** Clique em **Scheduled** (Agendadas) na barra lateral, depois em **New task** (Nova tarefa), e escolha **Create with Claude** (Criar com o Claude) ou **Set up manually** (Configurar manualmente). Você também pode descrever a tarefa em uma conversa ("todo dia útil às 7, resuma minha caixa de entrada"), e o Claude propõe um nome, um horário e instruções para você confirmar com **Schedule** (Agendar).
3. **Cole o prompt do resumo** da [seção de prompts](#prompts-para-um-resumo-útil) e escolha **Weekdays** (Dias úteis) ou **Daily** (Diariamente).
4. **Rode uma vez manualmente** para conferir o resultado antes da primeira execução agendada.

No Claude, cada ferramenta do conector pode ficar como **Sempre permitir**, **Precisa de aprovação** ou **Bloqueado**. Para um resumo, bloqueie as ferramentas de envio e de organização do MCPEmails, ou mantenha a conexão como Somente leitura, para que a tarefa continue sendo só um resumo.

## Um resumo agendado da caixa de entrada no ChatGPT

O [artigo de ajuda da OpenAI sobre tarefas](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt) diz que as tarefas agendadas estão em todos os planos, incluindo Free e Go. No Free, uma tarefa roda no máximo uma vez por dia, em uma janela aproximada como "manhã". Os planos pagos podem rodar tarefas até a cada hora, em um horário exato. Cada plano tem um limite de tarefas ativas, de 3 no Free a 15 no Pro e no Enterprise. Você cria uma tarefa na página **Scheduled** (Agendadas) ou pedindo em um chat, e o ChatGPT pode avisar por notificação push ou por e-mail quando ela terminar.

As tarefas podem usar apps compatíveis, e a OpenAI cita Gmail, Slack e GitHub. Se os seus e-mails estão em uma conta do Gmail, o app do Gmail do próprio ChatGPT é a fonte mais simples para a tarefa.

O artigo da OpenAI não diz se um servidor MCP que você mesmo adicionou fica disponível dentro de uma tarefa. Para usar o MCPEmails, adicione-o como descrito no [guia de configuração do ChatGPT](/docs/chatgpt), agende a tarefa para alguns minutos depois e confira se a primeira execução lê seus e-mails antes de depender dela. A OpenAI também observa que uma ação que envia uma mensagem ou altera dados pode precisar da sua aprovação e pausa a tarefa, mais um motivo para manter um resumo como somente leitura.

## O resumo matinal: sem precisar de chat

Os planos Pro e Business do MCPEmails incluem um **resumo matinal**: um resumo diário que o MCPEmails monta nos próprios servidores e coloca direto em uma das suas caixas de entrada no horário que você definir. Nenhum assistente, chat ou app aberto participa, então ele chega mesmo nos dias em que você nem abre o Claude ou o ChatGPT.

Cada resumo cobre o seu dia, no seu fuso horário:

- **Remetentes VIP primeiro.** Novos e-mails dos endereços ou domínios que você listar, em todas as suas caixas.
- **Novos e-mails por caixa** desde o último resumo: quantas mensagens, e os remetentes e assuntos mais recentes.
- **Acompanhamentos pendentes.** Lembretes que a sua IA definiu para e-mails que ficaram sem resposta.
- **E-mails adiados** que voltam mais tarde hoje.
- **Envios agendados** que saem mais tarde hoje.

Ele cobre até 10 caixas conectadas. Dias sem nada novo são pulados em vez de gerar um resumo vazio. O resumo é adicionado diretamente à caixa, então nada é enviado e nada sai da sua caixa de correio. Ele é montado a partir de regras, sem nenhum modelo de IA lendo seus e-mails.

Para ativar, abra **Configurações** no painel, encontre **Resumo matinal** nas configurações do espaço de trabalho, marque **Colocar um resumo matinal na minha caixa de entrada todo dia** e escolha o horário, seu fuso horário, a caixa que vai recebê-lo e os remetentes VIP. Só proprietários e administradores do espaço de trabalho podem alterar essa opção.

Os acompanhamentos e os adiamentos do resumo vêm da sua IA e fazem parte dos mesmos planos. Peça ao Claude ou ao ChatGPT "me lembre se a Dana não responder até sexta" ou "adie este até segunda de manhã", e o MCPEmails acompanha isso nos próprios servidores mesmo depois que o chat é fechado.

## Qual escolher

- **Você quer o resumo escrito em linguagem simples, com critério sobre o que importa:** uma tarefa agendada no Claude ou no ChatGPT. O modelo lê os e-mails e decide o que destacar.
- **Você quer o resumo todo dia sem depender de um app de chat nem dos limites de tarefas dele:** o resumo matinal. Ele chega na sua caixa no horário definido e nunca improvisa.
- **Você quer os dois:** eles funcionam juntos. O resumo traz a lista fixa toda manhã, e você pergunta ao assistente sobre qualquer item dela.

Se você prefere que os e-mails sejam organizados em vez de resumidos, as [regras automáticas de triagem de e-mail](/blog/automated-email-triage-rules) movem, marcam e sinalizam novos e-mails em um horário definido, sem modelo.

## Prompts para um resumo útil

Peça um formato curto e fixo. Um resumo que você lê em um minuto é um resumo que você continua lendo.

> Usando o MCPEmails, me dê meu resumo matinal de todas as caixas conectadas: o que chegou desde ontem neste horário, o que precisa de resposta minha hoje e qualquer coisa com prazo nesta semana. Agrupe por caixa, no máximo 10 linhas. Não envie, não mova e não altere nada.

> Usando o MCPEmails, liste os e-mails não lidos das últimas 24 horas em vendas@ e contato@ que sejam de um cliente ou de um potencial cliente. Para cada um: remetente, resumo de uma linha e se precisa de resposta hoje. Ignore newsletters e notificações. Somente leitura.

> Usando o MCPEmails, procure na minha caixa de entrada notas fiscais, contratos e qualquer coisa que mencione um pagamento ou um vencimento que tenha chegado na última semana. Uma linha para cada, com o valor e a data, se informados. Somente leitura.

Escrever "somente leitura" no prompt é um bom hábito, mas a proteção confiável é a própria conexão: uma conexão Somente leitura não consegue enviar, mesmo que uma mensagem mande o modelo fazer isso. E-mails são escritos por outras pessoas, e alguns são escritos para manipular assistentes de IA. [É seguro dar a um agente de IA acesso ao e-mail?](/blog/is-it-safe-to-give-ai-agent-email-access) explica por quê.

Para mais prompts de triagem, veja [triagem e resumos da caixa de entrada com agentes de IA](/blog/ai-agent-triage-summarize-inbox). Para escrever uma resposta em um horário definido em vez de ler, [agendar um e-mail com o Claude ou o ChatGPT](/blog/schedule-email-with-claude-and-chatgpt) trata dos envios na fila.

## Perguntas frequentes

**O Claude pode resumir meus e-mails todo dia?**
Sim. Crie uma tarefa agendada no Claude (Pro, Max, Team ou Enterprise) que rode diariamente ou em dias úteis, com um conector para a sua caixa. O conector do Gmail do Claude cobre uma conta Google; o MCPEmails cobre qualquer provedor e várias caixas ao mesmo tempo.

**O ChatGPT pode resumir minha caixa de entrada em um horário agendado?**
Sim. As tarefas agendadas do ChatGPT podem usar o app do Gmail em qualquer plano, com o Free limitado a uma vez por dia. A OpenAI não diz se um servidor MCP personalizado funciona dentro de uma tarefa, então teste uma execução antes de depender dela.

**A tarefa roda com o computador desligado?**
As tarefas agendadas do Claude rodam remotamente, a menos que precisem de arquivos ou apps locais. As tarefas do ChatGPT rodam do lado da OpenAI. O resumo matinal do MCPEmails roda nos nossos servidores e chega na sua caixa de qualquer forma.

**Meus e-mails ficam armazenados para o resumo?**
Não pelo MCPEmails. Os e-mails são buscados ao vivo no seu provedor a cada solicitação e descartados assim que a resposta é enviada. O resumo matinal é gravado na sua própria caixa de correio, não fica conosco. Veja [segurança](/security).

**Qual plano inclui o resumo matinal?**
Pro e Business. Uma tarefa agendada no Claude ou no ChatGPT pode ler pelo MCPEmails em qualquer plano do MCPEmails, inclusive o Free com uma caixa. Os planos atuais estão na [página de preços](/pricing).

## Próximo passo

[Comece grátis](/signup), conecte sua caixa mais movimentada com acesso Somente leitura, adicione o MCPEmails ao Claude ou ao ChatGPT e rode o prompt do resumo uma vez manualmente. Quando o resultado estiver do jeito que você quer, coloque-o em um horário agendado.`,
};

export default translation;
