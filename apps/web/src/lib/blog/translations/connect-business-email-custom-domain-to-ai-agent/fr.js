const translation = {
  title: 'Connecter une messagerie professionnelle sur votre domaine à votre agent IA (IMAP)',
  description:
    'Guide de configuration pour vous@votreentreprise.com : identifier qui héberge vraiment vos e-mails, connecter Google Workspace, Zoho, Fastmail, Migadu, Titan, Rackspace, IONOS ou cPanel, et corriger le nom de l\'expéditeur avant que votre agent ne réponde.',
  coverAlt:
    'Connecter une messagerie professionnelle sur domaine propre à un agent IA avec MCP Emails',
  content: `> **Sous Microsoft 365 ?** Si votre boîte professionnelle se révèle être un tenant Microsoft, ce guide vous aidera à le confirmer. Connectez-la avec **Outlook** et la connexion Microsoft plutôt qu'en IMAP ; votre administrateur informatique devra peut-être d'abord approuver l'application une seule fois pour toute l'organisation. Le [guide Outlook et Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) détaille les étapes.

Presque tous les guides pour connecter une messagerie à un agent IA supposent que votre adresse se termine par gmail.com. La messagerie professionnelle, c'est autre chose : le domaine ne dit pas qui héberge la boîte, quelqu'un d'autre contrôle peut-être la possibilité même pour un client de messagerie de se connecter, et ce que votre agent envoie arrive chez vos clients à votre nom. Voici le guide pour vous@votreentreprise.com.

**Accéder à votre fournisseur :** [Google Workspace](#google-workspace) · [Zoho Mail](#zoho-mail) · [Fastmail et Migadu](#fastmail-et-migadu) · [Titan Email](#titan-email) · [Rackspace Email](#rackspace-email) · [IONOS](#ionos) · [cPanel et hébergements mutualisés](#cpanel-et-hbergements-mutualiss)

## Pourquoi une boîte professionnelle est plus difficile qu'une boîte personnelle

- **Quelqu'un d'autre contrôle peut-être l'accès des applications.** Un administrateur Google Workspace peut désactiver les mots de passe d'application pour tout un domaine. Zoho livre ses boîtes avec IMAP désactivé, Titan avec l'accès tiers désactivé. Les trois refusent la connexion exactement comme un mot de passe erroné.
- **Votre adresse ne nomme pas votre serveur de messagerie.** Notre propre hello@mcpemails.com est hébergé par Migadu, et rien dans le domaine ne l'indique. Deviner \`mail.votreentreprise.com\` ne mène généralement nulle part.
- **SMTP n'est pas toujours le miroir d'IMAP.** Rackspace sert les deux depuis un seul hôte sans marque ; OVH Hosted Exchange n'écoute pas du tout sur le 465 et exige le 587 avec STARTTLS.
- **Le nom d'expéditeur est vu par vos clients.** Une réponse qui part sans nom finit en ticket de support.

## Étape 1 : identifier qui héberge vraiment vos e-mails

MCP Emails essaie de répondre à votre place. Saisissez votre adresse dans le formulaire IMAP, marquez une demi-seconde de pause, et quatre sources sont consultées dans l'ordre : une table des fournisseurs qui ont provoqué de vraies pannes de connexion, les enregistrements de service RFC 6186 de votre domaine, votre enregistrement MX comparé à cette table, et la base d'autoconfiguration de Mozilla. Rien n'est prérempli tant que les deux moitiés ne sont pas résolues.

Pour vérifier vous-même au préalable :

\`\`\`
dig +short MX votreentreprise.com
dig +short SRV _imaps._tcp.votreentreprise.com
\`\`\`

Les enregistrements de service donnent l'hôte et le port directement, mais la plupart des domaines n'en publient aucun : c'est donc la réponse MX qui vous reste.

- Se termine par \`.l.google.com\`, ou \`smtp.google.com\` : Google Workspace.
- \`mx.zoho.com\` ou son équivalent régional : Zoho Mail.
- \`aspmx1.migadu.com\` : Migadu. \`mx1.titan.email\` : Titan, quelle que soit la marque sous laquelle vous l'avez acheté.
- Un nom MX hébergé chez Microsoft : un tenant Microsoft 365. Connectez-le avec **Outlook**, pas en IMAP.
- Le nom du serveur de votre hébergeur : une boîte cPanel ou Plesk.

## Étape 2 : suivre le chemin de votre fournisseur

Dans le tableau de bord, ouvrez **Inboxes → Connect Inbox** et choisissez la voie qui correspond.

### Google Workspace

Workspace se connecte par défaut avec un **mot de passe d'application Google** en IMAP (\`imap.gmail.com\` sur le 993, \`smtp.gmail.com\` sur le 465) ; OAuth reste disponible. Les mots de passe d'application n'existent que si la validation en deux étapes est activée, et un administrateur peut les désactiver pour tout le domaine, auquel cas la page Google vous est tout simplement inaccessible. Les administrateurs peuvent aussi restreindre les applications OAuth tierces sous Sécurité → Contrôles des API, ce qui bloque cette voie sur l'écran de consentement de Google. Si les deux sont fermées, adressez-vous à votre administrateur.

### Zoho Mail

**Activez l'accès IMAP** d'abord, sous Paramètres → Comptes de messagerie → l'adresse → Accès IMAP. Il est désactivé par défaut et se règle boîte par boîte : l'activer pour vous ne fait rien pour un collègue. Générez également un **mot de passe spécifique à l'application** si l'authentification à deux facteurs est active.

Votre hôte dépend de deux choses que Zoho ne montre jamais ensemble : dans lequel de ses six centres de données régionaux vit le compte (\`.com\`, \`.eu\`, \`.in\`, \`.com.au\`, \`.jp\`, \`zohocloud.ca\`), et s'il s'agit d'un compte d'organisation payant sur domaine propre, qui utilise \`imappro\` et \`smtppro\` de cette région. MCP Emails demande les deux et construit le nom d'hôte.

### Fastmail et Migadu

Fastmail utilise un **mot de passe d'application** avec accès Mail (IMAP/SMTP), depuis Settings → Privacy & Security : \`imap.fastmail.com\` sur le 993 et \`smtp.fastmail.com\` sur le 465. Un guide qui vous demande de vous connecter à Fastmail via OAuth est périmé.

Migadu utilise le **mot de passe de la boîte**, pas celui de votre compte Migadu, qui gère domaines et facturation et n'authentifie aucun courrier. Un alias n'a aucun mot de passe : si l'adresse voulue est un alias, ajoutez une **identité** sur la boîte et donnez-lui le sien. Les hôtes sont \`imap.migadu.com\` et \`smtp.migadu.com\`. Le [guide iCloud et IMAP](/blog/connect-icloud-fastmail-imap-to-claude) détaille les étapes du mot de passe d'application.

### Titan Email

Titan refuse tout client de messagerie tant que vous n'avez pas actionné un interrupteur : **Settings → Enable Titan on Other Apps**. Avant cela, la connexion échoue comme un mot de passe erroné. Titan est aussi vendu sous la marque d'autres sociétés, donc le lieu d'achat décide de vos noms d'hôtes : GoDaddy le vend sous le nom Professional Email sur \`imap.secureserver.net\` et \`smtpout.secureserver.net\`, Hostinger sous le nom Titan sur \`imap.titan.email\`. Le guide de dépannage de Titan vous dit de désactiver la double authentification ; ce n'est pas nécessaire, car Titan gère les mots de passe d'application.

### Rackspace Email

Les deux hôtes sont \`secure.emailsrvr.com\`, en entrée comme en sortie, quel que soit votre domaine. Le nom ne porte aucune marque Rackspace, alors les gens le "corrigent" par quelque chose de plus plausible et plus rien ne marche. Utilisez le mot de passe de la boîte défini dans le panneau Cloud Office. Avec l'authentification multifacteur activée, ce mot de passe cesse de fonctionner en IMAP et SMTP tout en continuant de marcher dans le webmail : il vous faut alors un mot de passe d'application. Rackspace vend aussi Hosted Exchange, qui n'est pas connectable ici, et revend Microsoft 365, qui se connecte avec **Outlook** plutôt qu'en IMAP.

### IONOS

IONOS donne à **chaque adresse son propre mot de passe e-mail**, défini dans le panneau de configuration sous Email. Votre identifiant de compte IONOS, qui est très souvent une adresse e-mail lui aussi, authentifie le panneau et rien d'autre, et cette seule confusion explique la majorité des échecs IONOS dans nos journaux. IONOS répond aussi bien sur le 993 en TLS que sur le 143 en STARTTLS : alterner entre les deux est du temps perdu. Un espace de travail a fait douze tentatives consécutives en alternant, alors que le mot de passe était en cause depuis le début.

### cPanel et hébergements mutualisés

Il n'existe pas de service de messagerie cPanel, seulement le serveur de votre hébergeur : le panneau est donc la seule autorité sur son nom. Ouvrez **Email Accounts**, cliquez sur **Connect Devices** et copiez les valeurs de **Mail Client Manual Settings**, en prenant la colonne sécurisée SSL/TLS. Le nom d'utilisateur est l'adresse e-mail complète, jamais votre identifiant cPanel, et l'identifiant secret est le mot de passe de la boîte. Pas de mot de passe d'application, pas d'OAuth. Plesk fonctionne pareil.

## Quand rien n'est détecté et que vous saisissez les réglages

Donnez quatre choses à MCP Emails par protocole : hôte, port, mode de sécurité et votre adresse complète comme nom d'utilisateur. Les conventions sont fixes, et le formulaire garde le port et la sécurité synchronisés pour qu'ils ne divergent pas :

- IMAP **993**, c'est du TLS implicite ; IMAP **143**, du STARTTLS.
- SMTP **465**, c'est du TLS implicite ; SMTP **587**, du STARTTLS, et le **25** du STARTTLS chez les petits hôtes qui n'offrent rien d'autre.

Les confondre était la première cause d'échec des connexions génériques : STARTTLS sur le 993 attend une salutation qu'un serveur TLS uniquement n'enverra jamais, et le TLS implicite sur le 143 rate la négociation. Vous n'avez plus à viser juste du premier coup. Une connexion qui n'a jamais établi de session utilisable est réessayée sur les autres transports standard, jusqu'à trois tentatives par protocole, en commençant par celui que vous avez demandé. Un mot de passe refusé par le serveur n'est jamais réessayé : le renvoyer ne ferait que tripler le compteur d'échecs de connexion que votre fournisseur utilise pour verrouiller le compte.

L'envoi négocie encore une chose que vous ne verrez jamais. Les hôtes de type Exchange annoncent **LOGIN** sans PLAIN : MCP Emails lit ce que le serveur propose, essaie PLAIN en premier quand les deux sont là, et bascule sur LOGIN. Un mécanisme refusé n'est jamais signalé comme un mauvais mot de passe.

## Définir le nom d'expéditeur avant que votre agent réponde

Tout ce que votre agent envoie construit son en-tête From à partir d'un seul champ : le nom d'affichage de la boîte, devant votre adresse. Laissez-le vide et le courrier part avec la seule adresse.

Définissez-le boîte par boîte sur la page de détail de la boîte, où un aperçu montre l'en-tête tel que les destinataires le verront. Un agent peut le définir aussi, avec \`signature_set\` et l'argument \`sender_name\`. Les noms sont limités à 100 caractères, les caractères de contrôle et les chevrons étant supprimés pour qu'un nom ne puisse pas glisser une seconde adresse dans l'en-tête. Profitez-en pour ajouter une signature : [les signatures e-mail pour Claude](/blog/email-signatures-for-claude).

## Dépannage de la messagerie professionnelle

- **La connexion est refusée et le mot de passe est bon.** Vérifiez l'interrupteur avant le mot de passe : accès IMAP chez Zoho, accès tiers chez Titan, mots de passe d'application chez Workspace, multifacteur chez Rackspace.
- **Vous utilisez carrément le mauvais mot de passe.** Migadu, IONOS, Rackspace et cPanel séparent tous l'identifiant du panneau de configuration du mot de passe de la boîte, et les deux sont généralement des adresses e-mail.
- **Ça expire au lieu d'échouer.** C'est l'hôte ou le port, pas l'identifiant. Relisez le nom d'hôte dans le panneau du fournisseur.
- **La lecture marche mais pas l'envoi.** La moitié sortante a son propre hôte, port et mode de sécurité, et certains hôtes n'écoutent pas sur le 465. Vérifiez aussi que vous avez accordé \`send:email\`.
- **C'est une boîte Microsoft 365.** Achetée en direct ou revendue par GoDaddy, IONOS ou Rackspace, elle reste un tenant Microsoft. Connectez-la avec **Outlook** et la connexion Microsoft, pas en IMAP. Si Microsoft indique qu'une approbation de l'administrateur est requise, envoyez le lien affiché dans le tableau de bord à votre administrateur informatique.

La [matrice des fournisseurs](/docs/providers) et les [pages fournisseur](/connect) donnent le détail pour chacun.

## FAQ

**Comment savoir qui héberge la messagerie de mon entreprise ?**
Consultez l'enregistrement MX de votre domaine, ou saisissez votre adresse dans le formulaire de connexion et laissez la détection automatique regarder le MX et les enregistrements de service pour vous.

**Puis-je connecter une adresse Google Workspace ?**
Oui, avec un mot de passe d'application Google en IMAP, ou avec OAuth. Votre administrateur peut bloquer l'une comme l'autre : les mots de passe d'application peuvent être désactivés pour tout le domaine et les applications OAuth tierces restreintes dans les contrôles des API.

**Et si mon hébergeur ne publie aucun réglage IMAP ?**
Saisissez-les vous-même : hôte, port, mode de sécurité et votre adresse complète comme nom d'utilisateur. Si le premier transport ne répond pas, les alternatives standard sont essayées automatiquement.

**MCP Emails stocke-t-il les e-mails de mon entreprise ?**
Non. Le contenu des messages est récupéré en direct auprès de votre fournisseur à chaque requête puis supprimé. Seule la clé d'accès chiffrée du fournisseur est conservée.

**Une seule boîte suffit-elle sur le plan gratuit ?**
Free connecte 1 boîte. Personal coûte 5 $/mois pour 3 boîtes sans plafond mensuel d'actions, et Pro 15 $/mois pour un nombre illimité de boîtes. Voir les [tarifs](/pricing).

## Prochaine étape

[Créez un compte gratuit](/signup), connectez votre boîte professionnelle, définissez le nom d'expéditeur et ajoutez \`https://mcpemails.com/api/mcp\` à votre client. Demandez-lui ensuite d'appeler \`inbox_list\` et de résumer les messages non lus d'hier, avant de lui accorder quoi que ce soit qui envoie.`,
};

export default translation;
