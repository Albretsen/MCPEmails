const translation = {
  title: 'Connecter Claude à Apple Mail : iCloud, Gmail, Outlook, Yahoo',
  description:
    'Connectez Claude aux comptes de votre app Apple Mail (iCloud, Gmail, Outlook.com, Yahoo, IMAP) pour lire, rechercher, rédiger et envoyer vos e-mails depuis n\'importe quel appareil, iPhone compris.',
  coverAlt: 'Les comptes iCloud, Gmail, Outlook et Yahoo d\'Apple Mail connectés à Claude via MCP',
  content: `Pour connecter Claude à Apple Mail, vous connectez les comptes de messagerie qu'Apple Mail affiche, et non l'app Mail elle-même. Apple Mail est un client : il synchronise un compte iCloud, Gmail, Outlook.com, Yahoo ou un autre compte IMAP depuis les serveurs du fournisseur. MCPEmails connecte Claude à ces mêmes comptes côté serveur. Claude voit donc la même boîte de réception, les mêmes dossiers, brouillons et messages envoyés qu'Apple Mail, et cela fonctionne depuis claude.ai, Claude Desktop et l'app Claude sur votre iPhone. Votre Mac n'a pas besoin d'être allumé.

## Claude peut-il se connecter à Apple Mail ?

Oui, par l'intermédiaire des comptes qu'il contient. Apple Mail n'offre aucune connexion propre à laquelle Claude pourrait se connecter. La méthode fiable est donc la suivante :

1. Vérifiez quels comptes Apple Mail utilise.
2. Connectez chaque compte à MCPEmails, un serveur MCP hébergé.
3. Ajoutez MCPEmails à Claude comme connecteur personnalisé, avec une seule URL.

Ensuite, Claude peut lire, rechercher, rédiger, envoyer, planifier et classer vos e-mails dans chaque compte connecté, dans la limite de l'accès que vous lui accordez. Les changements apparaissent dans Apple Mail sur votre Mac et votre iPhone à la synchronisation suivante, puisque Claude et Apple Mail consultent la même boîte.

## Pourquoi connecter le compte plutôt que l'app Mail

Les serveurs MCP pour Apple Mail que l'on trouve sur GitHub tournent sur votre Mac et passent par l'app Mail elle-même, via AppleScript ou en lisant l'index local de Mail. Cela fonctionne, avec des limites qui découlent de leur conception :

- Ils ne tournent que sur un Mac, avec le serveur installé et Mail disponible.
- Claude sur votre iPhone, sur un PC Windows ou sur le web ne peut pas les joindre, car la connexion vit sur ce seul Mac.
- Si le Mac est en veille ou fermé, le serveur est injoignable.

Un connecteur personnalisé dans Claude fonctionne dans l'autre sens. Le centre d'aide d'Anthropic indique que la connexion à un serveur MCP part des serveurs d'Anthropic, et non de votre appareil, sur tous les clients Claude, applications mobiles comprises. Une connexion côté serveur à votre compte de messagerie s'inscrit dans ce modèle : rien à installer, et le même connecteur fonctionne partout où vous ouvrez Claude.

## Étape 1 : voir quels comptes Apple Mail utilise

- **Sur Mac :** dans Mail, choisissez **Mail → Réglages**, puis cliquez sur **Comptes**.
- **Sur iPhone ou iPad :** ouvrez **Réglages → Apps → Mail → Comptes Mail**.

Chaque compte de cette liste se connecte à MCPEmails de l'une de ces façons :

- **iCloud** (@icloud.com, @me.com, @mac.com) : un mot de passe pour application Apple. Réglages sur la [page iCloud](/connect/icloud).
- **Google** : un mot de passe d'application Google. Réglages sur la [page Gmail](/connect/gmail).
- **Outlook.com, Hotmail, Live ou Microsoft 365** : la connexion avec Microsoft. Un compte professionnel ou scolaire peut nécessiter que votre administrateur informatique approuve MCPEmails une fois. Détails sur la [page Outlook](/connect/outlook).
- **Yahoo** : un mot de passe d'application Yahoo. Réglages sur la [page Yahoo Mail](/connect/yahoo).
- **Autre (IMAP)** : les réglages IMAP et SMTP de votre hébergeur. Voir la [page IMAP personnalisé](/connect/imap).

Si votre fournisseur ne figure pas dans cette liste, [chaque fournisseur pris en charge](/connect) a sa propre page avec les réglages du serveur.

## Étape 2 : connecter chaque compte à MCPEmails

Créez un [compte MCPEmails](/signup) gratuit, ouvrez le tableau de bord, allez dans **Boîtes → Connecter une boîte** et choisissez le fournisseur.

### iCloud Mail

Apple n'accepte pas le mot de passe de votre Apple Account depuis d'autres apps. Il vous faut un mot de passe pour application :

1. Connectez-vous sur [account.apple.com](https://account.apple.com).
2. Dans **Connexion et sécurité**, sélectionnez **Mots de passe pour applications**.
3. Sélectionnez **Générer un mot de passe pour application**, nommez-le \`MCPEmails\` et copiez le mot de passe affiché par Apple.
4. Dans MCPEmails, choisissez **iCloud**, saisissez votre adresse iCloud et collez ce mot de passe.

L'authentification à deux facteurs doit être activée sur votre Apple Account. À savoir : changer le mot de passe de votre Apple Account révoque tous les mots de passe pour application. Après un changement de mot de passe, vous en générez donc un nouveau et vous reconnectez le compte. Le [guide iCloud, Fastmail et IMAP](/blog/connect-icloud-fastmail-imap-to-claude) donne plus de détails.

### Gmail

Apple Mail se connecte à Google avec votre compte Google. MCPEmails utilise à la place un mot de passe d'application Google en IMAP, que Google propose une fois la validation en deux étapes activée. Choisissez **Gmail** et collez le mot de passe de 16 lettres avec votre adresse. Le [guide Gmail](/blog/connect-gmail-to-claude) traite le cas des comptes Workspace dont l'administrateur a désactivé les mots de passe d'application.

### Outlook.com, Hotmail et Microsoft 365

Choisissez **Outlook** et cliquez sur **Se connecter avec Microsoft**. Aucun mot de passe à coller.

### Yahoo et autres comptes IMAP

Créez un mot de passe d'application chez votre fournisseur, choisissez **Yahoo** ou **IMAP / SMTP**, puis saisissez l'adresse et le mot de passe. Pour les hébergeurs courants, les réglages du serveur se remplissent automatiquement à partir de l'adresse.

Connectez chaque compte Apple Mail que Claude doit pouvoir atteindre ; le nombre de boîtes que vous pouvez ajouter dépend de votre [offre](/pricing). Claude les retrouve avec \`inbox_list\`, vous n'avez donc jamais à coller un identifiant de compte dans un prompt.

## Étape 3 : ajouter MCPEmails à Claude

Sur claude.ai ou dans Claude Desktop :

1. Ouvrez **Customize → Connectors**.
2. Cliquez sur **+ Add**, puis sur **Add custom connector**.
3. Saisissez un nom comme \`MCPEmails\` et collez l'URL du connecteur :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Suivez les étapes et cliquez sur **Add**. Cliquez ensuite sur **Connect**, connectez-vous à MCPEmails et choisissez ce que Claude a le droit de faire : **Lecture seule**, **Standard** (ajoute l'envoi, les brouillons et les contacts), **Accès complet** (ajoute les dossiers, la planification et la suppression) ou **Personnalisé**.

Pas de clé API, pas de fichier de configuration. Avec une offre Team ou Enterprise, un propriétaire ajoute d'abord le connecteur dans **Organization settings → Connectors**, puis les membres cliquent sur **Connect**. La [page de configuration de Claude](/docs/claude) détaille chaque étape et les erreurs courantes.

### Sur iPhone

Le centre d'aide d'Anthropic indique qu'un connecteur ajouté sur claude.ai ou dans Claude Desktop est disponible à votre prochaine connexion dans l'app Claude pour iOS ou Android. Ajoutez-le une fois sur le web, puis interrogez Claude sur vos e-mails depuis votre téléphone. L'app Mail de l'iPhone n'a pas besoin d'être ouverte, et votre Mac n'a pas besoin d'être allumé.

## Ce que Claude voit, et ce qu'il ne voit pas

Claude travaille sur la copie serveur de chaque compte, celle qu'Apple Mail synchronise. Concrètement :

- **Les dossiers créés pour le compte sont visibles.** Une boîte aux lettres créée sous votre compte iCloud ou Gmail se trouve sur le serveur : Claude peut la lister, y faire des recherches et y déplacer des messages si vous avez accordé l'accès aux dossiers.
- **Les brouillons arrivent dans Apple Mail.** Quand Claude enregistre un brouillon, il va dans le dossier Brouillons de ce compte. Vous pouvez l'ouvrir dans Apple Mail, le modifier et l'envoyer vous-même.
- **Les messages envoyés sont classés.** Un message envoyé par Claude est enregistré dans le dossier Envoyés du compte, comme s'il était parti d'Apple Mail. Si un serveur de messagerie refuse cette copie, le résultat renvoyé par Claude le signale.
- **Les boîtes « Sur mon Mac » ne sont pas visibles.** Apple ne les stocke que sur le Mac où vous les avez créées, aucune connexion serveur ne peut donc les voir. Déplacez ce que Claude doit trouver dans une boîte aux lettres du compte.
- **Les comptes POP peuvent être incomplets.** Un compte qu'Apple Mail utilise en POP a pu supprimer les anciens messages du serveur après les avoir téléchargés sur votre Mac. MCPEmails se connecte en IMAP, Claude ne peut donc atteindre que ce qui se trouve encore sur le serveur.

Les e-mails sont récupérés en direct chez votre fournisseur à chaque requête et ne sont pas stockés par MCPEmails. Seule exception : un message que vous planifiez pour plus tard, conservé jusqu'à son envoi.

## Prompts à essayer

Commencez par quelque chose en lecture seule :

> Résume mes e-mails non lus d'aujourd'hui dans iCloud et Gmail. Une seule liste, avec pour chaque message le compte d'où il vient.

> Retrouve la confirmation de vol que j'ai reçue le mois dernier et donne-moi la référence de réservation.

> Rédige une réponse au dernier message de mon propriétaire, mais ne l'envoie pas. Je la terminerai dans Apple Mail.

Pour d'autres routines, voir [les meilleures façons de laisser Claude gérer votre boîte](/blog/best-ways-to-let-claude-manage-your-inbox) et la [méthode de tri de la boîte de réception](/blog/ai-agent-triage-summarize-inbox). Si vous gérez plusieurs comptes, [gérer plusieurs comptes e-mail avec l'IA](/blog/manage-multiple-email-accounts-with-ai) montre comment toujours répondre depuis la bonne adresse.

## Connecter ChatGPT aux mêmes comptes

L'URL du connecteur est un serveur MCP standard, ChatGPT peut donc atteindre les mêmes comptes Apple Mail. Vous l'ajoutez sur chatgpt.com comme serveur MCP personnalisé ; le centre d'aide d'OpenAI précise que cette étape se fait uniquement sur le web. Les offres et les rôles d'espace de travail autorisés à en ajouter un changent souvent : la [page de configuration de ChatGPT](/docs/chatgpt) tient les étapes à jour, et le [guide ChatGPT et e-mail](/blog/connect-chatgpt-to-email) couvre les erreurs courantes.

## Garder le contrôle

- **N'accordez que le nécessaire.** Choisissez **Lecture seule** sur l'écran d'autorisation si Claude ne doit jamais envoyer.
- **Validez d'abord les envois.** Activez **Revue avant envoi** pour un compte dans le tableau de bord, et chaque envoi depuis ce compte attend votre accord. Voir [la validation humaine des envois par une IA](/blog/approve-ai-agent-email-sends).
- **Révoquez à tout moment.** Supprimez le mot de passe pour application sur account.apple.com, ou révoquez la connexion de Claude dans **Clés API** du tableau de bord MCPEmails.

Traitez chaque e-mail comme du texte non fiable : un message peut contenir des instructions destinées à une IA. Le [guide de sécurité sur l'accès aux e-mails](/blog/is-it-safe-to-give-ai-agent-email-access) explique les risques, et la page [sécurité](/security) décrit le chiffrement des identifiants et le lieu de stockage des données.

## FAQ

**Comment connecter Claude à Apple Mail ?**
Connectez à MCPEmails les comptes qu'utilise Apple Mail (iCloud, Gmail, Outlook.com, Yahoo ou IMAP), puis ajoutez \`https://mcpemails.com/api/mcp\` comme connecteur personnalisé dans Claude, dans Customize, puis Connectors. Claude lit et envoie ensuite depuis ces comptes, et le résultat apparaît dans Apple Mail.

**Faut-il un Mac ?**
Non. Rien ne tourne sur votre Mac. Claude atteint vos comptes de messagerie via MCPEmails, cela fonctionne donc depuis claude.ai, Claude Desktop sur Windows ou Mac, et l'app Claude sur iPhone et Android.

**Est-ce que cela fonctionne avec Apple Mail sur iPhone ?**
Oui. L'app Mail de votre iPhone et Claude travaillent sur les mêmes comptes. Ajoutez le connecteur une fois sur claude.ai et il sera disponible dans l'app Claude pour iPhone à votre prochaine connexion.

**Pourquoi le mot de passe de mon Apple Account est-il refusé ?**
iCloud n'accepte qu'un mot de passe pour application depuis d'autres apps. Générez-en un sur account.apple.com, dans Connexion et sécurité, et collez-le à la place.

**Claude peut-il voir mes dossiers « Sur mon Mac » ?**
Non. Ces boîtes n'existent que sur votre Mac. Déplacez les messages dans une boîte aux lettres de votre compte iCloud ou d'un autre compte, et Claude pourra les voir.

**Mes e-mails sont-ils stockés ?**
Non. Chaque requête récupère les e-mails en direct chez votre fournisseur, puis les supprime. Les exceptions : les messages que vous planifiez, conservés jusqu'à leur envoi, et l'identifiant chiffré de chaque compte, que MCPEmails conserve. La marche à suivre complète pour chaque fournisseur se trouve dans le [guide pour connecter Claude à vos e-mails](/blog/connect-claude-to-email).

## Prochaine étape

[Commencez gratuitement](/signup), connectez votre compte iCloud, ajoutez le connecteur dans Claude et demandez-lui ce qui attend une réponse aujourd'hui. Ouvrez ensuite Apple Mail : vous y verrez la même boîte de réception que Claude vient de lire.`,
};

export default translation;
