const translation = {
  title: 'Connecteurs personnalisés Claude : forfaits, configuration, OAuth et sécurité',
  description:
    'Connecteurs personnalisés Claude : forfaits et applications compatibles, ajout d’un serveur MCP distant par URL, options de connexion, contrôles admin et sécurité.',
  coverAlt: 'Les connecteurs personnalisés Claude expliqués : un serveur MCP distant ajouté à Claude par URL',
  content: `Les **connecteurs personnalisés Claude** permettent d’ajouter à Claude n’importe quel serveur [Model Context Protocol](https://modelcontextprotocol.io) distant en collant simplement son URL. Une fois le connecteur ajouté, Claude peut appeler les outils de ce serveur dans vos conversations : interroger une base de données, créer un ticket ou, dans l’exemple complet à la fin de ce guide, lire et envoyer vos e-mails.

Les informations sur les forfaits et les menus ci-dessous proviennent des pages d’aide d’Anthropic, vérifiées le 26 octobre 2026. L’interface de Claude évolue souvent : si un libellé diffère, le [guide des connecteurs personnalisés](https://support.claude.com/fr/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) d’Anthropic fait foi. Les libellés de l’interface sont donnés tels qu’ils apparaissent dans Claude en français.

## Qu’est-ce qu’un connecteur personnalisé Claude ?

Un connecteur personnalisé Claude est un serveur MCP distant que vous ajoutez à Claude par son URL, au lieu de le choisir dans le répertoire des connecteurs. Le serveur tourne sur Internet, expose un ensemble d’outils et vous demande en général de vous connecter via OAuth. Claude appelle ensuite ces outils en votre nom, dans la limite des autorisations que vous avez accordées.

Trois points à connaître dès le départ :

- **Anthropic ne vérifie pas les connecteurs personnalisés.** Les fiches du répertoire portent un label Verified ou Community. Un connecteur ajouté par URL relie Claude à un service qu’Anthropic n’a pas examiné : vous faites confiance à la personne ou à l’entreprise qui exploite le serveur.
- **La connexion part du cloud d’Anthropic, pas de votre ordinateur.** Anthropic précise que c’est le cas dans tous les clients Claude, y compris claude.ai, Claude Desktop, Cowork et les applications mobiles. Le serveur doit donc être joignable depuis l’Internet public. Un serveur sur un réseau privé ou derrière un VPN ne se connectera pas, sauf si son pare-feu autorise les plages d’adresses IP d’Anthropic ou s’il est atteint via ce qu’Anthropic appelle un tunnel MCP.
- **On l’ajoute une fois par compte, pas une fois par appareil.**

Si vous découvrez MCP, l’article [qu’est-ce qu’un serveur MCP pour l’e-mail](/blog/what-is-an-mcp-email-server) présente le protocole avec l’e-mail comme exemple.

## Connecteurs personnalisés, connecteurs du répertoire et extensions de bureau

Claude dispose de trois moyens d’accéder à un outil externe :

- **Les connecteurs du répertoire** figurent dans le répertoire des connecteurs de Claude. Vous les parcourez sous **Personnaliser → Connecteurs** et cliquez sur **Connecter**. Les connecteurs Gmail et Microsoft 365 de Claude font partie de ce groupe.
- **Les connecteurs personnalisés** sont des serveurs MCP distants ajoutés par URL. C’est le sujet de ce guide.
- **Les extensions de bureau** sont des serveurs MCP locaux empaquetés sous forme de fichiers \`.mcpb\` et installés sous **Settings → Extensions** dans l’application Claude Desktop. Elles s’exécutent sur votre propre ordinateur. Les serveurs locaux déclarés dans \`claude_desktop_config.json\` constituent encore un autre mécanisme et ne sont pas disponibles dans claude.ai ni dans Cowork.

Claude Code ajoute le même type de serveur distant depuis le terminal ; la [page de configuration Claude Code](/docs/claude-code) donne la commande pour MCPEmails. Pour comprendre en quoi un serveur MCP généraliste se comporte différemment d’un connecteur intégré limité à un seul fournisseur, voir [connecteurs natifs et MCP comparés](/native-connectors-vs-mcp).

## Quels forfaits et applications Claude prennent en charge les connecteurs personnalisés

D’après le centre d’aide d’Anthropic, en octobre 2026 :

- **Forfaits :** les connecteurs personnalisés sont disponibles sur les forfaits Free, Pro, Max, Team et Enterprise. Le forfait Free est limité à un seul connecteur personnalisé ; Pro et Max n'ont pas de limite.
- **Applications où on les ajoute :** claude.ai sur le web, Claude Desktop et Cowork.
- **Mobile :** un connecteur connecté sur le web ou dans Claude Desktop devient disponible dans Claude pour iOS et Android à votre prochaine connexion sur ces applications. Anthropic présente l’installation de connecteurs sur mobile comme une bêta et considère le web et l’application de bureau comme la voie principale pour les connecteurs personnalisés : configurez-le donc d’abord sur un ordinateur.
- **Qui peut en ajouter un sur un forfait professionnel :** sur Team, uniquement les propriétaires et propriétaires principaux. Sur Enterprise, les propriétaires, les propriétaires principaux et les personnes dotées d’un rôle personnalisé qui inclut la gestion des bibliothèques de l’organisation.

## Ajouter un connecteur personnalisé sur Free, Pro ou Max

1. Ouvrez **Personnaliser → Connecteurs** dans claude.ai ou Claude Desktop.
2. Cliquez sur **+ Ajouter**, puis sur **Ajouter un connecteur personnalisé**.
3. Saisissez un nom et l’URL du serveur, puis cliquez sur **Continuer**.
4. Vérifiez les paramètres de connexion détectés par Claude. Les valeurs par défaut conviennent généralement, et la section suivante explique les différents choix.
5. Cliquez sur **Ajouter**, puis connectez-vous au service.

Les paramètres d’authentification d’un connecteur ne peuvent plus être modifiés une fois celui-ci ajouté. Pour les changer, supprimez le connecteur et ajoutez-le de nouveau. Pour en supprimer un, ouvrez **Personnaliser → Connecteurs** et utilisez **Supprimer** ou le menu à trois points à côté du connecteur.

## Ajouter un connecteur personnalisé pour une organisation sur Team et Enterprise

Sur les forfaits Team et Enterprise, ajouter un connecteur et s’y connecter sont deux étapes distinctes :

1. **Un propriétaire l’ajoute pour l’organisation.** Ouvrez **Paramètres de l’organisation → Connecteurs**, cliquez sur **Ajouter**, choisissez **Personnalisé**, puis **Web** si Claude demande un type. Saisissez le nom et l’URL, puis terminez les mêmes écrans d’authentification.
2. **Chaque membre se connecte avec son propre compte.** Les membres ouvrent **Personnaliser → Connecteurs**, trouvent le connecteur, qui porte généralement le label **Personnalisé**, et cliquent sur **Connecter**.

Comme chacun se connecte individuellement, Claude n’accède qu’à ce que cette personne peut atteindre dans le service connecté. Seule exception : un connecteur configuré avec un identifiant partagé, comme une clé API. Toute personne qui l’utilise dispose alors des accès de cet identifiant.

Les propriétaires peuvent aussi limiter ce qu’un connecteur a le droit de faire dans toute l’organisation. Chaque outil peut être réglé sur **Toujours autoriser**, **Needs approval** (approbation requise) ou **Blocked** (bloqué), et les utilisateurs ne peuvent pas passer outre le réglage de l’organisation. L’exemple donné par Anthropic est proche du cas de l’e-mail présenté plus bas : laisser Claude rechercher et résumer les e-mails, mais l’empêcher d’envoyer des messages.

Les membres qui ne peuvent pas ajouter de connecteur eux-mêmes doivent passer par un propriétaire. Le bouton **Request** proposé par Claude concerne les fiches du répertoire : pour une URL personnalisée, envoyez directement l’URL à votre propriétaire.

## Options de connexion : OAuth, enregistrement automatique ou aucune connexion

Lorsque vous ajoutez un connecteur, Claude affiche jusqu’à trois groupes de paramètres. Les valeurs détectées sont en général les bonnes.

**L’authentification** détermine quand les utilisateurs se connectent :

- **Se connecter maintenant :** chaque utilisateur passe par la connexion OAuth du serveur avant d’utiliser le connecteur. C’est le bon choix pour un serveur qui détient des données personnelles.
- **Se connecter si nécessaire :** Claude se connecte sans identifiants et demande aux utilisateurs de se connecter lorsque le serveur l’exige.
- **Pas de connexion :** toute personne qui possède l’URL peut utiliser le connecteur. Cette option couvre aussi les serveurs qui attendent une clé API fixe, que vous ajoutez alors sous forme d’en-tête de requête.

**Le client OAuth** détermine la façon dont Claude s’identifie auprès du système de connexion du serveur. Ce groupe est masqué si vous choisissez Pas de connexion :

- **Utiliser l’identité publiée de Claude** est l’option recommandée par Anthropic. Le serveur lit les informations de Claude dans un Client ID Metadata Document hébergé par Anthropic : rien n’est à configurer, à condition que le serveur prenne en charge cette méthode.
- **S’enregistrer automatiquement** utilise l’OAuth Dynamic Client Registration, que la plupart des serveurs MCP prennent en charge.
- **Utiliser votre propre client OAuth** sert lorsque vous avez vous-même enregistré un identifiant client auprès du serveur.

**Les en-têtes de requête** contiennent des identifiants fixes, comme une clé API ou un jeton bearer. Claude les stocke de manière sécurisée, ne les réaffiche plus après l’enregistrement et les envoie à chaque requête, avec un maximum de quatre en-têtes par connecteur. Anthropic indique que les en-têtes de requête sont une bêta réservée à un nombre limité d’organisations : il se peut que cette section n’apparaisse pas chez vous.

La différence concrète : avec OAuth, chaque personne se connecte sous sa propre identité, approuve des autorisations précises et peut révoquer l’accès sans que personne ne partage de secret. Avec une clé fixe, un seul identifiant donne les mêmes accès à tous ceux qui utilisent le connecteur. L’article [OAuth ou clés API pour l’accès d’une IA aux e-mails](/blog/oauth-vs-api-keys-ai-email-access) approfondit ce compromis.

## Activer un connecteur dans une conversation

Ajouter un connecteur ne signifie pas que chaque conversation l’utilise. Dans une conversation, cliquez sur le bouton **+** en bas à gauche, ouvrez **Connecteurs** et activez ou désactivez chaque connecteur pour cette conversation. Claude peut aussi proposer de lui-même une application connectée quand elle correspond à la demande.

Pour contrôler les outils un par un, ouvrez **Personnaliser → Connecteurs**, sélectionnez le connecteur et réglez chaque outil, ou chaque groupe d’outils en lecture seule et en écriture, sur **Toujours autoriser**, **Needs approval** ou **Blocked**. Lorsque Claude demande à exécuter un outil, ne choisissez **Toujours autoriser** que pour les serveurs et les outils que vous êtes prêt à laisser agir sans supervision.

## Liste de contrôle de sécurité avant de connecter

Les recommandations d’Anthropic se résument en cinq points :

- **Ne vous connectez qu’à des serveurs exploités par des organisations de confiance.** C’est le serveur qui décide de ce que font ses outils, et il peut les modifier plus tard.
- **Lisez les autorisations sur l’écran de connexion.** Accordez le minimum nécessaire et refusez tout ce qui semble superflu.
- **Traitez les résultats des outils comme non fiables.** Une page web, un ticket ou un e-mail peut contenir du texte rédigé pour orienter Claude. Anthropic indique que Claude intègre des protections contre l’injection de prompt, mais il faut tout de même surveiller ce qui entre et ce qui sort.
- **Bloquez ou soumettez à approbation les actions d’écriture dont vous n’avez pas besoin.** L’envoi, la suppression et le déplacement sont les actions où une erreur devient visible pour d’autres personnes.
- **Soyez prudent avec la fonction Recherche.** Anthropic signale qu’elle peut appeler automatiquement les outils des connecteurs sans demander à chaque fois : désactivez donc les outils d’écriture avant de l’utiliser avec un connecteur.

## Exemple complet : vos e-mails dans Claude avec MCPEmails

L’e-mail met tout ce qui précède à l’épreuve : une boîte de réception contient des données privées, et l’envoi est une action bien réelle. MCPEmails est un serveur MCP hébergé qui connecte Gmail, Outlook et Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex et d’autres boîtes IMAP, et les présente à Claude sous la forme d’un seul connecteur personnalisé.

**1. Connectez une boîte à MCPEmails.** [Créez un compte](/signup), puis, dans le tableau de bord, ouvrez **Boîtes → Connecter une boîte**. Outlook et Microsoft 365 utilisent **Se connecter avec Microsoft**, la plupart des autres fournisseurs un mot de passe d’application, et les [pages fournisseurs](/connect) indiquent les réglages de chacun. La [page de configuration Claude](/docs/claude) résume les étapes 1 et 2.

**2. Ajoutez le connecteur dans Claude.** Sous **Personnaliser → Connecteurs**, cliquez sur **+ Ajouter**, puis sur **Ajouter un connecteur personnalisé**, nommez-le MCPEmails, saisissez l’URL ci-dessous et cliquez sur **Continuer** :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

**3. Choisissez les paramètres de connexion.** Sélectionnez **Se connecter maintenant**. Pour le client OAuth, les deux premières options fonctionnent : MCPEmails prend en charge l’identité publiée de Claude et l’enregistrement automatique. Laissez les en-têtes de requête vides, puisque OAuth ne nécessite aucune clé API.

**4. Connectez-vous et choisissez les accès.** Cliquez sur **Ajouter**, connectez-vous à MCPEmails et approuvez les autorisations sur l’écran de consentement. Claude ne demande d’abord que \`read:email\`, et l’écran s’ouvre sur l’option en lecture seule correspondante. N’ajoutez \`send:email\`, \`manage:drafts\`, \`manage:folders\` ou \`delete:email\` que lorsqu’un workflow en a besoin. Un jeton sans \`send:email\` ne peut pas envoyer, quoi qu’on demande à Claude. Si une requête ultérieure nécessite une autorisation que vous n’avez pas accordée, MCPEmails répond par une erreur \`insufficient_scope\` qui nomme le scope manquant. Lors de la reconnexion, cochez cette autorisation sur l’écran de consentement. La [page sur l’accès en lecture seule](/docs/read-only-access) détaille ce qu’un accès en lecture seule permet et ne permet pas.

**5. Réglez les autorisations des outils dans Claude.** MCPEmails sépare la lecture et l’écriture en outils distincts. \`email_read\`, \`inbox_list\`, \`folder_list\` et \`draft_list\` se contentent de lire, tandis que \`email_compose\` envoie, répond et transfère, et que \`email_delete\` supprime. Cette séparation vous permet de régler \`email_compose\` sur **Needs approval** et \`email_delete\` sur **Blocked**, tout en laissant la lecture sur **Toujours autoriser**. La [référence des outils](/docs#tools) les liste tous.

**6. Commencez par une tâche en lecture seule.** Activez le connecteur dans une nouvelle conversation et demandez à Claude de lister vos boîtes de réception et de résumer vos cinq e-mails non lus les plus récents, sans rien envoyer, déplacer ni supprimer. D’autres exemples de prompts figurent dans le [guide pour connecter Claude à vos e-mails](/blog/connect-claude-to-email).

Un seul connecteur couvre toutes les boîtes que vous connectez : c'est ainsi que [plusieurs comptes e-mail se retrouvent dans une même conversation Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt). Pour savoir quelles boîtes les connecteurs intégrés de Claude atteignent sans lui, lisez [Claude peut-il lire mes e-mails ?](/blog/can-claude-read-my-email)

Pour une équipe, le propriétaire ajoute une seule fois la même URL dans **Paramètres de l’organisation → Connecteurs**, puis chaque membre clique sur **Connecter** et se connecte avec son propre compte MCPEmails. Chacun ne voit que les boîtes accessibles à son propre compte. Pour que les messages sortants attendent la validation d’une personne, quoi que décide Claude, le propriétaire d’une boîte peut activer l’approbation des envois dans le tableau de bord MCPEmails : chaque envoi, réponse, transfert, envoi de brouillon et envoi planifié est alors retenu jusqu’à ce que quelqu’un l’approuve, et une demande sans décision expire au bout de 24 heures. L’article [approuver les envois d’e-mails d’un agent IA](/blog/approve-ai-agent-email-sends) décrit cette configuration.

Côté données, MCPEmails récupère les e-mails en direct auprès de votre fournisseur à chaque requête et ne stocke pas le contenu des messages. Il conserve uniquement le jeton OAuth ou le mot de passe d’application chiffré dont il a besoin pour accéder à la boîte. Les résultats qui contiennent du texte issu de la boîte sont marqués comme contenu non fiable : Claude sait ainsi qu’un e-mail lui demandant de transférer ou de supprimer quelque chose est une donnée à signaler, pas une instruction. La [présentation de la sécurité](/security) et l’article [est-il sûr de donner à un agent IA l’accès à ses e-mails ?](/blog/is-it-safe-to-give-ai-agent-email-access) détaillent le modèle de menace.

## Dépannage des connecteurs personnalisés

- **Le bouton Ajouter un connecteur personnalisé n’apparaît pas.** Sur les forfaits Team et Enterprise, les membres ne peuvent pas ajouter de connecteurs personnalisés. Demandez à un propriétaire d’ajouter l’URL sous **Paramètres de l’organisation → Connecteurs**.
- **Impossible d’ajouter un deuxième connecteur sur Free.** Le forfait Free autorise un seul connecteur personnalisé. Supprimez celui que vous n’utilisez plus ou passez à un forfait Claude payant.
- **La connexion expire ou échoue.** Claude se connecte depuis le cloud d’Anthropic : le serveur doit donc être joignable depuis l’Internet public. C’est le cas de l’URL hébergée de MCPEmails. Un serveur que vous exploitez vous-même, comme la [version auto-hébergée](/self-hosting), a besoin d’une adresse HTTPS publique ou d’un pare-feu qui autorise les plages d’adresses IP d’Anthropic. La version auto-hébergée s’authentifie avec une clé API et non via OAuth : Claude ne peut donc l’utiliser que là où la section En-têtes de requête est disponible.
- **Vous avez choisi les mauvais paramètres de connexion.** Les paramètres d’authentification ne sont pas modifiables. Supprimez le connecteur, ajoutez-le de nouveau, puis les membres se reconnectent.
- **Le connecteur est connecté, mais Claude ne l’utilise pas.** Ouvrez **+ → Connecteurs** dans cette conversation et vérifiez que son interrupteur est activé et que l’outil dont vous avez besoin n’est pas réglé sur **Blocked**.
- **Il n’apparaît pas sur votre téléphone.** Connectez-le d’abord sur le web ou dans Claude Desktop, puis reconnectez-vous dans l’application mobile.
- **Une action sur les e-mails est refusée.** Il manque un scope au jeton. Reconnectez le connecteur et approuvez le scope requis par cette action, ou révoquez l’ancienne autorisation dans le tableau de bord MCPEmails, sous **Clés API**, où la connexion de Claude apparaît sous la forme \`OAuth:\` suivi du nom du client. La [page de configuration Claude](/docs/claude) liste les autres solutions propres à Claude.

## FAQ

**Que sont les connecteurs personnalisés Claude ?**  
Ce sont des serveurs MCP distants que vous ajoutez à Claude par URL. Claude appelle les outils du serveur dans vos conversations une fois que vous vous êtes connecté et avez approuvé les autorisations. Ils sont disponibles sur les forfaits Free, Pro, Max, Team et Enterprise, et le forfait Free en autorise un.

**Les connecteurs personnalisés fonctionnent-ils dans Claude Desktop et sur mobile ?**  
Oui. Vous les ajoutez dans claude.ai, Claude Desktop ou Cowork, et un connecteur connecté à cet endroit est disponible dans les applications iOS et Android à votre prochaine connexion.

**Qui peut ajouter un connecteur personnalisé sur un forfait Team ou Enterprise ?**  
Sur Team, les propriétaires et propriétaires principaux. Sur Enterprise, également les personnes dotées d’un rôle personnalisé qui inclut la gestion des bibliothèques de l’organisation. Les membres se connectent ensuite individuellement.

**Un connecteur personnalisé est-il sûr ?**  
Il est aussi sûr que le serveur qui se trouve derrière et que les autorisations que vous accordez. Anthropic ne vérifie pas les connecteurs personnalisés : ne vous connectez qu’à des serveurs de confiance, accordez les autorisations les plus restreintes possibles et soumettez à approbation ou bloquez les actions d’écriture.

**Faut-il une clé API pour utiliser MCPEmails comme connecteur personnalisé Claude ?**  
Non. Claude se connecte à MCPEmails via OAuth. Les clés API servent aux clients MCP qui n’ont pas de flux OAuth, comme les scripts.

## Étape suivante

[Créez un compte MCPEmails gratuit](/signup), connectez une boîte et ajoutez \`https://mcpemails.com/api/mcp\` comme connecteur personnalisé dans Claude. Si votre boîte utilise IMAP et n’a pas de préréglage dédié, le [guide du connecteur IMAP Claude](/blog/claude-imap-connector) détaille les réglages du serveur.`,
};

export default translation;
