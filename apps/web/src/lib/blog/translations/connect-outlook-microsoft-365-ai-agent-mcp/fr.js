const translation = {
  title: 'Connecter Outlook et Microsoft 365 à votre agent IA via MCP',
  description:
    "Connectez Outlook.com ou Microsoft 365 à votre agent IA via MCP. Connexion avec Microsoft, sans mot de passe d'application, avec Microsoft Graph en coulisses. Les comptes professionnels peuvent nécessiter une approbation unique de l'administrateur informatique.",
  coverAlt: 'Connecter Outlook et Microsoft 365 à un agent IA via MCP',
  content: `Pour connecter une boîte Outlook ou Microsoft 365 à votre agent IA, vous ajoutez la boîte dans le tableau de bord MCP Emails avec **Se connecter avec Microsoft**, puis vous pointez votre agent vers un seul endpoint MCP. Pas de mot de passe d'application, pas de réglages IMAP ou SMTP, pas de portail Azure et pas de serveur Graph à vous. Un compte personnel Outlook.com se connecte en quelques minutes. Un compte professionnel ou scolaire Microsoft 365 demande souvent une étape de plus avant : un administrateur informatique approuve l'application une seule fois pour toute l'organisation.

La plupart des guides « IA pour l'e-mail » supposent Gmail et s'arrêtent là. Si vous vivez dans Outlook, voici la version pensée pour Outlook : quels comptes se connectent directement, à quoi ressemble l'étape d'approbation par l'administrateur, ce que votre agent peut faire une fois connecté, et les quelques endroits où Outlook se comporte autrement que Gmail.

## Comptes personnels et comptes professionnels : deux cas différents

L'e-mail Microsoft n'est pas une seule chose, et la différence décide du déroulement de votre connexion.

- **Comptes Microsoft personnels** : adresses Outlook.com, Hotmail, Live et MSN. Vous vous connectez avec Microsoft, vous approuvez vous-même les autorisations, et c'est connecté. Aucun administrateur n'intervient.
- **Comptes professionnels ou scolaires Microsoft 365** : ils vivent dans le tenant Microsoft Entra de votre organisation. Beaucoup d'organisations exigent qu'un administrateur informatique approuve une application tierce avant que quiconque puisse l'utiliser. La stratégie de consentement par défaut de Microsoft (depuis fin 2025) ne permet pas aux employés d'approuver eux-mêmes l'accès en lecture à la boîte, donc dans beaucoup de tenants vous ne pourrez pas terminer la connexion seul. C'est une stratégie du tenant Microsoft, pas quelque chose que MCP Emails peut désactiver, et elle s'applique à toute application e-mail tierce.

L'approbation par l'administrateur est une étape unique pour toute l'organisation. Une fois faite, chaque employé se connecte normalement.

Chaque cas a aussi son résumé sur une seule page : [Outlook.com](/connect/outlook) pour les comptes personnels et [Microsoft 365](/connect/office365) pour les comptes professionnels ou scolaires.

## Connectez votre boîte Outlook ou Microsoft 365

Deux parties : connecter la boîte, puis connecter l'agent. Elles sont séparées exprès. La connexion de la boîte permet à MCP Emails d'atteindre votre boîte, et la connexion de l'agent permet à votre client IA d'atteindre MCP Emails.

### Étape 1 : ajoutez la boîte

1. [Commencez gratuitement](/signup) et ouvrez le tableau de bord.
2. Allez dans **Inboxes → Connect Inbox** et choisissez **Outlook**.
3. Cliquez sur **Se connecter avec Microsoft**. Vous êtes envoyé sur la page de connexion de Microsoft.
4. Connectez-vous avec votre compte Microsoft et terminez la MFA si votre compte l'utilise.
5. Lisez l'écran de consentement et approuvez. Microsoft indique que l'application provient d'un éditeur vérifié, et demande l'autorisation de lire et d'écrire vos e-mails, d'envoyer des e-mails en votre nom et de garder l'accès jusqu'à ce que vous déconnectiez.

MCP Emails stocke le jeton OAuth obtenu, chiffré, et rien d'autre de votre boîte. Vous ne saisissez jamais votre mot de passe Microsoft dans MCP Emails, et il n'y a pas de mot de passe d'application à générer. C'est la principale différence avec les fournisseurs IMAP : [iCloud, Fastmail et les boîtes IMAP génériques](/blog/connect-icloud-fastmail-imap-to-claude) utilisent à la place un mot de passe spécifique à l'application.

### Si votre organisation doit d'abord approuver l'application

Sur un compte professionnel ou scolaire, Microsoft peut vous arrêter avant l'écran de consentement en indiquant qu'une approbation de l'administrateur est requise. Dans ce cas, le tableau de bord vous donne un lien d'approbation à partager :

1. Copiez le lien et envoyez-le à votre administrateur informatique.
2. Votre administrateur l'ouvre, se connecte avec son compte administrateur Microsoft et approuve MCP Emails une seule fois pour toute l'organisation. Il n'a pas besoin de compte MCP Emails.
3. Revenez au tableau de bord et connectez Outlook comme à l'étape 1. Cela passe désormais comme pour un compte personnel.

Votre administrateur approuve l'application pour l'organisation, et chaque personne se connecte toujours avec son propre compte et ne connecte que sa propre boîte.

### Si le compte n'a pas de boîte Exchange

Certains comptes Microsoft n'ont pas de boîte Exchange Online, par exemple un compte administrateur sans licence Exchange, ou une organisation dont les e-mails sont hébergés ailleurs. MCP Emails refuse ces comptes parce qu'il n'y a rien à connecter, et vous le dit. Si vos e-mails se trouvent en réalité sur un autre serveur, connectez l'adresse en IMAP.

### Étape 2 : connectez votre agent

Vous connectez un client une fois, et la même configuration fonctionne pour toutes les boîtes de votre compte. Pour les clients compatibles OAuth (claude.ai, Claude Desktop, Cursor), dans claude.ai c'est :

**Customize → Connectors → Add connector → collez l'URL → Connect → connectez-vous et approuvez.**

L'endpoint est :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Quand vous cliquez sur Connect, vous vous connectez à votre compte MCP Emails et approuvez les portées : \`read:email\`, \`send:email\`, ou les deux. Aucune clé d'API ne change de mains.

Pour les clients qui ne parlent pas OAuth (Cline, plugins JetBrains, vos propres scripts, cURL brut), générez une clé à portée limitée dans **Dashboard → API Keys** et envoyez-la sous la forme \`Authorization: Bearer <api-key>\`. Le guide complet pour ces clients se trouve dans [l'e-mail pour les agents IA dans Cursor, Cline et VS Code](/blog/email-for-ai-agents-cursor-cline-vscode). Si vous hésitez entre les deux approches, [OAuth ou clés d'API pour l'accès IA à l'e-mail](/blog/oauth-vs-api-keys-ai-email-access) détaille les compromis.

## Microsoft Graph, en coulisses

Outlook se connecte via Microsoft Graph, pas via IMAP. Chaque appel d'outil de votre agent part vers Graph en temps réel : vous lisez un message, MCP Emails le récupère depuis Graph, transmet le résultat à votre agent et le jette. Vous envoyez un message, il part via Graph depuis votre vraie adresse, donc votre délivrabilité et votre réputation restent les vôtres. MCP Emails ne relaie jamais d'e-mails depuis son propre domaine.

## Ce que votre agent peut faire avec une boîte Outlook

- Lire et rechercher des e-mails.
- Envoyer, répondre et transférer. Un message envoyé peut contenir jusqu'à 10 Mo de pièces jointes, et le téléchargement d'une pièce jointe ou le transfert d'un original avec ses pièces jointes fonctionne jusqu'à 25 Mo.
- Travailler avec des brouillons et programmer un envoi pour plus tard.
- Travailler avec les dossiers, y compris les dossiers imbriqués.
- Déplacer, copier et archiver des messages.
- Marquer et démarquer des messages d'un indicateur, et les marquer comme lus ou non lus.
- Déplacer des messages vers Éléments supprimés, ou les supprimer définitivement.
- Utiliser la signature définie pour cette boîte sur chaque message envoyé par l'agent.

### Là où Outlook diffère de Gmail

**Des dossiers, pas des libellés.** Outlook range les e-mails dans des dossiers. Les outils de libellés sont réservés à Gmail, donc sur une boîte Outlook votre agent classe les e-mails en les déplaçant dans un dossier. Seule exception, les automatisations : l'action de libellé d'une automatisation applique une catégorie Outlook au message.

**Recherche.** La recherche Outlook s'appuie sur la recherche propre de Microsoft Graph. Une limite de Graph compte : une recherche textuelle ne peut pas être combinée avec les filtres non lu, avec pièce jointe, avec indicateur ou de date. Quand votre requête contient du texte, ces filtres ne sont pas appliqués, et le résultat indique à votre agent lesquels ont été laissés de côté. Si vous avez besoin des deux, cherchez d'abord le texte et laissez l'agent affiner les résultats qu'il reçoit.

**Nouveaux comptes Outlook.com.** Microsoft peut bloquer temporairement l'envoi depuis un compte Outlook.com tout neuf qui envoie beaucoup de messages en peu de temps. C'est la protection anti-abus de Microsoft. Si l'envoi échoue sur un nouveau compte, envoyez à un rythme plus lent et réessayez plus tard.

## Un flux de travail qui vaut la peine

Voici une boucle de tri qui fonctionne bien sur une boîte Outlook. Une ou deux fois par heure, l'agent :

1. Liste les e-mails non lus de la boîte de réception.
2. Lit tout ce qui semble urgent.
3. Résume le lot et rédige des brouillons de réponse pour ceux auxquels vous répondriez évidemment.
4. Laisse tout en non lu jusqu'à votre confirmation.

MCP Emails ne pousse pas les nouveaux e-mails vers votre agent, donc l'agent vérifie selon la fréquence que vous choisissez. Pour le tri, c'est suffisant. Pour les schémas d'interrogation qui tiennent la route, lisez [comment trier et résumer une boîte de réception](/blog/ai-agent-triage-summarize-inbox).

## Comparé à la création de votre propre serveur Microsoft 365

Les serveurs MCP Outlook auto-hébergés que l'on trouve sur GitHub se heurtent tous au même mur : l'enregistrement de l'application dans Entra, le consentement de l'administrateur et le cycle de vie des jetons Graph sont le vrai travail, et il vous revient pour toujours. La version auto-hébergée de MCP Emails fonctionne uniquement en IMAP et SMTP. Le connecteur Outlook reste sur le produit hébergé, donc quelqu'un qui le voudrait sur sa propre installation devrait enregistrer sa propre application Microsoft Entra. Avec l'approche hébergée, le jeton est chiffré au repos, déchiffré uniquement au moment de l'appel, et vous pouvez déconnecter la boîte depuis le tableau de bord à tout moment. [Hébergé ou auto-hébergé](/blog/hosted-vs-self-hosted-gmail-mcp-server) approfondit les compromis.

Si vous voulez le contexte sur la raison d'être de cette couche, le [guide complet pour donner à votre agent IA l'accès à l'e-mail](/blog/how-to-give-your-ai-agent-email-access) est le point de départ. Sinon, [commencez gratuitement](/signup), connectez votre boîte Outlook, pointez votre agent vers l'endpoint et donnez-lui quelque chose à lire.`,
};

export default translation;
