const translation = {
  title: 'Como gerenciar várias contas de e-mail com um único agente de IA',
  description:
    'Trabalho, pessoal e o negócio paralelo em um único agente de IA: como ele descobre as caixas, como limitar um pedido a uma conta, nomes de remetente que continuam certos e revisão de envio por caixa.',
  coverAlt:
    'Um agente de IA conectado às contas de e-mail do trabalho, pessoal e do negócio paralelo com o MCPEmails',
  content: `Quase ninguém tem uma caixa de correio só. Você tem um endereço do trabalho, um pessoal e pelo menos mais um para um negócio paralelo ou um domínio que ainda mantém. Toda pergunta que cruza duas contas vira uma busca manual em dois lugares.

Um agente de IA em todas elas elimina a troca, mas só se o agente souber qual caixa é qual e as respostas saírem do endereço certo.

**Ir para:** [Descoberta](#seu-agente-encontra-as-caixas-sozinho) · [Limitar um pedido](#limite-um-pedido-a-uma-caixa) · [Limites dos planos](#onde-os-limites-dos-planos-entram)

## Por que um agente ganha de ficar trocando de cliente de e-mail

Um cliente de e-mail mostra contas. Ele não responde perguntas. "Em qual das minhas contas caiu o recibo da Stripe?" é uma busca em três caixas mais um julgamento. Um agente com acesso a todas as caixas faz isso em um pedido, e você deixa de ser o roteador. O segundo ganho: um só conjunto de hábitos, porque as mesmas ferramentas estão por trás de cada conta. [Várias contas de e-mail no Claude e no ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) cobre a configuração do conector nos dois apps.

## Seu agente encontra as caixas sozinho

Você nunca cola um ID de caixa em um prompt. O agente chama \`inbox_list\`, que devolve todas as caixas que a sua chave pode usar, cada uma com UUID, endereço de e-mail, nome de exibição, provedor, marca do serviço (opcional) e um objeto de capacidades. Todas as outras ferramentas aceitam \`inbox_id\` (um UUID, ou um endereço) ou \`inbox\` (um endereço), preenchidos a partir desse resultado.

Dois detalhes que vale saber:

- **A descoberta é gratuita.** \`inbox_list\` nunca é contabilizado, então o agente pode se reorientar sem custo.
- **Seletores em conflito são recusados, não adivinhados.** Uma chamada com um \`inbox_id\` de uma caixa e um endereço \`inbox\` de outra é recusada, e o erro cita os dois. A causa mais comum é um ID antigo arrastado de um ponto anterior da conversa. Diga ao agente para tentar de novo só com o endereço.

## Limite um pedido a uma caixa

Diga o nome da conta. Endereços funcionam em todo lugar em que um ID funciona, então linguagem natural basta:

> Só em joana@acme.com.br, liste tudo o que está não lido dos últimos dois dias e me diga o que precisa de resposta hoje. Não mexa nas minhas outras contas.

Você também pode impor o limite fora do prompt. No painel, toda chave de API tem uma configuração de **Acesso às caixas de entrada**: todas as caixas ou uma lista explícita. Uma chave limitada à caixa do negócio paralelo não consegue ler as outras duas, diga o prompt o que disser.

## Buscar em todas é o agente chamando uma vez por caixa

Esta é a parte que as pessoas erram: **uma chamada alcança uma caixa.** Listar, ler, pesquisar, mover e excluir são todos limitados a uma única caixa, e não há distribuição automática. Então "pesquise em todas as minhas contas" é o agente rodando a pesquisa uma vez por caixa e juntando os resultados por conta própria. Isso funciona bem, com três consequências:

- Deixe-o chamar \`inbox_list\` primeiro, ou diga quantas contas você tem. Se ele presumir uma, vai relatar uma com toda a confiança.
- Peça uma resposta consolidada ("uma lista única, marcada com a conta de origem"), ou você recebe três relatórios separados.
- O volume cresce com o número de caixas. Uma triagem em três caixas são pelo menos três chamadas, não uma.

## Nomes e identidade do remetente

Um campo faz três trabalhos. Cada caixa tem um nome de exibição: é o **Rótulo** na lista do seu painel, o \`display_name\` que o agente lê de \`inbox_list\` e o nome que os destinatários veem no cabeçalho De, antes do endereço.

"trabalho2" é, portanto, um nome ruim duas vezes: o agente não sabe para que serve a caixa, e algum cliente vai mostrar "trabalho2" ao lado do seu endereço. Use algo que um desconhecido consiga ler, como "Joana Silva (Acme)" ou "Estúdio Norte". Defina no painel, em **Nome do remetente** da caixa, ou com \`signature_set\`, e leia de volta com \`signature_get\`. Os nomes têm no máximo 100 caracteres.

Enviar de um alias funciona, mas só de endereços que você provou que são seus:

- Seu próprio endereço conectado sempre funciona como valor de De, em todo provedor.
- Em uma caixa IMAP (iCloud, Yahoo, Gmail conectado por senha de app, qualquer host SMTP, inclusive um e-mail da empresa na Locaweb ou na UOL Host), um endereço **diferente** funciona depois de verificado. Adicione-o nas configurações daquela caixa no painel e informe o código que o MCPEmails envia para esse endereço. Os endereços verificados aparecem em \`sender_identities\` na entrada dessa caixa em \`inbox_list\`.
- O Outlook envia do endereço conectado.
- Um endereço De que não está verificado para a caixa é recusado, em vez de reescrito em silêncio.

As assinaturas também são por caixa: uma formal no endereço do trabalho, nenhuma no pessoal. Veja [assinaturas de e-mail para o Claude](/blog/email-signatures-for-claude).

## Revisão de envio por caixa

A revisão é configurada por caixa. Cada caixa tem uma configuração **Revisar antes de enviar** com três opções: enviar imediatamente, mostrar um cartão de revisão na conversa com a IA, ou revisar só no painel.

É isso que torna uma configuração mista confortável: deixe a caixa do negócio paralelo em envio imediato e segure todo envio do trabalho para revisão. Nos dois modos de revisão, o e-mail é preparado mas não entregue, e a aprovação acontece só em uma sessão de navegador autenticada de um proprietário ou administrador. O cartão na conversa é uma conveniência, não um limite de permissão. [Aprovação humana para envios de e-mail por agentes de IA](/blog/approve-ai-agent-email-sends) aprofunda o assunto.

## Três rotinas entre caixas que vale copiar

**Uma triagem matinal de tudo.** Peça uma única lista ordenada, não um resumo por conta:

> Verifique todas as minhas caixas conectadas. Me dê uma lista única do que precisa de resposta hoje, da mais recente para a mais antiga, marcada com a conta em que chegou. Não mova, envie nem exclua nada.

O [playbook de triagem da caixa de entrada](/blog/ai-agent-triage-summarize-inbox) tem critérios para colar nesse prompt.

**Encontrar uma conversa quando você esquece a conta.**

> Encontre a fatura da Hetzner de agosto. Pesquise em todas as caixas conectadas e me diga em qual conta ela está e o valor.

**Mover uma conversa entre papéis.** Quando um contato pessoal vira cliente, encaminhe a conversa para a caixa do negócio e peça que a resposta seja redigida a partir do endereço comercial. Peça ao agente para confirmar antes de qual caixa ele vai enviar.

## O que muda quando você mistura Gmail, Outlook e IMAP

Configurações mistas são o caso normal, e os provedores discordam sobre o que é uma pasta.

- **O Gmail tem marcadores.** Mover adiciona um marcador e tira a mensagem da caixa de entrada. Os outros marcadores continuam, então uma mensagem pode estar em vários lugares.
- **O IMAP tem pastas.** Mover é mover: a mensagem sai de uma pasta e chega em outra.
- **O Outlook tem pastas aninhadas.** Mover é mover, como no IMAP, e pastas podem ficar dentro de outras pastas. O Outlook não tem marcadores, então a ação de marcador de uma automação aplica uma categoria do Outlook.
- **Os nomes das pastas variam.** Arquivo, Todos os e-mails, Spam, Lixo Eletrônico e os nomes traduzidos mudam de provedor para provedor. Peça ao agente para chamar \`folder_list\` na caixa que ele vai mexer.
- **O escopo de pastas é por caixa.** Restringir uma pesquisa a um conjunto de pastas vale dentro de uma caixa, então uma pesquisa por pastas em várias contas continua sendo uma chamada por conta.

[Marcadores do Gmail e pastas IMAP](/blog/gmail-labels-vs-imap-folders-ai-agents) explica o que "arquivar" significa de fato em cada lado.

## Onde os limites dos planos entram

Os planos são precificados por caixas conectadas:

- **Free.** Uma caixa conectada.
- **Personal.** Algumas caixas para uma pessoa, limite de pico maior, suporte prioritário por e-mail.
- **Pro.** Mais caixas para uma pessoa que toca um negócio, limite de pico maior ainda, histórico de análises mais longo, webhooks de e-mail novo.
- **Business.** Um bloco de caixas incluídas com preço por caixa acima dele, membros ilimitados com papéis sem custo adicional, administradores que aprovam envios retidos, um espaço de trabalho separado por cliente ou empresa.

Uma rotina entre caixas é uma chamada por caixa, então o número de caixas pesa no volume tanto quanto os seus hábitos. Os preços e o número de caixas atuais estão em [preços](/pricing).

## Perguntas frequentes

**Como o agente sabe qual caixa eu quero dizer?**
Por \`inbox_list\`, que devolve o endereço e o nome de exibição de cada caixa que ele pode usar. Diga o endereço no seu pedido. Um ID de caixa e um endereço que não combinam são recusados, não adivinhados.

**As respostas vão sair do endereço certo?**
Sim, quando você envia da caixa dona do endereço: cada caixa envia pelo próprio provedor, nome de exibição e assinatura. Um endereço De diferente funciona em uma caixa IMAP depois que você o verifica com um código enviado para esse endereço. O Outlook envia do endereço conectado, e um endereço De não verificado é recusado.

**Posso deixar o agente enviar livremente de uma caixa e segurar outra?**
Sim. Revisar antes de enviar é uma configuração por caixa, então uma caixa pode enviar imediatamente enquanto outra espera sua aprovação em um navegador autenticado.

**Os e-mails de todas essas contas ficam armazenados em algum lugar?**
Não. O conteúdo das mensagens é buscado ao vivo no seu provedor a cada solicitação e descartado. Só a credencial criptografada do provedor é guardada. Veja [segurança](/security).

## Próximo passo

[Comece grátis](/signup), conecte sua caixa mais movimentada e pergunte ao seu agente o que precisa de resposta hoje. Adicione a segunda e a terceira conta quando quiser uma resposta em vez de três. A [documentação](/docs) tem a referência completa das ferramentas, e os [detalhes por provedor](/docs/providers) mostram o que cada tipo de caixa suporta.`,
};

export default translation;
