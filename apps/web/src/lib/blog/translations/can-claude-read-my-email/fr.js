const translation = {
  title: 'Claude peut-il lire et envoyer mes e-mails ? Boîte par boîte',
  description:
    "Oui pour Gmail et les comptes Microsoft 365 professionnels, avec les connecteurs intégrés de Claude. Yahoo, iCloud, Outlook.com, les boîtes IMAP et plusieurs fournisseurs à la fois passent par un serveur MCP.",
  coverAlt:
    'Claude qui lit et envoie des e-mails depuis des boîtes Gmail, Microsoft 365, Yahoo, iCloud et IMAP',
  content: `**Oui, Claude peut lire vos e-mails et en envoyer, mais uniquement depuis une boîte que vous lui avez connectée.** Claude dispose de deux connecteurs e-mail intégrés : l'un pour Gmail, l'autre pour les comptes Microsoft 365 professionnels. Le connecteur Gmail lit, recherche et envoie, et demande par défaut votre accord avant chaque envoi. Le connecteur Microsoft 365 lit et recherche, et ne peut envoyer qu'une fois ses outils d'écriture activés par un administrateur. Pour Yahoo, iCloud, une adresse Outlook.com personnelle, une boîte d'entreprise chez un hébergeur IMAP ou plusieurs fournisseurs derrière une seule connexion, il faut un serveur MCP comme MCPEmails.

Cette page vous aide à savoir dans quel cas vous êtes. Les informations sur les produits d'Anthropic et de Google ont été relevées sur leurs propres pages en octobre 2026. Ces produits évoluent souvent : chaque section renvoie donc vers la page sur laquelle elle s'appuie.

**Aller à :** [Gmail](#gmail-le-connecteur-intégré-de-claude) · [Microsoft 365](#outlook-et-microsoft-365-comptes-professionnels-uniquement) · [Ce que les connecteurs intégrés ne couvrent pas](#ce-que-les-connecteurs-intégrés-ne-couvrent-pas) · [MCPEmails](#comment-mcpemails-comble-ces-lacunes) · [Envoi](#claude-peut-il-envoyer-des-e-mails) · [FAQ](#faq)

## Gmail : le connecteur intégré de Claude

Dans le répertoire des connecteurs de Claude, le connecteur Gmail est indiqué comme conçu par Google, et il s'appuie sur le serveur MCP Gmail de Google (\`gmailmcp.googleapis.com\`). Vous l'activez depuis les paramètres des connecteurs de Claude, puis vous vous connectez avec votre compte Google.

Ce qu'il sait faire, d'après [l'article d'aide d'Anthropic](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) et [sa fiche dans le répertoire](https://claude.com/connectors/gmail) :

- **Lire et rechercher** vos e-mails à partir de questions en langage courant, et lire des fils de discussion entiers.
- **Rédiger, envoyer, répondre et transférer.** L'article d'Anthropic cite ces quatre actions.
- **Ranger** vos messages avec des libellés, et placer des messages ou des fils dans la corbeille.
- **Demander d'abord.** Par défaut, Claude demande votre accord avant chaque envoi, réponse ou transfert. Avec les formules Team et Enterprise, un propriétaire doit d'abord activer le connecteur pour l'organisation, et c'est lui qui décide si les membres peuvent laisser ces actions s'exécuter sans confirmation.

Ses limites :

- **Les pièces jointes.** D'après l'article d'Anthropic, Claude ne voit que leurs métadonnées, pas leur contenu.
- **Un seul compte Google.** L'article parle d'accès au « compte Google que vous avez connecté » et ne mentionne pas l'ajout d'un deuxième compte.

Google documente aussi ce même serveur MCP Gmail dans le cadre de son [programme Developer Preview de Google Workspace](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server). Les membres de ce programme peuvent l'ajouter eux-mêmes à d'autres clients MCP, avec leur propre client OAuth Google Cloud. Cette version documentée propose des outils pour rechercher, lire des fils, créer des brouillons et modifier des libellés, mais aucun outil d'envoi : vous relisez le brouillon et l'envoyez depuis Gmail.

Si Gmail est votre seule boîte et Claude votre seule application d'IA, le connecteur intégré peut suffire.

## Outlook et Microsoft 365 : comptes professionnels uniquement

Le connecteur Microsoft 365 de Claude lit les e-mails Outlook des comptes rattachés au tenant Microsoft 365 d'une entreprise.

- **La lecture et la recherche** couvrent votre boîte principale, son dossier Archive et les boîtes partagées auxquelles vous avez accès.
- **L'envoi est désactivé par défaut.** Le connecteur démarre en lecture seule. Une fois les outils d'écriture activés, Claude peut envoyer et transférer des e-mails, et créer, modifier et supprimer des brouillons. Les outils d'écriture refusent les messages avec pièces jointes.
- **Un administrateur doit donner son accord.** Un administrateur général Microsoft Entra de votre organisation doit donner son consentement avant que quiconque puisse s'y connecter, puis à nouveau pour que les outils d'écriture fonctionnent.
- **Les comptes personnels sont refusés.** [L'article d'Anthropic](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) est clair : les adresses @outlook.com et @hotmail.com ne peuvent pas être utilisées pour se connecter.

Une adresse personnelle Outlook.com, Hotmail ou Live ne dispose donc d'aucun connecteur intégré dans Claude. [Connecter Claude à Outlook.com et Hotmail](/blog/connect-claude-to-outlook-com-hotmail) présente la méthode qui fonctionne.

## Ce que les connecteurs intégrés ne couvrent pas

En combinant les deux, voici les boîtes qu'aucun des connecteurs intégrés n'atteint :

- **Yahoo Mail et AOL.**
- **iCloud Mail.**
- **Les adresses personnelles Outlook.com, Hotmail et Live.**
- **Les boîtes d'entreprise chez un hébergeur IMAP** : Fastmail, Zoho Mail, IONOS, STRATO, un hébergeur cPanel ou votre propre serveur.
- **Un deuxième compte Google.** L'article d'Anthropic décrit un seul compte Google connecté et ne mentionne pas l'ajout d'un autre.
- **Plusieurs fournisseurs derrière une seule connexion**, pour qu'une même question cherche à la fois dans info@, dans votre propre adresse et dans un Gmail personnel.

Fastmail et Zoho Mail ont chacun leur propre serveur MCP, que vous pouvez ajouter à Claude comme connecteur personnalisé. Chacun n'accède qu'aux boîtes de son propre fournisseur. Aucun des deux articles d'aide de Claude ne mentionne la programmation d'un envoi. La [comparaison des connecteurs intégrés de Claude et de ChatGPT](/native-connectors-vs-mcp) détaille chaque fonction avec sa source et la date de vérification.

## Comment MCPEmails comble ces lacunes

MCPEmails est un serveur MCP hébergé. Vous y connectez chaque boîte une seule fois, puis vous ajoutez une seule URL de connecteur dans Claude, et Claude peut lire, rechercher et envoyer depuis toutes les boîtes connectées :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **N'importe quel fournisseur.** [Yahoo Mail](/connect/yahoo), [iCloud Mail](/connect/icloud), [Outlook.com personnel](/connect/outlook) et [Microsoft 365 professionnel](/connect/office365) (tous deux avec Se connecter avec Microsoft), [Gmail](/connect/gmail) avec un mot de passe d'application Google, [Fastmail](/connect/fastmail) avec un mot de passe d'application, [Zoho Mail](/connect/zoho), et toute boîte compatible [IMAP et SMTP](/connect/imap). La [liste complète des fournisseurs](/connect) propose une page de paramètres pour chaque hébergeur.
- **Plusieurs boîtes dans une même conversation.** Claude appelle \`inbox_list\` et voit chaque adresse connectée par son nom : « cherche dans sales@ et dans mon Gmail » fonctionne donc dans une seule conversation. [Plusieurs comptes e-mail dans Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt) explique cette configuration.
- **Envoyer depuis la bonne adresse.** Chaque boîte envoie via son propre fournisseur, avec son propre nom d'expéditeur et sa propre signature.
- **Programmer et ranger.** Claude peut programmer un envoi, et déplacer, marquer d'un indicateur, archiver ou supprimer des e-mails dans toutes les boîtes connectées, une fois que vous lui avez accordé le niveau Accès complet.
- **Lire les pièces jointes.** Claude peut [extraire le texte d'une pièce jointe PDF, CSV ou HTML](/blog/extract-email-attachments-for-ai) sans que le fichier soit conservé.
- **Les mêmes boîtes dans d'autres applications.** C'est un serveur MCP standard : la même configuration fonctionne aussi dans ChatGPT, Cursor, VS Code et d'autres clients MCP.

Les e-mails sont récupérés en direct chez votre fournisseur à chaque requête et ne sont pas stockés. Ce qui est conservé : les identifiants de connexion chiffrés de chaque boîte, un message programmé jusqu'à son envoi, et un envoi en attente de validation jusqu'à ce qu'il soit approuvé, refusé ou qu'il expire. Les données sont stockées à Stockholm.

### L'ajouter à Claude

1. [Créez un compte MCPEmails gratuit](/signup) et connectez une boîte sous **Boîtes**, puis **Connecter la boîte**.
2. Dans claude.ai ou Claude Desktop, ouvrez **Customize → Connectors**, cliquez sur **+ Add**, puis sur **Add custom connector**. Nommez-le MCPEmails, saisissez \`https://mcpemails.com/api/mcp\`, cliquez sur **Continue**, gardez les paramètres de connexion détectés et cliquez sur **Add**.
3. Connectez-vous à MCPEmails quand Claude vous le demande, et choisissez le niveau d'accès de Claude : **Lecture seule**, **Standard** (ajoute l'envoi et les brouillons) ou **Accès complet** (ajoute la programmation, les dossiers et la suppression).

Le [guide pas à pas pour configurer Claude](/blog/connect-claude-to-email) passe en revue chaque écran et chaque fournisseur, et la [page de configuration de Claude](/docs/claude) traite les erreurs de connecteur.

## Claude peut-il envoyer des e-mails ?

Oui. Beaucoup de pages affirment encore que Claude peut seulement lire vos e-mails, mais les articles d'aide actuels d'Anthropic disent le contraire. La possibilité d'envoyer dépend du connecteur, et de ce que vous avez autorisé au moment de le connecter.

### Le connecteur Gmail de Claude

D'après [l'article d'Anthropic sur Google Workspace](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors), relu fin octobre 2026, le connecteur Gmail peut rédiger des e-mails, lister vos brouillons enregistrés, et envoyer, répondre et transférer. Par défaut, Claude demande votre accord avant chaque envoi, réponse ou transfert. Avec les formules Team et Enterprise, un propriétaire active le connecteur et décide si les membres peuvent laisser ces actions s'exécuter sans confirmation à chaque fois.

Il envoie depuis le seul compte Google que vous avez connecté. Claude ne voit que les métadonnées des pièces jointes, pas leur contenu.

### Le connecteur Microsoft 365 de Claude

Il démarre en lecture seule. Une fois les outils d'écriture activés, ce qui exige qu'un administrateur général Microsoft Entra approuve les autorisations supplémentaires, Claude peut envoyer et transférer des e-mails, et créer, modifier et supprimer des brouillons. Les outils d'écriture refusent tout message avec une pièce jointe, et les adresses personnelles Outlook.com et Hotmail ne peuvent pas se connecter du tout.

### Comment MCPEmails envoie

Avec MCPEmails, Claude envoie depuis n'importe quelle boîte connectée : Gmail, Outlook, iCloud, Yahoo, une boîte IMAP d'entreprise et d'autres encore. C'est vous qui décidez jusqu'où il peut aller, à quatre endroits.

- **L'accès que vous accordez.** Quand vous ajoutez MCPEmails à Claude, vous choisissez **Lecture seule** (Claude ne peut ni envoyer ni rédiger de brouillon), **Standard** (ajoute les brouillons et l'envoi) ou **Accès complet** (ajoute la programmation, les dossiers et la suppression). Vous pouvez aussi limiter la connexion à certaines de vos boîtes.
- **Le brouillon d'abord.** Quand vous demandez à Claude d'écrire un e-mail, MCPEmails lui indique de l'enregistrer comme brouillon dans votre boîte plutôt que de l'envoyer. Dans Claude et ChatGPT, le brouillon s'ouvre dans une carte modifiable au sein de la conversation : vous pouvez y changer les destinataires, l'objet et le texte, l'enregistrer, ou l'envoyer avec quelques secondes pour annuler. Il se trouve aussi dans le dossier Brouillons de votre application de messagerie.
- **Revue avant envoi.** Ce réglage se fait boîte par boîte dans le tableau de bord. **Demander d'abord dans le chat** oblige Claude à vous montrer l'e-mail dans la conversation et à attendre votre accord avant d'envoyer. **Approuver sur mcpemails.com** retient chaque envoi, réponse, transfert et envoi de brouillon jusqu'à ce qu'un propriétaire ou un administrateur de l'espace de travail l'approuve, connecté à MCPEmails dans un navigateur ; Claude ne peut pas l'approuver lui-même. Consultez [la validation humaine des e-mails envoyés par une IA](/blog/approve-ai-agent-email-sends).
- **Un reçu après chaque envoi.** Claude affiche l'adresse d'envoi, les destinataires, l'objet et la présence ou non d'une copie dans votre dossier Envoyés, ou la raison de l'échec d'un envoi.

Chaque boîte envoie via son propre fournisseur : le message part donc de votre vraie adresse, avec votre nom d'expéditeur et votre signature, et la réponse arrive dans votre boîte habituelle. Claude peut aussi [programmer un e-mail pour plus tard](/blog/schedule-email-with-claude-and-chatgpt).

### Claude peut-il envoyer des e-mails sans demander ?

- **Le connecteur Gmail de Claude** demande par défaut votre accord avant chaque envoi, réponse ou transfert.
- **Le connecteur Microsoft 365 de Claude** ne peut rien envoyer tant que les outils d'écriture ne sont pas activés.
- **MCPEmails** n'envoie sans autre question que si vous avez accordé l'accès à l'envoi et laissé **Revue avant envoi** désactivé pour cette boîte. Les autorisations d'outils de Claude ajoutent une couche de plus : dans **Customize → Connectors**, vous pouvez régler chaque outil MCPEmails sur **Always allow**, **Needs approval** ou **Blocked**.

Quelle que soit la méthode, considérez le contenu d'un e-mail comme une donnée, pas comme une instruction. Un message peut contenir du texte écrit pour manipuler une IA, et une étape de validation l'intercepte avant que quoi que ce soit ne quitte votre boîte. Le [guide sur la sécurité de l'accès aux e-mails](/blog/is-it-safe-to-give-ai-agent-email-access) détaille les risques.

## FAQ

**Claude peut-il lire mes e-mails ?**
Oui, une fois une boîte connectée. Les comptes Gmail et Microsoft 365 professionnels se connectent via les connecteurs intégrés de Claude. Les boîtes Yahoo, iCloud, Outlook.com personnelles et IMAP se connectent via un serveur MCP comme MCPEmails, ajouté à Claude comme connecteur personnalisé.

**Claude peut-il envoyer des e-mails ?**
Oui. Le connecteur Gmail de Claude peut envoyer, répondre et transférer, et demande d'abord votre accord par défaut. Le connecteur Microsoft 365 peut envoyer une fois les outils d'écriture activés. Avec MCPEmails, Claude envoie depuis n'importe quelle boîte connectée si vous lui avez donné l'accès à l'envoi au moment de le connecter, et enregistre d'abord comme brouillon un e-mail que vous lui demandez d'écrire.

**Le connecteur Gmail de Claude peut-il envoyer des e-mails ?**
Oui. Anthropic indique que le connecteur Gmail peut envoyer, répondre et transférer, chaque action demandant par défaut votre accord. Il envoie depuis le seul compte Google que vous avez connecté.

**Claude peut-il lire mes e-mails Gmail ?**
Oui, avec le connecteur Gmail intégré à Claude, pour le compte Google que vous connectez. Pour utiliser plusieurs comptes Google, ou Gmail avec d'autres fournisseurs dans la même conversation, connectez-les via MCPEmails avec un mot de passe d'application Google.

**Claude peut-il accéder à mes e-mails Outlook ou Hotmail ?**
Les comptes Microsoft 365 professionnels et scolaires peuvent utiliser le connecteur Microsoft 365 de Claude une fois qu'un administrateur l'a approuvé. Les adresses personnelles Outlook.com et Hotmail, non. MCPEmails connecte les deux avec Se connecter avec Microsoft, même si, pour un compte professionnel, l'administrateur informatique doit parfois approuver l'application une fois pour toute l'organisation.

**Claude peut-il lire mes e-mails Yahoo ou iCloud ?**
Pas avec un connecteur intégré. Connectez la boîte à MCPEmails avec un mot de passe d'application Yahoo ou Apple, puis ajoutez MCPEmails à Claude.

**Claude peut-il lire plusieurs comptes e-mail à la fois ?**
Oui, via MCPEmails. Chaque boîte que vous connectez apparaît dans Claude via la même URL de connecteur, et Claude indique la boîte concernée à chaque appel.

**MCPEmails stocke-t-il mes e-mails ?**
Non. Le contenu des messages est récupéré en direct chez votre fournisseur à chaque requête, puis supprimé une fois la réponse envoyée. Consultez la page [sécurité](/security) pour savoir ce qui est conservé.

## Prochaine étape

Si tous vos e-mails sont dans un seul compte Gmail, essayez d'abord le connecteur Gmail de Claude. Pour tout le reste, [commencez gratuitement](/signup), connectez une boîte, ajoutez \`https://mcpemails.com/api/mcp\` à Claude et demandez-lui quels e-mails attendent une réponse aujourd'hui.`,
};

export default translation;
