const translation = {
  title: 'Como evitar envios duplicados de e-mail por agentes de IA',
  description:
    'Novas tentativas acontecem. Veja como as chaves de idempotência do MCPEmails ajudam a evitar envios, respostas, encaminhamentos, envios de rascunho e e-mails agendados em duplicidade por agentes de IA.',
  coverAlt: 'Evitando envios duplicados de e-mail por agentes de IA com o MCPEmails',
  content: `Um timeout nem sempre significa que o e-mail não foi enviado. Às vezes o provedor aceitou a mensagem logo antes de a conexão cair. Se um agente tenta de novo às cegas, um cliente pode receber o mesmo e-mail duas vezes: um resultado constrangedor em qualquer fluxo de trabalho e um problema sério em prospecção, suporte ou cobrança.

O MCPEmails aceita chaves de idempotência nas operações de saída. Dê a uma tentativa lógica de envio uma chave única, e uma nova tentativa com a mesma chave é reconhecida como a mesma solicitação, em vez de tratada como permissão para enviar de novo.

## O que idempotência significa em linguagem normal

Idempotência é simplesmente segurança para tentar de novo. Você anexa um valor curto e único a uma mensagem que pretende enviar. Se o seu cliente precisar repetir exatamente essa operação, ele envia o mesmo valor de novo. O MCPEmails consegue então distinguir "repita o envio que eu já comecei" de "envie outro e-mail".

Isso vale para e-mails novos, respostas, encaminhamentos, envio de um rascunho salvo e criação de um envio agendado. É especialmente valioso quando um agente roda em um ambiente em que as solicitações podem sofrer timeout, reiniciar ou ser entregues mais de uma vez.

## O padrão certo para um fluxo de agente

Crie uma chave de idempotência por ação visível ao usuário, não por tentativa de rede. Por exemplo:

1. Um agente prepara uma resposta a um chamado de suporte específico.
2. O fluxo dá a essa resposta uma chave de idempotência única.
3. Se a primeira solicitação termina normalmente, o envio está feito.
4. Se o cliente precisa tentar de novo porque não recebeu um resultado claro, ele repete com a mesma chave e os mesmos dados da mensagem, sem alteração.

Não reutilize a chave para uma mensagem revisada. Mudou o assunto, o corpo, o destinatário ou outro detalhe relevante? Trate como uma nova ação lógica e use uma chave nova. Isso mantém as novas tentativas seguras sem impedir que você envie de propósito uma versão atualizada.

## O que acontece nas novas tentativas

O MCPEmails lembra o estado de uma solicitação de saída por 24 horas, usando resumos criptográficos protegidos em vez de guardar o conteúdo do e-mail no registro de idempotência. Uma solicitação repetida com a mesma chave e os mesmos dados pode ser reconhecida como já concluída ou ainda em processamento.

Se a mesma chave vier acompanhada de dados de mensagem diferentes, o MCPEmails devolve um conflito em vez de adivinhar qual versão você queria. E quando o resultado no provedor é realmente incerto, o produto continua conservador: ele evita transformar incerteza em um segundo envio.

Essa é a troca certa. Um fluxo pode pedir uma decisão humana quando necessário; ele não deve "resolver" a incerteza mandando e-mail duas vezes para alguém.

## Idempotência e aprovação humana trabalham juntas

A idempotência evita duplicação acidental. A aprovação controla se uma mensagem sensível pode sair da caixa, para começo de conversa. Elas resolvem problemas diferentes e funcionam bem em conjunto.

Por exemplo, um assistente de vendas pode rascunhar um acompanhamento, enviá-lo para [aprovação humana](/blog/approve-ai-agent-email-sends) e manter a mesma identidade segura para novas tentativas enquanto a solicitação é processada. Quem revisa vê uma mensagem proposta, não uma coleção de tentativas duplicadas.

## Mantenha a confiabilidade invisível para o destinatário

Os destinatários nunca deveriam saber que o seu agente repetiu uma solicitação. Eles devem ver uma mensagem bem pensada, na conversa certa, na hora certa. O MCPEmails também mantém o encadeamento das respostas, para que uma resposta fique na conversa original em vez de abrir uma cadeia de e-mails paralela.

É um detalhe pequeno de produto com um grande retorno em confiança. Ele permite usar um agente de IA para trabalho de verdade na caixa de entrada sem criar uma nova carga operacional a cada soluço temporário da rede.

Se você está montando seu primeiro fluxo de envio, comece com rascunhos e uma etapa de revisão. Depois ative o envio com aprovação obrigatória na caixa, se as mensagens forem de alto risco. A segurança para novas tentativas já está lá quando o fluxo precisar; você não precisa de um conjunto separado de ferramentas contra duplicação.`,
};

export default translation;
