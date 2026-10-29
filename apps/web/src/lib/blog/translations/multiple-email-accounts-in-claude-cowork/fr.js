const translation = {
  title: 'Plusieurs comptes e-mail dans Claude Cowork, y compris Outlook personnel',
  description:
    "Claude Cowork n'atteint qu'un seul compte Google avec son connecteur Gmail, et son connecteur Microsoft 365 refuse les adresses Outlook personnelles. Comment donner plusieurs boîtes, professionnelles et personnelles, à une même tâche Cowork.",
  coverAlt:
    'Des comptes e-mail professionnels et personnels, dont Gmail et Outlook.com, connectés à une même tâche Claude Cowork',
  content: `**Claude Cowork utilise les mêmes connecteurs que Claude en conversation, et il a donc les mêmes limites pour les e-mails : un seul compte Google avec le connecteur Gmail, et uniquement des comptes Microsoft 365 professionnels avec le connecteur Microsoft 365.** Une adresse personnelle Outlook.com ou Hotmail, un deuxième Gmail ou une boîte d'entreprise chez un hébergeur IMAP nécessitent un connecteur personnalisé. Avec un serveur MCP comme MCPEmails, un seul connecteur personnalisé donne à une tâche Cowork toutes les boîtes que vous connectez, chacune sous son nom.

**Aller à :** [Connecteurs intégrés](#ce-quatteignent-les-connecteurs-e-mail-intégrés-de-cowork) · [Plusieurs boîtes](#plusieurs-boîtes-dans-une-même-tâche-cowork) · [Configuration](#la-configuration) · [Autorisations](#gardez-le-contrôle-des-envois) · [FAQ](#faq)

## Ce qu'atteignent les connecteurs e-mail intégrés de Cowork

Le [guide Cowork d'Anthropic](https://support.claude.com/en/articles/13345190-get-started-with-cowork) gère les connecteurs depuis la même page **Customize → Connectors** que les conversations, et conversations et Cowork partagent désormais le même espace dans l'application Claude. Tout ce que votre compte Claude a connecté est utilisable par une tâche Cowork.

- **Gmail.** Le connecteur Gmail de Claude lit, recherche, rédige des brouillons et envoie. [L'article d'Anthropic](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) parle d'accès au « compte Google que vous avez connecté » et ne dit rien de l'ajout d'un deuxième compte. Un Gmail personnel et un Gmail professionnel ne cohabitent pas par ce biais.
- **Microsoft 365.** Le [connecteur Microsoft 365](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) est destiné aux comptes du tenant Microsoft 365 d'une entreprise. Un administrateur général doit d'abord donner son consentement, le connecteur démarre en lecture seule, et les comptes Microsoft personnels comme @outlook.com et @hotmail.com ne peuvent pas se connecter.
- **Tout le reste.** Yahoo, iCloud, Fastmail, Zoho, IONOS ou votre propre serveur de messagerie n'ont aucun connecteur Claude intégré.

La combinaison la plus courante, une boîte professionnelle plus un Outlook.com personnel ou un deuxième Gmail, ne tient donc pas dans Cowork avec les seuls connecteurs intégrés.

## Plusieurs boîtes dans une même tâche Cowork

Les [connecteurs personnalisés](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) sont des serveurs MCP distants, et Anthropic les indique comme disponibles dans Claude, Cowork et Claude Desktop. Claude les atteint depuis le cloud d'Anthropic, ce qui a une conséquence pour Cowork : un serveur MCP local configuré dans \`claude_desktop_config.json\` n'y est pas disponible. Le serveur doit être accessible sur Internet.

MCPEmails est un serveur MCP hébergé, c'est donc déjà le cas. Vous y connectez chaque boîte une seule fois, vous ajoutez une seule URL dans Claude, et toutes vos boîtes sont disponibles dans vos tâches Cowork :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **N'importe quelle combinaison de fournisseurs.** [Gmail et Google Workspace](/connect/gmail) avec un mot de passe d'application Google, [Outlook.com, Hotmail et Live personnels](/connect/outlook) et [Microsoft 365 professionnel](/connect/office365) avec Se connecter avec Microsoft, [iCloud](/connect/icloud), [Yahoo](/connect/yahoo), [Fastmail](/connect/fastmail), [Zoho](/connect/zoho) et toute boîte compatible [IMAP et SMTP](/connect/imap).
- **Chaque boîte sous son nom.** La tâche appelle \`inbox_list\` et voit chaque adresse connectée avec son nom d'affichage : « regarde info@ et mon Outlook » ne demande donc aucune configuration supplémentaire.
- **Des réponses depuis la bonne adresse.** Chaque boîte envoie via son propre fournisseur, avec son propre nom d'expéditeur et sa propre signature.
- **Rien n'est stocké.** Les e-mails sont récupérés en direct chez votre fournisseur à chaque requête et ne sont pas conservés sur nos serveurs.

Une adresse personnelle Outlook.com se connecte avec Se connecter avec Microsoft et ne nécessite aucun administrateur. Pour un compte Microsoft 365 professionnel, l'administrateur informatique doit parfois approuver MCPEmails une fois pour toute l'organisation ; la page [approbation administrateur Microsoft 365](/docs/microsoft-365-admin-consent) explique ce qu'il approuve et lui donne le lien.

## La configuration

1. **Connectez vos boîtes.** [Créez un compte MCPEmails gratuit](/signup), ouvrez **Boîtes**, puis **Connecter la boîte**, une fois par boîte. Donnez à chacune un nom d'affichage clair, comme « Outlook perso » ou « Acme Ventes » : c'est ce que Claude lit pour les distinguer.
2. **Ajoutez le connecteur à Claude.** Ouvrez **Customize → Connectors**, cliquez sur **+ Add**, puis sur **Add custom connector**. Nommez-le MCPEmails, saisissez \`https://mcpemails.com/api/mcp\`, cliquez sur **Continue**, gardez les paramètres de connexion détectés et cliquez sur **Add**. Avec Team et Enterprise, c'est un Owner qui l'ajoute, et les membres cliquent sur **Connect**.
3. **Connectez-vous et choisissez l'accès.** **Lecture seule** pour les tâches qui ne font que lire, **Standard** pour ajouter les brouillons et l'envoi, ou **Accès complet** pour ajouter la programmation, les dossiers et la suppression.
4. **Activez-le dans Cowork.** Dans une tâche, ouvrez le menu **+** et activez MCPEmails parmi les connecteurs.

Le [guide de configuration de Claude](/blog/connect-claude-to-email) montre chaque écran, et [les connecteurs personnalisés de Claude expliqués](/blog/claude-custom-connectors-explained) détaille ce qu'un connecteur personnalisé peut faire ou non.

Cowork lui-même est disponible avec les formules Pro, Max, Team et Enterprise de Claude. La formule Free de MCPEmails connecte une boîte ; plusieurs boîtes nécessitent une formule payante, présentée sur la [page des tarifs](/pricing).

## Gardez le contrôle des envois

Une tâche Cowork enchaîne de nombreuses étapes seule : décidez donc dès le départ de ce qu'elle peut faire sans demander.

- **Dans Claude.** Le guide Cowork d'Anthropic permet de régler chaque outil de connecteur sur **Always allow**, **Needs approval** ou **Blocked**. Régler les outils d'envoi de MCPEmails sur **Needs approval** oblige Claude à s'arrêter avant chaque envoi. Avec Team et Enterprise, votre organisation peut de toute façon exiger une approbation pour les outils d'écriture.
- **Dans MCPEmails.** Activez **Revue avant envoi** pour une boîte et choisissez le mode : **Demander d'abord dans le chat** oblige Claude à vous montrer l'e-mail et à attendre votre accord, et **Approuver sur mcpemails.com** retient chaque envoi jusqu'à ce qu'un propriétaire ou un administrateur de l'espace de travail l'approuve, connecté, ce que Claude ne peut pas faire à votre place. Consultez [la validation humaine des e-mails envoyés par une IA](/blog/approve-ai-agent-email-sends).
- **Le brouillon d'abord.** Quand vous demandez un e-mail, MCPEmails indique à Claude de l'enregistrer comme brouillon dans cette boîte, où vous pouvez le lire et le modifier avant que quoi que ce soit ne parte.

Les e-mails sont écrits par d'autres personnes, et certains sont rédigés pour manipuler une IA. Une tâche qui lit des e-mails et peut aussi en envoyer devrait avoir l'un de ces garde-fous activé.

## Des prompts pour plusieurs boîtes

> Avec MCPEmails, parcours ma boîte professionnelle et mon Outlook personnel, et liste tout ce qui, sur les deux derniers jours, attend une réponse de ma part. Une seule liste, chaque ligne marquée avec la boîte. N'envoie et ne déplace rien.

> Avec MCPEmails, trouve la confirmation de vol de la semaine prochaine. Cherche dans toutes les boîtes connectées et dis-moi dans laquelle elle se trouve.

> Avec MCPEmails, rédige depuis sales@ une réponse à la demande la plus récente et enregistre-la comme brouillon. Ne l'envoie pas.

Pour obtenir le même résumé chaque matin sans le demander, programmez le premier prompt : [le résumé quotidien de vos e-mails avec Claude et ChatGPT](/blog/daily-email-briefing-with-claude-and-chatgpt) présente les tâches programmées de Claude. [Plusieurs comptes e-mail dans Claude et ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) couvre la même configuration dans les conversations Claude et dans ChatGPT.

## FAQ

**Claude Cowork peut-il utiliser deux comptes Gmail ?**
Pas avec le connecteur Gmail intégré de Claude, qu'Anthropic décrit comme limité au seul compte Google que vous avez connecté. Connectez les deux comptes à MCPEmails avec des mots de passe d'application Google et ajoutez MCPEmails comme connecteur personnalisé ; une tâche Cowork voit alors les deux.

**Cowork peut-il lire mes e-mails Outlook.com ou Hotmail personnels ?**
Pas avec le connecteur Microsoft 365 de Claude, qui refuse les comptes Microsoft personnels. Connectez l'adresse à MCPEmails avec Se connecter avec Microsoft, puis ajoutez MCPEmails à Claude. [Connecter Claude à Outlook.com et Hotmail](/blog/connect-claude-to-outlook-com-hotmail) donne les étapes.

**Les connecteurs personnalisés fonctionnent-ils dans Cowork ?**
Oui. Anthropic indique que les connecteurs personnalisés sont disponibles dans Claude, Cowork et Claude Desktop. Il doit s'agir de serveurs distants accessibles sur Internet ; un serveur local déclaré dans le fichier de configuration de l'application de bureau n'est pas disponible dans Cowork.

**Faut-il un connecteur par boîte ?**
Non. Un seul connecteur MCPEmails couvre toutes les boîtes de votre espace de travail, et la même URL fonctionne dans les conversations Claude, dans Cowork, dans ChatGPT et dans d'autres clients MCP.

**Claude peut-il envoyer des e-mails depuis Cowork ?**
Oui, depuis toute boîte que vous avez connectée avec l'accès Standard ou Accès complet. [Claude peut-il lire et envoyer mes e-mails ?](/blog/can-claude-read-my-email#claude-peut-il-envoyer-des-e-mails) compare la façon dont chaque connecteur gère l'envoi.

## Prochaine étape

[Commencez gratuitement](/signup), connectez la boîte que vous consultez le plus, ajoutez MCPEmails à Claude et demandez à une tâche Cowork ce qui attend une réponse aujourd'hui. Ajoutez les autres boîtes quand vous voudrez une seule réponse au lieu de plusieurs.`,
};

export default translation;
