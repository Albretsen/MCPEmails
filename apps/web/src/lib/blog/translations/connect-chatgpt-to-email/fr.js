const translation = {
  title: 'Connecter ChatGPT à vos e-mails avec MCP (Gmail, iCloud et IMAP)',
  description:
    'Pas à pas : connectez Gmail, iCloud, Fastmail ou toute boîte IMAP à ChatGPT via un connecteur MCP, et à OpenAI Codex via une clé limitée. Aucun e-mail stocké.',
  coverAlt:
    'Connecter ChatGPT et OpenAI Codex à Gmail, iCloud, Fastmail et aux e-mails IMAP avec MCP Emails',
  content: `> **Outlook et Microsoft 365 sont en cours de développement.** Ils ne peuvent pas encore être connectés en production. Ce guide couvre Gmail, iCloud, Fastmail, Yahoo, Zoho et les autres boîtes IMAP disponibles aujourd'hui.

ChatGPT ne peut pas atteindre une boîte e-mail tout seul. Il lui faut un serveur MCP devant votre messagerie, et MCP Emails est ce serveur : connectez une boîte une fois, pointez ChatGPT vers une seule URL, et il dispose des mêmes outils de messagerie que vos e-mails soient chez Gmail, iCloud, Fastmail, Yahoo, Zoho ou sur un serveur IMAP auto-hébergé.

Deux surfaces OpenAI sont concernées, et elles s'authentifient différemment. ChatGPT exécute un flux OAuth dans le navigateur : aucune clé API à coller. OpenAI Codex tourne dans votre terminal et utilise plutôt une clé limitée comme jeton bearer. Même endpoint, mêmes outils.

**Accéder à :** [Configuration ChatGPT](#tape-2-ajouter-le-connecteur-dans-chatgpt) · [OpenAI Codex](#openai-codex-dans-le-terminal) · [Dépannage](#dpannage)

## Ce dont vous avez besoin

- **Un espace de travail ChatGPT capable de créer des connecteurs personnalisés.** Le mode développeur avec des connecteurs MCP arbitraires est une bêta OpenAI réservée aux espaces ChatGPT Business, Enterprise et Edu. Sur un compte personnel, l'option est absente ou refuse le serveur, et rien de notre côté ne la débloque.
- **Un compte MCP Emails gratuit.** [Créez-le ici](/signup). L'offre gratuite accepte une boîte connectée et ne demande pas de carte.
- **Une boîte e-mail.** Gmail, iCloud, Fastmail, Yahoo, Zoho, Yandex, ou tout service parlant IMAP et SMTP.

Si votre espace de travail ne peut pas encore créer de connecteur, la même boîte et la même URL fonctionnent déjà dans [Claude](/docs/claude), [Cursor](/docs/cursor), [VS Code](/docs/vscode) et les autres [clients pris en charge](/docs/clients).

## Étape 1 : Connecter votre boîte à MCP Emails

Dans le tableau de bord MCP Emails, ouvrez **Inboxes**, puis **Connect Inbox**, puis choisissez votre fournisseur.

### Gmail et Google Workspace

Gmail se connecte par défaut avec un mot de passe d'application Google en IMAP, et la connexion Google OAuth est également disponible. Utilisez le mot de passe d'application si un administrateur Workspace restreint l'accès des applications tierces. Le [guide Gmail](/blog/connect-gmail-to-claude) détaille les étapes.

### iCloud, Fastmail, Yahoo et Zoho

Ces fournisseurs demandent un mot de passe spécifique à l'application, pas celui que vous tapez sur le web. Créez-le chez le fournisseur, choisissez ce fournisseur dans MCP Emails et collez-le. Le [guide iCloud, Fastmail et IMAP](/blog/connect-icloud-fastmail-imap-to-claude) donne les étapes exactes.

### Toute autre boîte IMAP

Choisissez **IMAP** et saisissez l'adresse et le mot de passe d'application. Les réglages courants sont détectés automatiquement ; un domaine personnalisé peut exiger l'hôte, le port et le mode de sécurité fournis par votre fournisseur. La [matrice des fournisseurs](/docs/providers) indique ce que chacun prend en charge, et il existe une page par fournisseur dans [connect](/connect), dont [Gmail](/connect/gmail), [iCloud](/connect/icloud) et [IMAP générique](/connect/imap).

Connectez plusieurs boîtes si votre forfait le permet. ChatGPT les découvre avec \`inbox_list\`, vous ne collez donc jamais d'identifiant de boîte dans un prompt.

## Étape 2 : Ajouter le connecteur dans ChatGPT

1. Activez le **mode développeur** dans les réglages de ChatGPT, sous les paramètres avancés des applications et connecteurs.
2. Créez un nouveau connecteur et donnez-lui un nom.
3. Collez cette URL de connecteur :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Choisissez **OAuth** comme méthode d'authentification, créez le connecteur, puis autorisez avec MCP Emails.

Choisissez OAuth, pas l'option sans authentification. Ce serveur refuse les appels anonymes : un connecteur créé sans authentification semble correct à la configuration puis échoue à son premier appel d'outil, ce qui est l'ordre le plus déroutant. Avec OAuth, ChatGPT s'enregistre lui-même et réalise un flux de code d'autorisation avec PKCE : aucun client id à créer, aucun secret nulle part. La formulation des menus évolue au fil de la bêta, alors consultez la [page de configuration ChatGPT](/docs/chatgpt) pour le chemin actuel.

## Étape 3 : N'accordez que les scopes nécessaires

L'écran de consentement est le nôtre, pas celui d'OpenAI. Le premier consentement démarre à \`read:email\`, ce qui suffit pour trier, résumer et retrouver des choses, et met toute action irréversible hors de portée le temps que vous décidiez jusqu'où aller. Les autres scopes sont \`send:email\`, \`search:email\` et \`manage:automations\`.

En accorder trop peu se rattrape : un appel qui exige un scope absent du jeton renvoie un 403 avec une erreur de scope insuffisant, le client peut donc redemander ce scope précis et réessayer. Le propriétaire d'une boîte peut aussi exiger une [approbation humaine](/blog/approve-ai-agent-email-sends) dans le tableau de bord, qui retient chaque envoi, réponse, transfert, envoi de brouillon et envoi planifié jusqu'à ce qu'une personne le libère.

## Étape 4 : Donnez à ChatGPT une première tâche sûre

Commencez en lecture seule :

> Résume mes trois e-mails non lus les plus récents et signale ce qui demande une réponse aujourd'hui. N'envoie, ne déplace et ne supprime rien.

ChatGPT trouve d'abord la boîte, puis lit uniquement les messages nécessaires. Une fois que cela fonctionne, essayez :

- « Trouve la facture Stripe du mois dernier et indique-moi le montant. »
- « Rédige une réponse au dernier message d'Alex, mais laisse-la en brouillon. »
- « Montre-moi les newsletters de cette semaine que je pourrais archiver, et attends ma confirmation. »

Pour des routines réutilisables, partez du [guide de tri de boîte de réception](/blog/ai-agent-triage-summarize-inbox) ou de la [collection de prompts de workflow](/blog/ai-agent-email-workflows-and-prompts).

## Ce que ChatGPT peut faire une fois connecté

MCP Emails donne à ChatGPT des outils ciblés plutôt qu'un mot de passe ou une connexion IMAP brute :

- **Lire et rechercher :** \`email_read\` couvre list, read, read_batch, search et attachment. Les recherches Gmail acceptent des opérateurs comme \`from:\` et \`is:unread\`.
- **Envoyer, répondre et transférer :** \`email_compose\` envoie via votre propre fournisseur et votre propre adresse.
- **Organiser :** \`email_organize\`, \`email_search_and_move\` et \`email_delete\`.
- **Brouillons, dossiers et planification :** \`draft\`, \`draft_list\`, \`folder\`, \`folder_list\`, \`schedule\` et \`schedule_list\`.
- **Le reste :** \`contact_search\`, \`signature_get\`, \`signature_set\`, plus \`automation\` et \`automation_read\` pour les règles récurrentes.

Une limite à anticiper : MCP Emails fonctionne par interrogation. Il n'y a ni webhooks ni événements initiés par le serveur, donc ChatGPT vérifie les nouveaux e-mails quand vous le lui demandez, pas au moment où un message arrive.

## OpenAI Codex dans le terminal

Codex est une surface différente des connecteurs ChatGPT, et le flux OAuth par navigateur n'y est pas la bonne voie. Un client en terminal s'authentifie plutôt avec un jeton bearer :

1. Dans le tableau de bord, ouvrez **API Keys** et créez une clé en cochant uniquement les scopes dont cet agent a besoin.
2. Copiez-la immédiatement. La clé commence par \`mcpe_\` suivi de 64 caractères hexadécimaux et n'est affichée qu'une fois.
3. Enregistrez \`https://mcpemails.com/api/mcp\` comme serveur MCP en HTTP dans la configuration MCP propre à Codex, en passant la clé dans un en-tête \`Authorization: Bearer\`.

Les connexions par clé et les connexions OAuth atteignent le même endpoint et voient le même catalogue d'outils. La seule différence tient à l'origine du jeton. Pour vérifier l'endpoint au préalable, le [guide HTTP brut](/docs/curl) contient un appel \`tools/list\` d'une ligne, et [OAuth ou clés API](/blog/oauth-vs-api-keys-ai-email-access) explique quand chaque voie convient.

Limitez la clé au strict nécessaire. La lecture seule est généralement le bon choix pour un agent de développement : un agent capable de résumer un fil de support est utile, un agent capable d'envoyer du courrier sans surveillance relève d'une autre catégorie de risque.

## Dépannage

- **Aucune option pour créer un connecteur personnalisé.** Le mode développeur est réservé aux espaces Business, Enterprise et Edu. C'est une décision d'OpenAI, pas un réglage côté serveur.
- **Le connecteur échoue à son premier appel d'outil.** Il a probablement été créé sans authentification. Supprimez-le et recréez-le avec OAuth.
- **Le fournisseur refuse votre mot de passe.** Utilisez un mot de passe d'application généré par le fournisseur, pas votre mot de passe web. Certains fournisseurs n'en délivrent qu'une fois l'authentification à deux facteurs activée.
- **Une connexion IMAP personnalisée expire.** Vérifiez l'hôte, le port et le mode TLS. Le port 993 utilise normalement TLS implicite ; le port 143 utilise généralement STARTTLS.
- **ChatGPT se connecte mais ne voit aucun e-mail.** Vérifiez que la boîte est active dans le tableau de bord, que la connexion détient \`read:email\`, et demandez à ChatGPT d'appeler d'abord \`inbox_list\`.

## FAQ

**ChatGPT peut-il lire et envoyer mes e-mails ?**
Via un connecteur MCP personnalisé, oui : lecture, recherche, envoi, réponse, transfert, organisation et planification, toujours limités aux scopes approuvés lors de la configuration.

**Ai-je besoin d'une clé API pour ChatGPT ?**
Non. Choisissez OAuth et ChatGPT s'enregistre lui-même et complète le flux. Les clés API servent aux clients incapables d'exécuter un flux navigateur, comme Codex et les scripts.

**Codex se configure-t-il de la même façon ?**
Non. Codex est une surface en terminal : il utilise une clé API limitée dans un en-tête \`Authorization: Bearer\` au lieu du flux OAuth par navigateur. Même endpoint, mêmes outils.

**Mes e-mails sont-ils stockés sur vos serveurs ?**
Non. Chaque message est récupéré en direct chez votre fournisseur pour la requête qui l'a demandé, puis supprimé. Seul l'identifiant chiffré du fournisseur est conservé. [Pourquoi ne jamais stocker les e-mails compte](/blog/why-email-never-stored-matters) explique le raisonnement.

**Combien cela coûte-t-il ?**
L'offre gratuite couvre une boîte connectée et 150 actions e-mail facturables par mois calendaire UTC, les 7 premiers jours n'étant pas comptés. Ce plafond mensuel s'applique aux espaces de travail créés à partir du 2026-09-13 ; ceux créés avant en sont exemptés. Les forfaits payants ajoutent des boîtes et suppriment le plafond : voir les [tarifs](/pricing).

## Étape suivante

[Commencez gratuitement](/signup), connectez une boîte, ajoutez \`https://mcpemails.com/api/mcp\` à ChatGPT et demandez-lui de résumer vos e-mails non lus. La [page de configuration ChatGPT](/docs/chatgpt) donne le chemin actuel ; la [documentation](/docs) donne la référence complète des outils.`,
};

export default translation;
