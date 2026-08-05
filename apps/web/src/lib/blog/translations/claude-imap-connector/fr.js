export default {
  title: 'Connecteur IMAP Claude : connectez n’importe quelle boîte IMAP à Claude',
  description:
    'Configurez un connecteur IMAP Claude avec les réglages IMAP/SMTP, un mot de passe d’application et TLS, plus sécurité, limites et dépannage.',
  coverAlt: 'Claude connecté à une boîte IMAP et SMTP via MCPEmails',
  content: `Un **connecteur IMAP Claude** permet à Claude d’utiliser des boîtes mail dépourvues d’intégration Claude native : Fastmail, iCloud Mail, Yahoo, Zoho, Yandex, une boîte sur votre propre domaine ou presque tout fournisseur proposant IMAP et SMTP.

Claude ne se connecte pas au serveur de messagerie et ne manipule pas directement le mot de passe de votre boîte. MCPEmails fait l’intermédiaire. Il se connecte au fournisseur en IMAP pour les messages entrants et en SMTP pour les messages sortants, puis fournit à Claude un ensemble cohérent d’outils [Model Context Protocol](https://modelcontextprotocol.io). Cette distinction est importante : IMAP et SMTP gèrent la boîte, tandis que MCP fournit à Claude des actions sûres et structurées, comme lire, rechercher, répondre et déplacer.

Ce guide couvre le connecteur générique et la configuration côté Claude. Si vous utilisez iCloud ou Fastmail et souhaitez voir précisément leurs écrans de mot de passe d’application et leurs noms de serveur, gardez ouvert en parallèle le [guide dédié à iCloud, Fastmail et IMAP](/blog/connect-icloud-fastmail-imap-to-claude).

## Ce que fait réellement le connecteur IMAP Claude

La connexion comporte trois parties :

1. **Votre fournisseur de messagerie** expose IMAP pour lire et organiser les messages, ainsi que SMTP pour les envoyer.
2. **MCPEmails** conserve l’identifiant de messagerie sous forme chiffrée, communique avec ces serveurs et transforme leurs réponses en outils de messagerie prévisibles.
3. **Claude** se connecte à l’endpoint MCP et appelle uniquement les outils autorisés par les scopes que vous approuvez.

Claude n’a donc besoin ni d’une bibliothèque IMAP, ni d’une configuration SMTP, ni d’un mot de passe dans son prompt. Une fois connecté, il peut utiliser \`inbox_list\` pour découvrir la boîte, \`email_read\` pour lister, lire, rechercher ou récupérer des pièces jointes, \`email_compose\` pour envoyer, répondre et transférer, et \`email_organize\` pour déplacer, copier, marquer ou archiver des messages. Des outils distincts couvrent les dossiers, brouillons, planifications, contacts et suppressions ; la liste complète figure dans la [référence des outils](/docs#tools).

## Ce qu’il vous faut avant la configuration

Rassemblez les informations suivantes depuis la page d’aide de votre fournisseur de messagerie ou auprès de votre administrateur :

- **Adresse e-mail :** par exemple, \`you@example.com\`. C’est l’adresse affichée sur la boîte connectée.
- **Nom d’utilisateur :** généralement l’adresse e-mail complète. Certains hébergeurs de domaines personnalisés fournissent un identifiant IMAP/SMTP différent.
- **Hôte et port IMAP :** par exemple, \`imap.example.com\` sur le port \`993\` pour IMAP avec TLS implicite. Cette connexion gère la lecture, la recherche, les dossiers et les actions sur les messages.
- **Hôte et port SMTP :** par exemple, \`smtp.example.com\` sur le port \`465\` ou \`587\`. Le port \`465\` utilise TLS implicite ; le \`587\` passe à une connexion sécurisée avec STARTTLS. Cette connexion gère l’envoi, les réponses et les transferts.
- **Mot de passe :** de préférence un mot de passe d’application révocable créé pour l’accès depuis un client de messagerie.

Ne déduisez pas les noms de serveur du domaine si votre fournisseur publie ses paramètres. L’hébergement de la messagerie est souvent distinct de celui du site web, et une adresse sur un domaine personnalisé peut utiliser un identifiant propre au fournisseur, différent de l’adresse visible.

Utilisez un **mot de passe d’application** dès que le fournisseur le permet. Il est distinct du mot de passe principal du compte et peut être révoqué sans changer celui que vous utilisez pour vous connecter. Les fournisseurs exigent souvent l’authentification à deux facteurs avant de permettre sa création. Certains demandent également d’activer d’abord l’accès IMAP dans les réglages de messagerie.

MCPEmails inclut des préréglages pour iCloud, Yahoo, Zoho et Yandex, ainsi qu’un flux dédié aux mots de passe d’application Fastmail. Ces choix renseignent automatiquement les hôtes et ports connus. Choisissez **Generic IMAP** pour un autre fournisseur ou votre propre serveur de messagerie, puis saisissez vous-même les valeurs.

## Étape 1 : connecter la boîte IMAP/SMTP

1. [Créez un compte MCPEmails ou connectez-vous](/signup), puis ouvrez **Dashboard → Inboxes → Connect Inbox**.
2. Sélectionnez le fournisseur nommé lorsqu’il est disponible. Sinon, choisissez **IMAP / SMTP**.
3. Saisissez l’adresse e-mail et le mot de passe d’application. Pour le connecteur générique, indiquez également l’hôte et le port IMAP, l’hôte et le port SMTP, ainsi qu’un nom d’utilisateur distinct si votre hébergeur vous en a fourni un.
4. Enregistrez la connexion. MCPEmails valide l’identifiant auprès du serveur IMAP avant d’enregistrer la boîte : un identifiant refusé ou un endpoint TLS inaccessible échoue donc ici, au lieu de provoquer une erreur ultérieure dans Claude.

Les valeurs sécurisées habituelles sont IMAP \`993\`, puis SMTP \`465\` ou \`587\`. Elles ne sont pas interchangeables : utilisez le port et le mode de sécurité documentés par le fournisseur. MCPEmails traite le port SMTP \`587\` comme STARTTLS et les autres ports SMTP configurés comme TLS implicite. Les connexions sans prise en charge de TLS sont refusées.

## Étape 2 : ajouter MCPEmails comme connecteur Claude

Une fois la boîte connectée, dirigez Claude vers MCPEmails :

1. Dans claude.ai, ouvrez **Customize → Connectors**.
2. Choisissez **Add connector** et saisissez \`https://www.mcpemails.com/api/mcp\`.
3. Sélectionnez **Connect**, connectez-vous à MCPEmails et n’approuvez que les autorisations nécessaires au workflow.

Par exemple, un outil de synthèse a besoin d’un accès en lecture et en recherche, mais pas des droits d’envoi ou de suppression. Un workflow de réponse a besoin de l’accès en envoi. La gestion des dossiers et la suppression définitive disposent de leurs propres scopes ; vous pouvez ainsi laisser les actions destructrices indisponibles jusqu’à ce qu’elles soient réellement utiles. Consultez le [guide de connexion de Claude à la messagerie](/blog/connect-claude-to-email) pour davantage de détails sur le parcours côté client.

Effectuez ensuite un petit test de bon fonctionnement :

\`\`\`
Utilise inbox_list pour trouver ma boîte IMAP. Liste mes cinq messages non lus les plus récents et résume-les. N’envoie, ne déplace et ne supprime rien.
\`\`\`

Commencer par \`inbox_list\` permet à Claude d’obtenir le bon \`inbox_id\` au lieu de s’appuyer sur un UUID copié.

## Ce que Claude peut faire via IMAP

Une fois la connexion établie, Claude peut :

- Lister et lire les messages récupérés en direct auprès du fournisseur.
- Rechercher par expéditeur, destinataire, objet, texte du message, statut lu, statut marqué et dates.
- Télécharger ou extraire les pièces jointes prises en charge, dans les limites documentées de taille et de format.
- Envoyer de nouveaux messages via SMTP, ou répondre et transférer tout en conservant le contexte pertinent du message.
- Déplacer, copier, marquer, archiver et organiser les messages dans les dossiers IMAP.
- Créer et gérer des brouillons, planifier des messages et rechercher des contacts lorsque l’outil prend en charge l’opération.
- Déplacer des messages vers la corbeille ou, avec l’autorisation explicite de suppression et \`permanent: true\`, les effacer définitivement en IMAP.

Cette dernière capacité exige de la prudence. La suppression IMAP définitive contourne la corbeille et peut être irréversible. MCPEmails expose la suppression sous forme d’un outil destructeur distinct, et le client MCP contrôle le comportement de confirmation, mais vous ne devez accorder \`delete:email\` qu’aux workflows qui en ont besoin.

## Limites importantes d’IMAP

Un connecteur IMAP est très polyvalent, mais il ne rend pas tous les fournisseurs identiques.

- **Pas de notification push des nouveaux messages :** MCPEmails fonctionne uniquement en requête/réponse. Il n’envoie pas de webhooks et ne déclenche pas Claude à l’arrivée d’un message. Un workflow automatisé doit interroger la boîte à intervalles réguliers, par exemple en listant les messages non lus.
- **La recherche varie selon le transport :** les filtres structurés d’expéditeur, d’objet, de texte et de date fonctionnent chez tous les fournisseurs, mais l’IMAP générique ne prend pas en charge le filtre de recherche \`has_attachment\`. La syntaxe de recherche propre à un fournisseur n’est pas portable.
- **Les dossiers ne sont pas des libellés Gmail :** IMAP déplace un message entre des dossiers, tandis que Gmail peut associer plusieurs libellés à un même message. La différence pratique est expliquée dans [Libellés Gmail ou dossiers IMAP](/blog/gmail-labels-vs-imap-folders-ai-agents).
- **SMTP est obligatoire pour envoyer :** une connexion IMAP fonctionnelle prouve que Claude peut accéder aux messages entrants, pas que l’hôte ou le port SMTP ni l’autorisation d’envoi sont corrects. Testez un message sortant sans risque avant de compter sur un workflow de réponse.
- **Les politiques du fournisseur s’appliquent toujours :** quotas de boîte, limites d’envoi, limites de connexions simultanées, contrôles anti-spam et restrictions administratives restent en vigueur.

## Dépanner une connexion IMAP Claude

### « Authentication failed » lors de la connexion de la boîte

Utilisez un mot de passe d’application, pas celui avec lequel vous vous connectez au site du fournisseur. Vérifiez que l’authentification à deux facteurs et l’accès IMAP sont activés si le fournisseur l’exige. Recopiez le mot de passe généré sans espaces au début ni à la fin. Si l’adresse utilise un domaine personnalisé, vérifiez si le nom d’utilisateur est l’adresse e-mail complète ou un nom de compte distinct.

### Le serveur expire ou TLS échoue

Vérifiez l’orthographe de l’hôte et utilisez les ports sécurisés documentés par le fournisseur. Commencez par IMAP \`993\` ; pour SMTP, utilisez le port \`465\` ou \`587\` indiqué. Le nom d’hôte du site web, du panneau de contrôle ou le domaine nu n’est pas nécessairement un serveur de messagerie. Sur un serveur privé, vérifiez également que son pare-feu accepte les connexions provenant de l’extérieur de votre réseau et que son certificat TLS correspond au nom d’hôte de messagerie.

### Claude peut lire, mais pas envoyer

Les réglages IMAP fonctionnent, mais SMTP est distinct. Revérifiez le nom d’hôte et le port SMTP, confirmez que l’identifiant dispose d’un accès SMTP ou « mail », et vérifiez que le fournisseur autorise l’envoi authentifié pour l’adresse From. Les mots de passe d’application Fastmail, par exemple, doivent être créés avec l’accès **Mail (IMAP/SMTP)** et non avec un accès en lecture seule.

### Claude ne trouve pas la boîte

Demandez à Claude d’appeler de nouveau \`inbox_list\`. Si la boîte n’apparaît pas, vérifiez son statut dans le dashboard MCPEmails et reconnectez-la si le mot de passe d’application a été révoqué ou remplacé. Si elle apparaît, mais qu’une action est refusée, reconnectez le connecteur Claude ou mettez à jour la clé API avec le scope nécessaire.

### Les résultats de recherche sont plus restreints que prévu

Commencez par des champs structurés comme \`from\`, \`subject\`, \`text\`, \`since\` et \`before\`, puis précisez les dossiers à rechercher si nécessaire. Ne copiez pas la syntaxe des opérateurs Gmail dans une recherche IMAP générique en espérant un comportement identique. N’oubliez pas que le filtrage selon la présence d’une pièce jointe est ignoré en IMAP générique.

## Sécurité : les identifiants restent hors de Claude

MCPEmails conserve le jeton OAuth ou le mot de passe d’application IMAP nécessaire aux appels futurs, chiffré au repos avec AES-256-GCM. Le contenu ordinaire de la boîte est récupéré en direct lors de l’exécution d’un outil et n’est pas conservé entre les appels. Le trafic utilise TLS, et vous pouvez révoquer un mot de passe d’application auprès du fournisseur ou déconnecter la boîte depuis le dashboard.

Cette séparation nette est la principale raison d’utiliser un pont MCP au lieu de coller des identifiants de messagerie dans un chat ou une configuration locale : Claude reçoit des capacités de messagerie limitées par des scopes, et non les clés de la boîte. Pour en savoir plus sur le stockage et le modèle de menace, consultez [pourquoi le fait que « les e-mails ne sont jamais stockés » est important](/blog/why-email-never-stored-matters) et la [présentation de la sécurité](/security).

## En bref

Un connecteur IMAP Claude est une connexion à une boîte IMAP/SMTP présentée à Claude sous forme d’outils MCP. Rassemblez les paramètres sécurisés du serveur, créez un mot de passe d’application révocable, connectez la boîte dans MCPEmails, puis ajoutez \`https://www.mcpemails.com/api/mcp\` dans Claude. Testez d’abord l’accès en lecture seule, ajoutez délibérément les scopes d’envoi ou destructeurs, et utilisez la liste de dépannage ci-dessus si le fournisseur refuse la connexion.

Prêt à essayer ? [Connectez une boîte IMAP](/signup), ou utilisez le [guide de configuration propre au fournisseur](/blog/connect-icloud-fastmail-imap-to-claude) pour les détails concernant iCloud et Fastmail.`,
};
