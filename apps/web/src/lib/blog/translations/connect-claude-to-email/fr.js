const translation = {
  title: 'Connecter Claude à vos e-mails avec MCP (Gmail, iCloud et IMAP)',
  description:
    'Guide pratique pour connecter Claude à Gmail, iCloud, Fastmail, Yahoo, Zoho et toute boîte IMAP avec MCP — sans code et sans stockage des e-mails.',
  coverAlt:
    'Connecter Claude à Gmail, iCloud, Fastmail, Yahoo, Zoho et aux e-mails IMAP avec MCP Emails',
  content: `> **Outlook et Microsoft 365 sont en cours de développement.** Ils ne peuvent pas encore être connectés en production. Ce guide couvre Gmail, iCloud, Fastmail, Yahoo, Zoho et les autres boîtes IMAP disponibles aujourd'hui.

Claude peut lire, rechercher, organiser et envoyer vos e-mails, mais il lui faut un serveur MCP pour atteindre une vraie boîte de réception. MCP Emails est ce pont : connectez une boîte une seule fois, ajoutez un endpoint sécurisé à Claude, et Claude dispose des mêmes outils de messagerie avec Gmail, iCloud, Fastmail, Yahoo, Zoho et les autres fournisseurs IMAP.

Vous n'avez aucun code à écrire, aucun SDK à installer et aucune clé API à utiliser lorsque vous passez par le flux OAuth de Claude. Les e-mails sont récupérés en direct auprès de votre fournisseur pour chaque requête et MCP Emails ne les stocke pas.

**Accéder à votre fournisseur :** [Gmail](#gmail-et-google-workspace) · [iCloud](#icloud-mail) · [Fastmail](#fastmail) · [Yahoo, Zoho, Yandex ou IMAP personnalisé](#yahoo-zoho-yandex-et-imap-personnalis)

## Ce dont vous avez besoin

- D'un **forfait ou d'une application Claude qui prend en charge les connecteurs personnalisés**.
- D'un compte gratuit **MCP Emails** — [créez-le ici](/signup).
- D'une boîte e-mail. Gmail utilise OAuth ; iCloud, Fastmail, Yahoo, Zoho et la plupart des autres fournisseurs utilisent un mot de passe spécifique à l'application. La prise en charge d'Outlook est en cours.

## Étape 1 : Connectez votre boîte à MCP Emails

Dans le tableau de bord MCP Emails, ouvrez **Inboxes → Connect Inbox**, puis choisissez votre fournisseur.

### Gmail et Google Workspace

Choisissez **Gmail**, connectez-vous avec Google et autorisez l'accès. Votre mot de passe Google n'est jamais transmis à MCP Emails. Consultez le [guide Gmail détaillé](/blog/connect-gmail-to-claude) si un administrateur Workspace contrôle l'accès aux applications.

### iCloud Mail

Créez un mot de passe spécifique à l'application dans votre compte Apple, choisissez **iCloud** et utilisez ce mot de passe — pas celui de votre compte Apple. Le [guide iCloud et IMAP](/blog/connect-icloud-fastmail-imap-to-claude) présente les étapes exactes.

### Fastmail

Créez dans Fastmail un mot de passe d'application avec accès à Mail, choisissez **Fastmail** et collez-le dans MCP Emails. Conservez-le jusqu'à la réussite du test de connexion.

### Yahoo, Zoho, Yandex et IMAP personnalisé

Créez un mot de passe d'application, choisissez **IMAP**, puis saisissez l'adresse et le mot de passe. Les réglages courants sont détectés automatiquement ; un domaine personnalisé peut nécessiter l'hôte, le port et le mode de sécurité IMAP/SMTP indiqués par le fournisseur.

Vous pouvez connecter plusieurs boîtes. Claude les découvre avec \`inbox_list\`, vous n'avez donc pas à coller des identifiants de boîte dans un prompt.

Besoin d'aide selon le fournisseur ? Consultez la [configuration multi-fournisseurs en deux minutes](/blog/connect-email-to-ai-agent-under-2-minutes), le [guide Gmail](/blog/connect-gmail-to-claude) ou le [guide iCloud, Fastmail et IMAP](/blog/connect-icloud-fastmail-imap-to-claude).

## Étape 2 : Ajoutez MCP Emails à Claude

Dans claude.ai ou Claude Desktop :

1. Ouvrez **Settings → Connectors**.
2. Choisissez **Add custom connector**.
3. Collez cette URL :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Sélectionnez **Connect**, connectez-vous à MCP Emails et approuvez les scopes souhaités : \`read:email\`, \`send:email\`, ou les deux.

C'est toute la configuration côté Claude. OAuth limite la connexion aux scopes approuvés et vous pouvez la révoquer depuis MCP Emails à tout moment. Pour un client sans OAuth intégré, utilisez plutôt une clé API limitée ; [OAuth ou clés API](/blog/oauth-vs-api-keys-ai-email-access) explique cette option.

## Étape 3 : Donnez à Claude une première tâche sûre

Commencez par une demande en lecture seule :

> Résume mes trois e-mails non lus les plus récents et signale tout ce qui demande une réponse aujourd'hui.

Claude trouve d'abord la boîte connectée, puis liste et lit les messages pertinents. Ensuite, essayez :

- « Trouve la facture Stripe du mois dernier et indique-moi le montant. »
- « Rédige une réponse au dernier message d'Alex, mais ne l'envoie pas. »
- « Montre-moi les newsletters de cette semaine que je peux archiver. »
- « Sur quoi me suis-je engagé dans mon fil avec Acme ? »

Pour des routines réutilisables, utilisez le [guide de tri de boîte de réception](/blog/ai-agent-triage-summarize-inbox) ou les [manières de laisser Claude gérer votre boîte](/blog/best-ways-to-let-claude-manage-your-inbox).

## Ce que Claude peut faire après la connexion

MCP Emails donne à Claude des outils de messagerie ciblés, et non un mot de passe ou une connexion IMAP brute :

- **Lire et rechercher :** \`email_read\` liste les messages, lit les messages complets et recherche les e-mails. Les recherches Gmail acceptent aussi des opérateurs tels que \`from:\` et \`is:unread\`.
- **Envoyer, répondre et transférer :** \`email_compose\` envoie via votre propre fournisseur et votre propre adresse.
- **Organiser :** \`email_organize\` déplace, étiquette, marque et archive les messages.
- **Gérer brouillons, dossiers, planification et contacts :** \`draft\`, \`folder\`, \`schedule\` et \`contact_search\` couvrent le reste d'un flux de messagerie pratique.

MCP Emails fonctionne par interrogation : Claude vérifie les nouveaux e-mails quand vous le lui demandez, plutôt que de recevoir un événement push dès qu'un message arrive.

## Résoudre les problèmes de connexion et de configuration Claude

- **Le fournisseur refuse le mot de passe :** utilisez un mot de passe d'application généré par le fournisseur, pas votre mot de passe web. Régénérez-le après avoir activé l'authentification à deux facteurs si nécessaire.
- **La connexion IMAP personnalisée expire :** vérifiez l'hôte, le port et le mode TLS. Le port 993 utilise normalement TLS implicite ; le port 143 utilise généralement STARTTLS.
- **Claude se connecte mais ne voit aucun e-mail :** vérifiez d'abord que la boîte est active dans MCP Emails, reconnectez Claude avec **read:email**, puis demandez-lui d'appeler **inbox_list**.
- **Claude peut lire mais pas envoyer :** reconnectez-le avec **send:email** et vérifiez que la connexion prend en charge SMTP ou l'envoi natif du fournisseur.

Si le problème persiste, consultez la [matrice des fournisseurs](/docs/providers), puis le [guide de démarrage](/docs#quickstart) et testez une requête en lecture seule avant d'activer l'envoi.

## Est-il sûr de connecter Claude à vos e-mails ?

Oui, à condition de n'accorder que l'accès nécessaire et de garder une personne impliquée pour les actions sortantes.

- **Les e-mails ne sont pas stockés.** MCP Emails récupère le contenu des messages en direct à chaque appel et le supprime après la livraison. L'identifiant chiffré nécessaire pour se reconnecter à votre fournisseur est la seule donnée de boîte conservée.
- **Votre fournisseur garde le contrôle de l'authentification.** Gmail utilise OAuth, donc MCP Emails ne reçoit jamais votre mot de passe. Pour les fournisseurs IMAP, utilisez un mot de passe d'application révocable plutôt que votre mot de passe habituel.
- **Les scopes sont explicites.** Accordez un accès en lecture seule si Claude ne doit jamais envoyer. Ajoutez l'envoi uniquement lorsque nécessaire et révoquez-le à tout moment.

Traitez le corps de chaque e-mail comme une entrée non fiable. Demandez à Claude de rédiger avant d'envoyer, relisez les messages externes et ne laissez pas des instructions présentes dans un e-mail remplacer votre intention. Le [guide de sécurité de l'accès e-mail](/blog/is-it-safe-to-give-ai-agent-email-access) détaille le modèle de menace.

## FAQ

**Claude peut-il se connecter à Gmail, Outlook ou iCloud ?**  
Gmail se connecte avec OAuth et iCloud avec un mot de passe spécifique à l'application. Outlook est en cours de développement et n'est pas encore disponible en production. MCP Emails prend aussi en charge Fastmail et IMAP générique, ce qui couvre des services comme Yahoo et Zoho.

**Ai-je besoin d'une clé API ?**  
Non, pas pour le flux de connecteur OAuth de Claude. Collez l'URL de l'endpoint et connectez-vous. Les clés API servent aux clients MCP sans OAuth intégré.

**Claude peut-il envoyer des e-mails ?**  
Oui, si vous accordez \`send:email\`. Commencez avec un accès en lecture seule, ou demandez d'abord des brouillons si vous souhaitez une relecture humaine.

**MCP Emails stocke-t-il ma boîte de réception ?**  
Non. Les messages sont lus en direct chez votre fournisseur puis supprimés. MCP Emails ne conserve que l'identifiant chiffré nécessaire à ces requêtes en direct.

## Étape suivante

[Commencez gratuitement](/signup), connectez votre boîte, ajoutez \`https://mcpemails.com/api/mcp\` à Claude et demandez-lui de résumer vos e-mails non lus. Consultez la [documentation](/docs) pour la référence complète des outils MCP et des capacités par fournisseur.`,
};

export default translation;
