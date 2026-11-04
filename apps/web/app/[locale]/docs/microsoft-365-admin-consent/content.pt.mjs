// Brazilian Portuguese copy for /docs/microsoft-365-admin-consent. Same shape
// as `en` in content.mjs; the source notes for every claim are there.
// Entra role names and portal labels follow Microsoft's pt-br page for
// grant-admin-consent (read 2026-11-03).

import { MS_GRANT, MS_ASSIGN, CLAUDE_M365 } from './links.mjs';

const pt = {
  meta: {
    title: 'Precisa de aprovação do administrador para o Outlook ou o Microsoft 365? Aprove o MCPEmails',
    description:
      'Por que a Microsoft mostra "Need admin approval" quando você conecta uma caixa de correio corporativa do Outlook ou do Microsoft 365 ao Claude ou ao ChatGPT, o link para enviar ao admin de TI e exatamente quais permissões o admin aprova.',
  },
  breadcrumb: 'Aprovação do administrador do Microsoft 365',
  eyebrow: 'Documentação',
  title: 'Microsoft 365: "Need admin approval"',
  lead:
    'A Microsoft mostra "Need admin approval" (é necessária a aprovação do administrador) quando a sua organização não permite que os funcionários aprovem, por conta própria, o acesso de um app ao e-mail. Um admin de TI aprova o MCPEmails uma vez, e depois todos na organização podem conectar a própria caixa de correio. Esta página é para vocês dois: o que faz quem está conectando e o que o admin está aprovando.',
  sections: [
    {
      id: 'why',
      h: 'Por que a Microsoft pede um admin',
      items: [
        'Desde o fim de 2025, a política de consentimento padrão da Microsoft para locatários corporativos e educacionais impede que os funcionários aprovem permissões de e-mail como `Mail.Read` e `Mail.ReadWrite` para um app. Em vez da tela de consentimento de sempre, a Microsoft mostra **Need admin approval**.',
        'Quem define isso é a sua organização, não a sua conta nem o MCPEmails. Ser um editor verificado não faz um app passar por esse bloqueio, e algumas organizações desativaram o consentimento do usuário para todos os apps.',
        'Contas pessoais da Microsoft (Outlook.com, Hotmail, Live) não têm organização nem admin, então nunca veem essa tela.',
        `O próprio conector do Microsoft 365 do Claude tem a mesma exigência: o [artigo de ajuda da Anthropic](${CLAUDE_M365}) diz que um Administrador Global do Microsoft Entra precisa dar consentimento antes que alguém da organização possa usá-lo. Os passos abaixo são para o MCPEmails, que conecta a caixa de correio ao Claude, ao ChatGPT e a outros clientes MCP.`,
      ],
    },
    {
      id: 'connecting',
      h: 'Se você está conectando sua caixa de correio',
      ordered: true,
      items: [
        'No painel do MCPEmails, abra **Caixas de entrada**, depois **Conectar caixa de entrada**, escolha o Outlook e clique em **Conectar com a Microsoft**.',
        'Se a Microsoft responder com **Need admin approval**, volte ao painel. Ele avisa que a sua organização precisa aprovar o acesso à caixa de correio e oferece **Gerar um link para o admin de TI**. A opção do Outlook na janela de conexão tem o mesmo link em **Gerar o link de aprovação para o admin**.',
        'Copie o link e envie para o admin de TI por e-mail ou chat. Ele vale por 7 dias e pode ser aberto mais de uma vez. O admin não precisa de uma conta no MCPEmails.',
        'Quando o admin tiver aprovado, clique em **Conectar com a Microsoft** de novo. Você entra com a sua própria conta e a caixa de entrada é conectada.',
      ],
    },
    {
      id: 'self-admin',
      h: 'Se você é o seu próprio admin',
      items: [
        'Na mesma janela, clique em **Sou o admin, aprovar agora**. A página de aprovação da Microsoft abre na sua aba e, depois de aprovar, você volta ao painel para conectar a caixa de correio.',
        'Nessa página, entre com uma conta que tenha uma das funções listadas na próxima seção. Uma conta de usuário sem função não consegue aprovar, mesmo em um locatário pequeno.',
      ],
    },
    {
      id: 'admin',
      h: 'Se você é o admin de TI',
      items: [
        'O link abre a página de consentimento do administrador da própria Microsoft (`login.microsoftonline.com/organizations/v2.0/adminconsent`) para o MCPEmails. Você entra com a sua conta corporativa da Microsoft na página da Microsoft. O MCPEmails nunca vê a sua senha.',
        `Para aprovar, é preciso uma função que possa conceder consentimento em todo o locatário para permissões delegadas. A [Microsoft lista](${MS_GRANT}) Administrador de Funções Privilegiadas, Administrador de Aplicativos na Nuvem, Administrador de Aplicativos e Administrador de IA, e um Administrador Global também pode fazer isso.`,
        'Revise as permissões e aceite. A aprovação vale uma vez para toda a organização. Cada pessoa continua entrando com a própria conta ao conectar e só tem acesso à própria caixa de correio.',
        'Em seguida, você chega a uma página do MCPEmails que informa se a Microsoft confirmou a aprovação. Não é preciso fazer mais nada.',
        'O link, por si só, não concede nada. Ele só inicia o fluxo da Microsoft, e nada muda no seu locatário até você aceitar lá.',
        `Prefere o centro de administração? Se o MCPEmails já aparece em **Entra ID**, **Aplicativos empresariais**, **Todos os aplicativos**, abra-o, escolha **Permissões** e clique em **Conceder consentimento do administrador**. O [guia da Microsoft](${MS_GRANT}) descreve esse caminho.`,
      ],
    },
    {
      id: 'permissions',
      h: 'O que o admin aprova',
      items: [
        '`Mail.ReadWrite` (delegada): ler e alterar e-mails na caixa de correio da pessoa conectada, para que a IA possa pesquisar, ler, escrever rascunhos, mover, sinalizar, gerenciar pastas e excluir.',
        '`Mail.Send` (delegada): enviar e-mails como a pessoa conectada. `Mail.ReadWrite` não cobre o envio, por isso é uma permissão separada.',
        '`offline_access`: manter a conexão funcionando sem precisar entrar de novo, até a pessoa desconectar ou o acesso ser removido.',
        'Quando cada pessoa entra, o MCPEmails também pede `openid`, `profile` e `email` para ler o nome e o endereço dela. As políticas de consentimento não restringem esses itens básicos de login, por isso a aprovação do admin não os inclui.',
        'Todas as permissões são delegadas. O MCPEmails não pede nenhuma permissão de aplicativo, então só age em nome da pessoa que entrou e não consegue abrir outras caixas de correio do seu locatário.',
        'As mensagens são buscadas na Microsoft em tempo real a cada solicitação e não são armazenadas. O token de cada login é armazenado criptografado, e os dados ficam em Estocolmo. Veja [segurança](/security).',
      ],
    },
    {
      id: 'control',
      h: 'Limitar ou remover o acesso depois',
      items: [
        `Para permitir que só algumas pessoas se conectem, ative **Assignment required** (atribuição obrigatória) para o MCPEmails em **Aplicativos empresariais** e atribua os usuários ou grupos que podem entrar. O [guia da Microsoft](${MS_ASSIGN}) traz os passos.`,
        'Para remover o acesso de toda a organização, exclua ou desative o MCPEmails em **Aplicativos empresariais**.',
        'Cada pessoa pode desconectar a própria caixa de correio a qualquer momento, excluindo a caixa de entrada no painel do MCPEmails.',
      ],
    },
    {
      id: 'problems',
      h: 'Se ainda não funcionar',
      items: [
        '**"A aprovação não foi concluída".** A Microsoft não confirmou a aprovação, então o Outlook continua bloqueado. O admin abre o link de novo, entrando com uma conta que tenha uma das funções acima.',
        '**"Não aprovado".** A aprovação foi cancelada na tela da Microsoft e nada mudou. Abra o link de novo quando estiver pronto.',
        '**"Este link expirou" ou "Este link não é válido".** Os links valem por 7 dias e precisam ser copiados inteiros. Gere um novo no painel.',
        '**"Comece de novo".** A aprovação levou mais de 10 minutos ou foi concluída em outro navegador. Abra o link de novo e conclua nesse navegador.',
        '**Sem caixa de correio do Outlook.** Uma conta sem caixa de correio do Exchange Online, como uma conta de admin sem licença do Exchange, não tem nada para conectar, então o MCPEmails a recusa. Se o seu e-mail está hospedado em outro lugar, conecte-o por IMAP.',
        '**Um formulário de solicitação em vez da página de aprovação.** Se a sua organização ativou o fluxo de trabalho de consentimento do administrador da Microsoft, quem tentar conectar pode ver um formulário para pedir aprovação. O admin pode aprovar essa solicitação ou simplesmente abrir o link do MCPEmails.',
      ],
    },
  ],
  evidence: {
    h: 'Confira você mesmo',
    intro: 'O MCPEmails é de código aberto. Estes arquivos criam o link, iniciam a aprovação e listam as permissões que esta página descreve:',
    labels: {
      link: 'O link de aprovação assinado, válido por sete dias, e os status de resultado',
      route: 'A rota pública que o link abre e as permissões que ela pede ao admin',
      oauth: 'As permissões que cada pessoa concede ao entrar e como uma resposta "Need admin approval" é reconhecida',
    },
  },
  cta: {
    title: 'Conecte sua caixa de correio do Microsoft 365',
    sub: 'Uma caixa de entrada é grátis, para sempre.',
    button: 'Começar',
    providers: 'Configuração do Microsoft 365',
  },
};

export default pt;
