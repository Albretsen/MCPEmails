const translation = {
  title: 'Connecter Claude à Hotmail et Outlook.com (comptes personnels)',
  description:
    "Le connecteur Microsoft 365 de Claude n'accepte pas les comptes Microsoft personnels. Connectez une boîte Hotmail, Outlook.com, Live ou MSN à Claude avec Se connecter avec Microsoft et une seule URL de connecteur personnalisé.",
  coverAlt: 'Claude connecté à une boîte Outlook.com ou Hotmail personnelle via MCPEmails',
  content: `Pour connecter Claude à une adresse personnelle Outlook.com, Hotmail, Live ou MSN, vous ajoutez la boîte à MCPEmails avec **Se connecter avec Microsoft**, puis vous ajoutez une seule URL dans Claude comme connecteur personnalisé. Le connecteur Microsoft 365 de Claude exige un tenant Microsoft professionnel, et Anthropic précise que les comptes Microsoft personnels ne peuvent pas l'utiliser. Un connecteur personnalisé n'a pas cette contrainte : une vieille adresse hotmail.com fonctionne exactement comme une adresse outlook.com récente.

Ce guide concerne les comptes Microsoft personnels dans Claude. Si votre messagerie est un compte Microsoft 365 professionnel ou scolaire, lisez plutôt le [guide Outlook et Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## Pourquoi le connecteur Microsoft 365 de Claude refuse les comptes personnels

La [page d'aide d'Anthropic sur le connecteur Microsoft 365](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) pose deux conditions avant toute connexion :

- Le compte doit appartenir à un tenant Microsoft Entra rattaché à un abonnement Microsoft Business.
- Un administrateur général de ce tenant doit d'abord autoriser l'intégration.

La même page indique que les comptes Microsoft personnels, comme les adresses @outlook.com ou @hotmail.com, ne peuvent pas être utilisés pour se connecter. Un compte personnel n'a ni tenant professionnel ni administrateur derrière lui : il n'y a donc rien à approuver, et aucun réglage à modifier pour que cela fonctionne. Ce connecteur est conçu pour les organisations : il effectue des recherches dans SharePoint, OneDrive, Outlook et Teams, et ses autorisations restent en lecture seule tant qu'un administrateur n'a pas activé les outils d'écriture.

Votre boîte, elle, n'a aucun problème. Claude a simplement besoin d'un autre chemin pour y accéder.

## Ce qu'il vous faut

- Un compte Microsoft personnel avec une boîte Outlook : une adresse en outlook.com, hotmail.com, live.com ou msn.com, y compris les versions nationales comme hotmail.fr, outlook.fr ou live.fr.
- Claude sur le web ou Claude Desktop. Anthropic propose les connecteurs personnalisés sur toutes les formules Claude, y compris la formule gratuite, qui en autorise un.
- Un compte MCPEmails. [Commencez gratuitement](/signup) et gardez l'onglet ouvert.

MCPEmails fait le lien entre les deux. Il parle à Claude via le Model Context Protocol d'un côté, et à votre boîte Outlook.com via Microsoft Graph de l'autre.

## Étape 1 : connectez votre boîte Outlook.com ou Hotmail

1. Dans le tableau de bord MCPEmails, allez dans **Boîtes** et cliquez sur **Connecter la boîte**.
2. Choisissez **Outlook**, puis cliquez sur **Se connecter avec Microsoft**.
3. Connectez-vous sur la page de Microsoft avec votre adresse Outlook.com, Hotmail, Live ou MSN, et terminez la vérification en deux étapes si votre compte l'utilise.
4. Relisez les autorisations et acceptez. Microsoft vous demande d'autoriser MCPEmails à lire et modifier vos e-mails, à envoyer des e-mails en votre nom, à conserver cet accès, et à voir votre profil de base et votre adresse e-mail.

Vous revenez sur le tableau de bord avec la boîte connectée. Aucun administrateur n'intervient pour un compte personnel, et vous ne saisissez jamais votre mot de passe Microsoft dans MCPEmails.

### N'utilisez ni IMAP ni mot de passe d'application

Beaucoup d'anciens tutoriels expliquent comment créer un mot de passe d'application et saisir les paramètres IMAP d'Outlook. Cela ne fonctionne plus : Microsoft a [mis fin à la connexion par mot de passe pour les comptes Outlook dans les applications de messagerie tierces](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d) le 16 septembre 2024. Si vous choisissez **IMAP / SMTP** et saisissez une adresse Hotmail ou Outlook.com, le tableau de bord affiche un avertissement avec un bouton **Utiliser Se connecter avec Microsoft** qui vous ramène à l'option Outlook. La [page des paramètres Outlook.com](/connect/outlook) rassemble les détails du fournisseur au même endroit.

## Étape 2 : ajoutez MCPEmails à Claude comme connecteur personnalisé

Dans claude.ai ou Claude Desktop :

1. Ouvrez **Personnaliser → Connecteurs**.
2. Cliquez sur **+ Ajouter**, puis sur **Ajouter un connecteur personnalisé**.
3. Donnez-lui un nom, par exemple MCPEmails, et collez cette URL :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Cliquez sur **Continuer**, gardez les paramètres d'authentification détectés par Claude, puis cliquez sur **Ajouter**.
5. Cliquez sur **Connecter**, identifiez-vous avec votre compte MCPEmails et approuvez les autorisations que vous voulez donner à Claude, par exemple \`read:email\` pour lire vos e-mails et \`send:email\` pour en envoyer.

Pour l'utiliser dans une conversation, cliquez sur **+** en bas à gauche de la zone de message, choisissez **Connecteurs** et activez MCPEmails. Aucune clé API à créer, aucun fichier de configuration à modifier. Sur une formule Team ou Enterprise, seul un propriétaire peut ajouter un connecteur personnalisé ; les membres le retrouvent ensuite dans **Personnaliser → Connecteurs** et cliquent sur **Connecter**. Si Claude se bloque sur l'un de ces écrans, la [page de configuration de Claude](/docs/claude) couvre les problèmes courants.

## Étape 3 : demandez quelque chose de simple à Claude

Commencez par une demande en lecture seule :

> « Résume mes cinq derniers e-mails non lus dans ma boîte Hotmail et dis-moi lesquels demandent une réponse. »

Claude utilise l'outil \`email_read\` pour lister et ouvrir les messages. S'il répond, la connexion fonctionne. Essayez ensuite :

- « Retrouve la confirmation de commande reçue la semaine dernière et donne-moi la date de livraison. »
- « Rédige une réponse au dernier e-mail de mon propriétaire, mais ne l'envoie pas. »
- « Déplace toutes les newsletters de ce mois-ci dans un dossier appelé À lire. »

Si vous avez aussi Gmail, iCloud ou une boîte professionnelle, connectez-les de la même façon : Claude les voit toutes via le même connecteur. [Plusieurs comptes e-mail dans Claude et ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explique comment Claude les distingue.

## Ce que Claude peut faire avec une boîte Outlook.com

Une fois connecté, Claude utilise les mêmes outils e-mail que pour n'importe quel autre fournisseur :

- Lire et rechercher des e-mails.
- Envoyer, répondre et transférer depuis votre propre adresse, avec pièces jointes.
- Créer et modifier des brouillons, et programmer un envoi pour plus tard.
- Créer des dossiers, y compris imbriqués, et déplacer, copier et archiver des messages.
- Ajouter un indicateur aux messages et les marquer comme lus ou non lus.
- Déplacer des messages vers Éléments supprimés ou les supprimer définitivement.
- Ajouter à chaque message envoyé la signature définie pour cette boîte.

Outlook.com range les e-mails dans des dossiers, pas avec des libellés : Claude classe donc un message en le déplaçant dans un dossier. Une limite de Microsoft Graph mérite d'être connue : une recherche textuelle ne peut pas être combinée avec les filtres non lu, avec pièce jointe, avec indicateur ou de date. Quand une recherche contient du texte, ces filtres sont ignorés, et le résultat indique à Claude lesquels. Lancez d'abord la recherche par texte, puis laissez Claude affiner les résultats.

MCPEmails ne pousse pas les nouveaux e-mails vers Claude. Claude consulte la boîte quand vous le lui demandez, ce qui convient bien au tri et aux résumés.

## Mes e-mails Outlook.com sont-ils stockés quelque part ?

Non. Chaque fois que Claude demande un message, MCPEmails le récupère en direct chez Microsoft, le transmet à Claude et n'en garde aucune copie. La seule chose conservée pour la boîte est le jeton OAuth issu de votre connexion Microsoft, chiffré au repos. Pour déconnecter la boîte, supprimez-la dans MCPEmails, ou retirez MCPEmails des applications qui ont accès à votre compte Microsoft. [Pourquoi le « courriel jamais stocké » compte](/blog/why-email-never-stored-matters) explique ce principe, et [est-il sûr de donner à un agent IA l'accès à ses e-mails ?](/blog/is-it-safe-to-give-ai-agent-email-access) détaille les points de vigilance, comme les instructions cachées dans un e-mail.

## FAQ

**Puis-je connecter Claude à Outlook.com ou Hotmail ?**
Oui. Le connecteur Microsoft 365 intégré à Claude ne prend pas en charge les comptes Microsoft personnels, mais un connecteur personnalisé, si. Connectez l'adresse à MCPEmails avec Se connecter avec Microsoft, ajoutez \`https://mcpemails.com/api/mcp\` dans Claude sous Personnaliser → Connecteurs, et Claude peut lire, rechercher, envoyer et ranger vos e-mails Outlook.com, Hotmail, Live ou MSN.

**Pourquoi le connecteur Microsoft 365 de Claude refuse-t-il mon adresse Hotmail ?**
La page d'aide d'Anthropic indique que ce connecteur nécessite un tenant Microsoft Entra rattaché à un abonnement Microsoft Business et un administrateur général pour l'autoriser, et que les comptes Microsoft personnels ne peuvent pas être utilisés. Un compte personnel n'a ni tenant ni administrateur.

**Ai-je besoin d'un mot de passe d'application ou des paramètres IMAP ?**
Non. Les comptes Microsoft personnels se connectent avec Se connecter avec Microsoft et Microsoft Graph. Microsoft n'accepte plus la connexion par mot de passe depuis les applications de messagerie tierces sur ces comptes, donc un mot de passe d'application ne permettrait de toute façon pas de se connecter.

**Est-ce que cela marche avec une vieille adresse Hotmail ?**
Oui. Les adresses Hotmail, Live, MSN et Outlook.com relèvent du même service de messagerie grand public de Microsoft, elles se connectent donc toutes de la même façon. Si le compte Microsoft avec lequel vous vous connectez n'a pas de boîte Outlook, MCPEmails refuse la connexion et vous l'indique.

**La même configuration fonctionne-t-elle dans ChatGPT ?**
Oui. L'URL du connecteur est la même, et [connecter ChatGPT à vos e-mails](/blog/connect-chatgpt-to-email) détaille la partie ChatGPT.

## Prochaine étape

[Commencez gratuitement](/signup), connectez votre boîte Outlook.com ou Hotmail avec Microsoft, ajoutez l'URL dans Claude et demandez-lui de résumer vos e-mails non lus. Pour tous les autres fournisseurs, le [guide de configuration des e-mails dans Claude](/blog/connect-claude-to-email) couvre Gmail, iCloud, Fastmail et IMAP.`,
};

export default translation;
