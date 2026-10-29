import { MS_GRANT, MS_ASSIGN, CLAUDE_M365 } from './links.mjs';

const fr = {
  meta: {
    title: 'Approbation administrateur requise pour Outlook ou Microsoft 365 ? Approuver MCPEmails',
    description:
      'Pourquoi Microsoft affiche « Need admin approval » quand vous connectez une boîte Outlook ou Microsoft 365 professionnelle à Claude ou ChatGPT, le lien à envoyer à votre administrateur informatique, et les autorisations exactes qu\'il approuve.',
  },
  breadcrumb: 'Approbation administrateur Microsoft 365',
  eyebrow: 'Docs',
  title: 'Microsoft 365 : « Need admin approval »',
  lead:
    'Microsoft affiche « Need admin approval » quand votre organisation ne permet pas aux employés d\'autoriser eux-mêmes une application à accéder à leurs e-mails. Un administrateur informatique approuve MCPEmails une seule fois, puis chaque personne de l\'organisation peut connecter sa propre boîte. Cette page s\'adresse à vous deux : ce que fait la personne qui connecte sa boîte, et ce que l\'administrateur approuve.',
  sections: [
    {
      id: 'why',
      h: 'Pourquoi Microsoft demande un administrateur',
      items: [
        'Depuis fin 2025, la stratégie de consentement par défaut de Microsoft pour les tenants professionnels et scolaires empêche les employés d\'accorder à une application des autorisations de messagerie comme `Mail.Read` et `Mail.ReadWrite`. Microsoft affiche alors **Need admin approval** au lieu de l\'écran de consentement habituel.',
        'C\'est votre organisation qui fixe cette règle, pas votre compte ni MCPEmails. Le statut d\'éditeur vérifié ne permet pas à une application de la contourner, et certaines organisations ont désactivé le consentement des utilisateurs pour toutes les applications.',
        'Les comptes Microsoft personnels (Outlook.com, Hotmail, Live) n\'ont ni organisation ni administrateur : ils ne voient donc jamais cet écran.',
        `Le connecteur Microsoft 365 de Claude a la même exigence : [l'article d'aide d'Anthropic](${CLAUDE_M365}) indique qu'un administrateur général Microsoft Entra doit donner son consentement avant que quiconque dans l'organisation puisse l'utiliser. Les étapes ci-dessous concernent MCPEmails, qui connecte la boîte à Claude, ChatGPT et d'autres clients MCP.`,
      ],
    },
    {
      id: 'connecting',
      h: 'Si vous connectez votre boîte',
      ordered: true,
      items: [
        'Dans le tableau de bord MCPEmails, ouvrez **Boîtes**, puis **Connecter la boîte**, choisissez Outlook et cliquez sur **Se connecter avec Microsoft**.',
        'Si Microsoft répond **Need admin approval**, revenez au tableau de bord. Il indique que votre organisation doit autoriser l\'accès à la boîte et propose **Obtenir un lien pour votre administrateur informatique**. L\'option Outlook de la fenêtre de connexion donne le même lien sous **Obtenir le lien d\'approbation pour votre administrateur**.',
        'Copiez le lien et envoyez-le à votre administrateur informatique par e-mail ou par messagerie. Il reste valable 7 jours et peut être ouvert plusieurs fois. Votre administrateur n\'a pas besoin de compte MCPEmails.',
        'Une fois l\'approbation donnée, cliquez à nouveau sur **Se connecter avec Microsoft**. Vous vous connectez avec votre propre compte et la boîte est connectée.',
      ],
    },
    {
      id: 'self-admin',
      h: 'Si vous êtes votre propre administrateur',
      items: [
        'Dans la même fenêtre, cliquez sur **Je suis l\'administrateur, approuver maintenant**. La page d\'approbation de Microsoft s\'ouvre dans votre onglet et, une fois l\'approbation donnée, vous revenez au tableau de bord pour connecter la boîte.',
        'Sur cette page, connectez-vous avec un compte qui détient l\'un des rôles listés dans la section suivante. Un compte utilisateur sans rôle ne peut pas approuver, même dans un petit tenant.',
      ],
    },
    {
      id: 'admin',
      h: 'Si vous êtes l\'administrateur informatique',
      items: [
        'Le lien ouvre la page de consentement administrateur de Microsoft (`login.microsoftonline.com/organizations/v2.0/adminconsent`) pour MCPEmails. Vous vous connectez avec votre compte professionnel Microsoft sur la page de Microsoft. MCPEmails ne voit jamais votre mot de passe.',
        `Pour approuver, il faut un rôle capable d'accorder un consentement à l'échelle du tenant pour des autorisations déléguées. [Microsoft cite](${MS_GRANT}) Privileged Role Administrator, Cloud Application Administrator, Application Administrator et AI Administrator, et un Global Administrator peut aussi le faire.`,
        'Vérifiez les autorisations et acceptez. L\'approbation couvre toute l\'organisation, une seule fois. Chaque personne se connecte quand même avec son propre compte au moment de connecter sa boîte, et n\'a accès qu\'à sa propre boîte.',
        'Vous arrivez ensuite sur une page MCPEmails qui indique si Microsoft a confirmé l\'approbation. Vous n\'avez rien d\'autre à faire.',
        'Le lien n\'accorde rien à lui seul. Il ne fait que lancer le processus de Microsoft, et rien ne change dans votre tenant tant que vous n\'avez pas accepté là-bas.',
        `Vous préférez le centre d'administration ? Si MCPEmails apparaît déjà sous **Entra ID**, **Enterprise apps**, **All applications**, ouvrez-le, choisissez **Permissions** et cliquez sur **Grant admin consent**. [Le guide de Microsoft](${MS_GRANT}) décrit cette méthode.`,
      ],
    },
    {
      id: 'permissions',
      h: 'Ce que l\'administrateur approuve',
      items: [
        '`Mail.ReadWrite` (délégué) : lire et modifier les e-mails dans la boîte de la personne connectée, pour que l\'IA puisse rechercher, lire, rédiger des brouillons, déplacer, marquer d\'un indicateur, gérer les dossiers et supprimer.',
        '`Mail.Send` (délégué) : envoyer des e-mails au nom de la personne connectée. `Mail.ReadWrite` ne couvre pas l\'envoi, c\'est donc une autorisation distincte.',
        '`offline_access` : garder la connexion active sans se reconnecter, jusqu\'à ce que la personne se déconnecte ou que l\'accès soit retiré.',
        'Quand chaque personne se connecte, MCPEmails demande aussi `openid`, `profile` et `email` pour lire son nom et son adresse. Les stratégies de consentement ne restreignent pas ces éléments de base de la connexion, ils ne font donc pas partie de l\'approbation administrateur.',
        'Toutes les autorisations sont déléguées. MCPEmails ne demande aucune autorisation d\'application : il agit uniquement pour la personne connectée et ne peut pas ouvrir d\'autres boîtes de votre tenant.',
        'Les messages sont récupérés en direct chez Microsoft à chaque requête et ne sont pas stockés. Le jeton issu de chaque connexion est chiffré au repos, et les données sont stockées à Stockholm. Consultez la page [sécurité](/security).',
      ],
    },
    {
      id: 'control',
      h: 'Limiter ou retirer l\'accès plus tard',
      items: [
        `Pour que seules certaines personnes puissent se connecter, activez **Assignment required** pour MCPEmails sous **Enterprise apps** et affectez les utilisateurs ou groupes autorisés. [Le guide de Microsoft](${MS_ASSIGN}) donne les étapes.`,
        'Pour le retirer à toute l\'organisation, supprimez ou désactivez MCPEmails sous **Enterprise apps**.',
        'Chaque personne peut déconnecter sa propre boîte à tout moment en supprimant la boîte dans le tableau de bord MCPEmails.',
      ],
    },
    {
      id: 'problems',
      h: 'Si cela ne fonctionne toujours pas',
      items: [
        '**« L\'approbation n\'a pas abouti ».** Microsoft n\'a pas confirmé l\'approbation : Outlook reste donc bloqué. L\'administrateur ouvre à nouveau le lien, connecté avec un compte qui détient l\'un des rôles ci-dessus.',
        '**« Non approuvé ».** L\'approbation a été annulée sur l\'écran de Microsoft et rien n\'a changé. Ouvrez à nouveau le lien quand vous êtes prêt.',
        '**« Ce lien a expiré » ou « Ce lien n\'est pas valide ».** Les liens restent valables 7 jours et doivent être copiés en entier. Obtenez-en un nouveau depuis le tableau de bord.',
        '**« Veuillez recommencer ».** L\'approbation a pris plus de 10 minutes ou s\'est terminée dans un autre navigateur. Ouvrez à nouveau le lien et terminez dans ce navigateur.',
        '**Aucune boîte Outlook.** Un compte sans boîte Exchange Online, comme un compte administrateur sans licence Exchange, n\'a rien à connecter : MCPEmails le refuse donc. Si votre messagerie est hébergée ailleurs, connectez-la plutôt en IMAP.',
        '**Un formulaire de demande au lieu de la page d\'approbation.** Si votre organisation a activé le workflow de consentement administrateur de Microsoft, un utilisateur qui tente de se connecter peut voir un formulaire pour demander l\'approbation. L\'administrateur peut approuver cette demande, ou simplement ouvrir le lien MCPEmails.',
      ],
    },
  ],
  evidence: {
    h: 'Vérifiez par vous-même',
    intro: 'MCPEmails est open source. Ces fichiers créent le lien, lancent l\'approbation et listent les autorisations décrites sur cette page :',
    labels: {
      link: 'Le lien d\'approbation signé, valable sept jours, et les statuts de résultat',
      route: 'La route publique qu\'ouvre le lien, et les autorisations qu\'elle demande à l\'administrateur',
      oauth: 'Les autorisations que chaque personne accorde à la connexion, et la façon dont une réponse « Need admin approval » est reconnue',
    },
  },
  cta: {
    title: 'Connectez votre boîte Microsoft 365',
    sub: 'Une boîte est gratuite, pour toujours.',
    button: 'Commencer',
    providers: 'Configuration Microsoft 365',
  },
};

export default fr;
