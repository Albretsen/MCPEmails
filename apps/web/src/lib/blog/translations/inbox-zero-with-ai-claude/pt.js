const translation = {
  title: 'Como chegar ao Inbox Zero com IA (usando o Claude e sua caixa de entrada de verdade)',
  description:
    'Chegue ao Inbox Zero com IA: deixe o Claude fazer a triagem, arquivar, marcar e rascunhar respostas na sua caixa real do Gmail, Outlook ou IMAP via MCP. Uma rotina repetível, os prompts exatos e por que nada é armazenado.',
  coverAlt:
    'Chegue ao Inbox Zero com IA: o Claude faz a triagem, arquiva e rascunha respostas na sua caixa real via MCP',
  content: `O Inbox Zero, a caixa de entrada zerada, sempre teve o mesmo problema: chegar lá leva uma hora que você não tem, e amanhã você está de volta aos cinquenta não lidos. Um agente de IA muda a conta. Em vez de você classificar uma mensagem de cada vez, você diz ao Claude o que "resolvido" significa e ele trabalha a caixa inteira de uma vez: triagem, arquivamento, marcadores e rascunhos de resposta nos seus e-mails *de verdade*, ao vivo.

Este guia é a rotina: um ciclo repetível para rodar toda manhã, os prompts exatos que o movem e a única regra que o mantém seguro (nada é armazenado, nunca). Ele presume que o Claude já enxerga sua caixa. Se ainda não enxerga, comece por [como conectar o Gmail ao Claude](/blog/connect-gmail-to-claude) (ou pelo [guia do Outlook e do Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp)), que leva uns dois minutos, e depois volte. No iCloud, no Fastmail ou em outro host IMAP, como um e-mail da empresa na Locaweb, use o [guia de conexão do Claude ao e-mail](/blog/connect-claude-to-email).

## Por que o "Inbox Zero" finalmente é realista com IA

O Inbox Zero desmorona por causa de volume mais julgamento. A maioria das mensagens precisa de uma *decisão* (arquivar, responder, adiar, excluir), e tomar cinquenta decisões pequenas cansa. O Claude é bom exatamente nisso: ler a mensagem, aplicar suas regras, executar a ação. Ele não se entedia na quadragésima newsletter.

A mudança central é que você para de *processar* e-mails e passa a *supervisionar*. Você define a política ("arquive toda newsletter, sinalize qualquer coisa de cliente, rascunhe respostas que eu possa aprovar") e o Claude executa na caixa inteira em uma passada.

## A rotina matinal, em cinco prompts

Rode nesta ordem. Cada um é uma frase normal; o Claude a traduz para a ferramenta certa (\`email_read\`, \`email_organize\`, \`draft\`) nos bastidores.

**1. Entenda o terreno.**

> "Resuma meus e-mails não lidos das últimas 24 horas. Agrupe em: precisa de resposta, só para informação e ruído."

O Claude lista e lê seus não lidos e entrega uma visão triada em vez de uma parede de assuntos. Em um parágrafo, você já sabe com o que está lidando.

**2. Limpe o ruído.**

> "Arquive toda newsletter e todo e-mail promocional dessa lista. Não mexa em nada que venha de uma pessoa de verdade."

É o \`email_organize\` fazendo o trabalho chato: arquivando em massa para que a caixa só guarde o que pode precisar de você. Metade da caixa costuma sumir aqui.

**3. Marque o que sobrou.**

> "Marque tudo o que vem de cliente ou fala de nota fiscal como 'Prioridade', e tudo em que eu só estou em cópia como 'Informativo'."

Agora os sobreviventes estão classificados. O Claude aplica marcadores do Gmail (ou pastas no Outlook e no IMAP), e as conversas importantes ficam agrupadas visualmente antes de você gastar um segundo de atenção com elas.

**4. Rascunhe as respostas, mas não envie.**

> "Para cada e-mail que precisa de resposta, escreva um rascunho curto no meu tom. Salve como rascunhos; não envie nada."

Esta é a parte que de fato economiza a hora. O Claude cria \`draft\`s reais na sua caixa, prontos para você passar o olho, ajustar e enviar. Você mantém o controle de toda mensagem que sai; veja [OAuth ou chaves de API](/blog/oauth-vs-api-keys-ai-email-access) se preferir conceder somente leitura e nunca deixá-lo enviar.

**5. Adie o resto.**

> "Agende um lembrete de acompanhamento para as duas conversas que ainda não decidi, para amanhã de manhã."

Tudo o que você não consegue resolver ganha um cutucão agendado com \`schedule\`, então sai da sua cabeça sem ficar na caixa para sempre. Isso é o Inbox Zero: nada sem tratamento, nada esquecido.

## Transforme em hábito, não em obrigação

A rotina acima leva uns cinco minutos quando o Claude faz o trabalho pesado. Algumas formas de mantê-la viva:

- **Uma frase-gatilho.** Salve a sequência inteira como uma única mensagem: *"Rode minha triagem matinal da caixa de entrada."* O Claude lembra os passos dentro de uma conversa, então uma linha dispara o ciclo.
- **Ajuste as regras com o tempo.** Quando o Claude arquivar algo que não devia, diga uma vez ("nunca arquive nada da minha gestora") e incorpore isso às suas instruções fixas.
- **Faxina semanal.** Uma vez por semana: *"Encontre todo e-mail não lido com mais de um mês e arquive ou exclua."* A cauda longa é onde o Inbox Zero costuma morrer; deixe o Claude limpá-la. Para mais padrões, veja [as melhores formas de deixar o Claude gerenciar sua caixa de entrada](/blog/best-ways-to-let-claude-manage-your-inbox) e o [playbook de triagem e resumo](/blog/ai-agent-triage-summarize-inbox).

## A única regra que mantém isso seguro

Entregar a caixa inteira a uma IA parece arriscado até você saber para onde os dados vão: **para lugar nenhum.** Com o MCPEmails, cada um desses prompts busca seus e-mails ao vivo no Gmail, no Outlook ou no IMAP, entrega ao Claude para aquela única ação e descarta na hora. Corpos, assuntos e anexos dos e-mails que o Claude lê nunca são armazenados. O que fica guardado por caixa é um token criptografado para a próxima chamada ser possível, mais os poucos dados de que um recurso que você ativa precisa, como uma mensagem agendada esperando para sair. É a diferença entre dar a um agente uma *chave* e dar a ele uma *cópia permanente de tudo*; veja [por que "o e-mail nunca é armazenado" importa](/blog/why-email-never-stored-matters) e a [análise completa de segurança](/blog/is-it-safe-to-give-ai-agent-email-access), se quiser o modelo de ameaças.

Você também mantém uma linha dura no envio: rascunhos continuam rascunhos até você aprovar, e você pode conceder acesso somente leitura para que o Claude literalmente não consiga enviar.

## Chegue ao zero hoje

Você não precisa de um app de e-mail novo nem de um sistema de produtividade, só da sua caixa atual e de um agente que consiga agir sobre ela. Conecte a caixa uma vez, cole o endpoint no Claude e rode os cinco prompts acima. O plano Free não pede cartão e conecta uma caixa, para sempre.

[Conecte sua caixa grátis](/signup) e peça ao Claude para fazer a triagem dos seus não lidos. Inbox Zero, supervisionado em vez de sofrido.`,
};

export default translation;
