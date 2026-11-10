const translation = {
  title: 'Assinatura de e-mail no Claude: assinado automaticamente, sempre',
  description:
    'Defina uma assinatura por caixa de entrada uma vez, e o Claude assina automaticamente todo e-mail que envia, no Gmail, Outlook, Fastmail, iCloud e em qualquer conta IMAP.',
  coverAlt:
    'Assinaturas de e-mail para o Claude: defina uma assinatura por caixa de entrada uma vez e o Claude assina toda mensagem que envia, em qualquer provedor',
  content: `Quando o Claude envia um e-mail por você, ele deve parecer que foi você quem enviou. Isso inclui o fechamento: seu nome, seu cargo, a linha da empresa, aquele link para a sua agenda. Até agora, você digitava a assinatura em cada prompt ou aceitava mensagens que terminavam de forma um pouco seca. Isso muda hoje: **o MCPEmails agora aplica sua assinatura automaticamente a toda mensagem que o Claude envia.**

As assinaturas são **por caixa de entrada**. Cada caixa conectada tem a sua, então a assinatura de fundador vai no endereço do trabalho e um simples "Abraço, Sam" vai no pessoal. Depois de definida, você nunca mais pensa nisso.

## O que é assinado

Defina uma vez e a assinatura é acrescentada automaticamente a tudo o que o Claude envia daquela caixa:

- **E-mails novos**: \`email_compose\` (ação \`send\`).
- **Respostas e encaminhamentos**: \`email_compose\` (ações \`reply\` e \`forward\`).
- **Rascunhos**: \`draft\`, para que o que você revisa já venha com o seu fechamento.
- **Envios agendados**: \`schedule\`, para que uma mensagem na fila para segunda de manhã saia assinada.

Não há nada a mais para dizer no prompt. "Responda à Dana e diga que a apresentação está em anexo" produz um e-mail completo e assinado.

## Respostas e encaminhamentos no lugar certo

A parte chata das assinaturas é o posicionamento, e é aí que a maioria das ferramentas tropeça. Em uma resposta ou encaminhamento, o MCPEmails coloca sua assinatura **depois do seu texto novo e antes da conversa citada**, exatamente onde uma pessoa colocaria, em vez de largá-la lá no fim, embaixo de páginas de histórico.

Ele também lida bem com idas e vindas. Existe um **modo de resposta** para que a assinatura não se repita toda vez que o Claude responde dentro da mesma conversa. A primeira resposta é assinada; as respostas rápidas seguintes naquela conversa não acumulam fechamentos duplicados. Você fica com conversas limpas, não com uma parede de nomes repetidos.

## Funciona em todos os provedores

Isso não é uma exclusividade do Gmail. As assinaturas valem para **todos** os provedores conectados: Gmail, Outlook, Fastmail, iCloud e qualquer outra conta IMAP, inclusive uma caixa da empresa na Locaweb ou na UOL Host. Como o MCPEmails monta a mensagem de saída por conta própria, o comportamento é idêntico onde quer que a caixa esteja. Conecte uma caixa nova de qualquer tipo e a assinatura simplesmente funciona.

## Duas formas de configurar

**1. O editor de assinatura no painel.** Abra uma caixa de entrada no painel do MCPEmails e edite a assinatura ali mesmo. Cada caixa tem a sua, então você dá a cada endereço o tom certo.

**2. Peça ao Claude.** Há uma ferramenta \`signature\`, então você define ou altera a assinatura em linguagem natural sem sair do chat:

> "Defina minha assinatura da caixa do trabalho como: Sam Rivera, Fundador, Acme, calendly.com/sam"

O Claude grava a assinatura para aquela caixa, e a partir daí todo envio sai assinado. Peça para atualizar depois e ele faz a mesma coisa.

## Quando você quer uma mensagem sem assinatura

Às vezes a assinatura é ruído: um "Obrigado!" de uma palavra não precisa de três linhas de contato embaixo. Para esses casos pontuais existe a **opção \`include_signature\`**: diga ao Claude para pular a assinatura em uma única mensagem e ele envia a versão curta. Sua assinatura salva continua valendo para tudo o que vier depois.

> "Responda 'Estou a caminho' à última mensagem do escritório, sem assinatura."

## Como isso se encaixa no resto do fluxo

As assinaturas entram nas ferramentas que você já usa. Se o Claude faz a triagem da sua manhã e dispara respostas, cada uma delas agora leva o seu fechamento sem você mencionar. O mesmo vale para os [padrões de resposta automática](/blog/build-email-auto-responder-mcp-agent) e para o [playbook de triagem e resumo](/blog/ai-agent-triage-summarize-inbox): tudo o que termina em um envio agora termina assinado.

E o modelo de privacidade não mudou: seus e-mails continuam [nunca armazenados](/blog/why-email-never-stored-matters). A assinatura é um pequeno item de configuração por caixa; suas mensagens continuam sendo buscadas ao vivo e descartadas assim que o Claude as recebe.

## Perguntas frequentes

**As assinaturas são por caixa de entrada ou por conta?**
Por caixa de entrada. Cada caixa conectada tem a própria assinatura, então você assina de um jeito no trabalho e de outro no e-mail pessoal.

**Respostas e encaminhamentos recebem a assinatura no lugar certo?**
Sim. Ela fica depois do seu texto novo e antes da conversa citada, e o modo de resposta evita que se repita ao longo de uma troca na mesma conversa.

**Quais provedores aceitam assinatura?**
Todos: Gmail, Outlook, Fastmail, iCloud e qualquer outra conta IMAP. O MCPEmails monta a mensagem de saída, então o comportamento é o mesmo em todo lugar.

**Posso enviar uma mensagem sem a minha assinatura?**
Sim. Use a opção \`include_signature\` (basta dizer ao Claude para pular a assinatura) em uma mensagem curta pontual. Sua assinatura salva continua valendo para o restante.

**Como defino minha assinatura?**
De dois jeitos: editando por caixa de entrada no painel, ou pedindo ao Claude, por exemplo "defina minha assinatura como…", pela ferramenta \`signature\`.

## Resumo

Defina sua assinatura uma vez, por caixa de entrada, e todo e-mail que o Claude envia daquela caixa (novo, resposta, encaminhamento, rascunho ou agendado) sai assinado como se você tivesse escrito. Funciona em todos os provedores, se posiciona corretamente nas conversas e sai do caminho com \`include_signature\` quando você quer uma resposta curta e direta.

[Abra seu painel](/dashboard) para definir uma assinatura, ou simplesmente diga ao Claude qual deve ser a sua. Ainda não conectou? [Comece grátis](/signup) e conecte uma caixa em cerca de dois minutos. O [guia para conectar o Claude à sua caixa de entrada](/blog/connect-claude-to-email) mostra cada passo.`,
};

export default translation;
