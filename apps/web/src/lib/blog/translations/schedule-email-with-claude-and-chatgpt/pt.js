const translation = {
  title: 'Como agendar um e-mail com o Claude ou o ChatGPT (enviar mais tarde)',
  description:
    'Agende um e-mail no Claude ou no ChatGPT para sair mais tarde da sua própria caixa do Gmail, Outlook, iCloud ou IMAP: configuração, fusos horários, cancelamento e limites.',
  coverAlt:
    'Claude e ChatGPT agendando um e-mail para envio posterior a partir de uma caixa conectada com o MCPEmails',
  content: `Para agendar um e-mail com o Claude ou o ChatGPT, o assistente precisa de uma ferramenta de e-mail capaz de guardar uma mensagem e enviá-la depois. O MCPEmails tem uma. Conecte sua caixa de correio, adicione o MCPEmails como conector e diga quando: "Envie isto para a Dana na segunda às 9:00, horário de Oslo." A mensagem espera em uma fila no servidor do MCPEmails e sai do seu próprio endereço nesse horário, com o chat, o app ou o computador ainda abertos ou não.

Funciona do mesmo jeito no Claude, no ChatGPT e em outros clientes MCP, e no Gmail e Google Workspace, Outlook e Microsoft 365, iCloud, Fastmail, Yahoo, Zoho e qualquer caixa que use IMAP e SMTP.

**Ir para:** [Conectores nativos](#o-que-os-conectores-de-e-mail-nativos-fazem) · [Configuração](#como-agendar-um-e-mail-com-o-claude-ou-o-chatgpt) · [Fusos horários](#fusos-horários) · [Cancelar ou alterar](#conferir-cancelar-ou-alterar-um-e-mail-agendado) · [Perguntas frequentes](#perguntas-frequentes)

## O que os conectores de e-mail nativos fazem

Os dois assistentes vêm com conectores de e-mail próprios. Esta era a situação em 2026-10-20:

- **Claude.** O artigo de ajuda da Anthropic sobre o conector do Gmail lista pesquisar, ler, escrever rascunhos, enviar, responder e encaminhar. Agendar uma mensagem para mais tarde não está na lista.
- **ChatGPT.** A página de ajuda da OpenAI sobre o app Outlook Email cobre pesquisar e ler mensagens, ações com pessoas e contatos, e enviar e-mails em texto simples de caixas compartilhadas ou delegadas. As perguntas frequentes do app do Google tratam do uso de dados e de tarefas acionadas pelo Gmail. Nenhum dos dois descreve um envio agendado.

O ChatGPT tem **tarefas agendadas**, que rodam um prompt no horário que você escolher. Isso não é o mesmo que um e-mail na fila. A mensagem é escrita quando a tarefa roda, não quando você aprova o texto, e a OpenAI observa que ações que precisam da sua aprovação podem pausar a tarefa.

Um envio agendado pelo MCPEmails é uma mensagem pronta: você lê o texto exato agora, e é esse texto que sai no horário definido.

## Como agendar um e-mail com o Claude ou o ChatGPT

1. **Conecte sua caixa ao MCPEmails.** No painel, abra **Caixas de entrada**, depois **Conectar caixa de entrada**, e escolha seu provedor. Há uma página para cada provedor em [conectar](/connect).
2. **Adicione o MCPEmails ao seu assistente.** No Claude, abra **Personalizar**, depois **Conectores**, clique em **+ Adicionar**, escolha **Adicionar conector personalizado** e cole \`https://mcpemails.com/api/mcp\`. O [guia do Claude](/blog/connect-claude-to-email) traz todos os passos. No ChatGPT, o MCPEmails é adicionado como conector MCP personalizado; quais planos oferecem isso e onde fica o menu já mudou mais de uma vez este ano, então siga os passos atuais no [guia de configuração do ChatGPT](/docs/chatgpt).
3. **Conceda o agendamento ao autorizar.** A tela de consentimento do MCPEmails oferece níveis de acesso. Escolha **Acesso total**, ou **Personalizado** com agendamento marcado. **Padrão** deixa o agendamento de fora, então um pedido de agendamento é recusado.
4. **Peça o e-mail e o horário.** Informe os destinatários, o que dizer, a data e a hora e o seu fuso horário.

Nos bastidores, o assistente chama a ferramenta \`schedule\` com a ação \`create\`, passando destinatários, assunto, corpo e horário de envio. O MCPEmails confere os endereços, o assunto e o corpo na hora, então um endereço malformado ou um corpo vazio é recusado já, em vez de falhar na segunda de manhã. Ele não consegue distinguir um endereço válido que você não quis usar de um que você quis, e é por isso que os prompts abaixo pedem para ver o destinatário antes. O resultado traz o horário agendado e um id que o assistente pode usar depois para cancelar.

No horário de envio, um despachante no servidor do MCPEmails, que confere a fila a cada minuto, envia a mensagem pelo próprio provedor da caixa: Gmail, Microsoft ou o servidor SMTP da caixa. Ela sai do seu endereço, com a sua [assinatura](/blog/email-signatures-for-claude) adicionada naquele momento. Conte com o envio em cerca de um minuto do horário definido; não é feito para precisão de segundos.

Se o servidor de e-mail recusar a mensagem antes de aceitar qualquer parte dela, o despachante tenta de novo a cada minuto por até 15 minutos depois do horário de envio. Se a caixa tiver sido desconectada nesse meio-tempo, a mensagem não é enviada.

## Prompts que agendam sem erro

> Escreva um agradecimento curto para dana@example.com pela reunião de hoje e agende para segunda às 09:00, Europe/Oslo. Mostre o texto e o horário de envio antes de agendar.

> Agende o lembrete de pagamento abaixo a partir de financeiro@ para os três endereços que estão nele, para o dia 1º do mês que vem às 08:30, horário de Nova York.

> Quais e-mails eu tenho agendados? Liste destinatário, assunto e horário de envio no meu fuso horário.

> Cancele o e-mail agendado para a Dana.

Pedir para ver o texto e o horário antes custa uma mensagem a mais e pega as duas coisas que mais dão errado: o destinatário errado e a hora errada. Se você usa várias caixas, diga de qual enviar ("a partir de financeiro@"); [várias contas de e-mail no Claude e no ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica como o assistente as diferencia.

## Fusos horários

A ferramenta \`schedule\` recebe o horário de envio como um timestamp com deslocamento de fuso horário, por exemplo \`2026-11-02T09:00:00+01:00\`. O assistente transforma "segunda às 9" nesse formato, então precisa saber o seu fuso. Cite uma cidade ou um fuso no prompt ("horário de Oslo", "Europe/Oslo", "horário de Brasília"); sem isso, o modelo tem que adivinhar.

O horário de verão é onde os palpites erram. Oslo está em +02:00 até o último domingo de outubro e em +01:00 depois disso, então 09:00 no horário de Oslo em 2 de novembro de 2026 é \`+01:00\`. Dizer a cidade permite que o assistente escolha o deslocamento certo para aquela data.

A confirmação informa o horário em UTC. Peça ao assistente para repeti-lo no seu horário local antes de confiar nele. Um horário que já passou é recusado.

## Conferir, cancelar ou alterar um e-mail agendado

- **Veja o que está na fila.** \`schedule_list\` devolve as mensagens pendentes, da mais próxima para a mais distante, com destinatários, assunto, horário de envio e status. Peça para todas as caixas ou para uma só.
- **Cancelar.** A ferramenta \`schedule\` com a ação \`cancel\` interrompe uma mensagem enquanto ela ainda está pendente. Depois que o despachante começa a enviá-la, não dá mais para cancelar.
- **Alterar.** Não há edição. Peça ao assistente para cancelar a mensagem e agendar a versão corrigida; ele pode fazer as duas coisas na mesma resposta.
- **Mudanças na assinatura valem.** A assinatura é adicionada no momento do envio, então uma alteração feita depois de agendar é a que vai junto.

## O que o agendamento não faz

- **Responder dentro de uma conversa.** Um e-mail agendado é uma mensagem nova, com assunto próprio, então não entra na conversa como resposta. Para uma resposta que pertence à conversa, peça ao assistente para salvar um rascunho de resposta (\`draft\` com a ação \`reply\`) e envie você mesmo na hora certa.
- **Apontar para um anexo de outro e-mail.** O arquivo precisa vir no próprio pedido, com 10 MB no total. Um envio imediato pode anexar um arquivo direto de uma mensagem da sua caixa; o agendamento não.
- **Repetir.** Cada e-mail agendado sai uma vez. Um lembrete semanal significa agendar cada um.
- **Acertar o segundo exato.** A fila é conferida uma vez por minuto.

Um pedido de agendamento pode levar uma chave de idempotência. Se o assistente repetir o pedido com a mesma chave depois de uma conexão perdida, o MCPEmails coloca a mensagem na fila uma vez, não duas. [Como evitar envios duplicados de e-mail por IA](/blog/prevent-duplicate-ai-agent-email-sends) explica como.

## Onde a mensagem espera

Quase tudo o que o MCPEmails faz é ao vivo: os e-mails são lidos no seu provedor a cada solicitação e não ficam guardados. Um e-mail agendado não funciona assim, porque precisa existir em algum lugar até o horário de envio. O MCPEmails o armazena criptografado (AES-256-GCM) no banco de dados em Estocolmo e só o descriptografa para enviá-lo ou para mostrar os destinatários e o assunto quando você lista seus envios agendados. Uma mensagem cancelada nunca é enviada. A [página de segurança](/security) traz os detalhes.

## Perguntas frequentes

**O Claude pode agendar um e-mail para enviar mais tarde?**
Sim, por meio de um servidor MCP com ferramenta de envio agendado. Conecte sua caixa ao MCPEmails, adicione-o ao Claude como conector personalizado, conceda o agendamento e peça ao Claude para enviar a mensagem em uma data, hora e fuso horário definidos. O conector do Gmail da própria Anthropic não lista agendamento.

**O ChatGPT pode agendar um e-mail?**
Sim, do mesmo jeito: adicione o MCPEmails como conector MCP personalizado ([configuração](/docs/chatgpt)) e peça. As tarefas agendadas do ChatGPT rodam um prompt mais tarde, o que é diferente de colocar uma mensagem pronta na fila.

**O Claude ou o ChatGPT precisa ficar aberto até o e-mail sair?**
Não. A mensagem fica na fila do servidor do MCPEmails e é enviada de lá. Você pode fechar o chat, o app e o computador.

**Quais provedores de e-mail permitem agendar?**
Todas as caixas pelas quais o MCPEmails consegue enviar: Gmail e Google Workspace, Outlook e Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex e outras caixas IMAP e SMTP. A mensagem é enviada pelo próprio provedor daquela caixa.

**Como cancelo um e-mail agendado?**
Peça ao assistente para cancelar. Ele localiza a mensagem com \`schedule_list\` e a cancela pelo id, o que funciona até o momento em que o envio começa.

## Próximo passo

[Comece grátis](/signup), conecte sua caixa e peça ao Claude ou ao ChatGPT para agendar um e-mail de teste para você mesmo daqui a cinco minutos. O [guia do Claude](/blog/connect-claude-to-email) e o [guia do ChatGPT](/blog/connect-chatgpt-to-email) cobrem a conexão, e a [referência de ferramentas](/docs#tools) lista todos os argumentos de agendamento.`,
};

export default translation;
