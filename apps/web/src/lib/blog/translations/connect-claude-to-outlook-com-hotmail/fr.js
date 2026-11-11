const translation = {
  title: 'Connecter Claude à Hotmail et Outlook.com (comptes personnels)',
  description:
    "Le connecteur Microsoft 365 de Claude accepte désormais un compte Microsoft personnel sur les formules Free, Pro, Max et Ultra. Quand cela suffit, et comment connecter Hotmail, Outlook.com, Live ou MSN à Claude avec les pièces jointes, plusieurs boîtes ou une formule Team grâce à une seule URL de connecteur personnalisé.",
  coverAlt: 'Claude connecté à une boîte Outlook.com ou Hotmail personnelle via MCPEmails',
  content: `Il existe deux façons de connecter Claude à une adresse personnelle Outlook.com, Hotmail, Live ou MSN. Le connecteur Microsoft 365 de Claude accepte un compte Microsoft personnel sur les formules Free, Pro, Max et Ultra, sans qu'aucun administrateur intervienne. L'autre voie est MCPEmails : vous ajoutez la boîte avec **Se connecter avec Microsoft**, puis vous ajoutez une seule URL dans Claude comme connecteur personnalisé. Cette seconde voie couvre ce que le connecteur intégré laisse de côté : les pièces jointes, plusieurs boîtes derrière une seule connexion, les formules Team et Enterprise, et la même boîte dans ChatGPT ou tout autre client MCP. Une vieille adresse hotmail.com fonctionne exactement comme une adresse outlook.com récente dans les deux cas.

Ce guide concerne les comptes Microsoft personnels dans Claude. Si votre messagerie est un compte Microsoft 365 professionnel ou scolaire, lisez plutôt le [guide Outlook et Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## Ce que le connecteur Microsoft 365 de Claude fait avec un compte personnel

L'article [Connect to Microsoft 365](https://support.claude.com/en/articles/15183774-connect-to-microsoft-365) d'Anthropic couvre désormais les comptes personnels. Sur les formules Free, Pro, Max et Ultra, vous pouvez connecter vous-même un compte Outlook.com, Hotmail, Live ou MSN ; aucun administrateur n'est nécessaire. Le connecteur atteint Outlook et OneDrive, et ses outils d'écriture sont inclus : Claude peut donc rédiger et envoyer des e-mails et gérer des événements de calendrier après vous avoir demandé votre accord.

Trois limites du même article comptent pour les e-mails :

- **Pas de pièces jointes dans les outils d'écriture.** Claude ne peut pas envoyer, transférer ni rédiger un e-mail avec une pièce jointe par ce connecteur.
- **Pas sur Team ni Enterprise.** Ces formules ne voient pas l'option de compte personnel, donc une adresse Hotmail personnelle à côté d'une formule professionnelle n'a aucune voie intégrée.
- **Dans Claude uniquement, pour le compte avec lequel vous vous connectez.** Gmail a son propre connecteur ; iCloud, Yahoo et les boîtes IMAP n'en ont aucun, et rien ne se transpose dans ChatGPT ni dans un autre client MCP.

Les comptes professionnels ou scolaires sont un cas différent : un administrateur général Microsoft Entra doit toujours donner son consentement avant que quiconque dans l'organisation puisse se connecter. Le [guide Outlook et Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) et la [page sur le consentement administrateur](/docs/microsoft-365-admin-consent) expliquent cette procédure.

Si une seule boîte Outlook.com personnelle dans Claude, sans pièces jointes, vous suffit, le connecteur intégré fait l'affaire. Le reste de ce guide décrit la voie pour tout le reste.

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

Non. Chaque fois que Claude demande un message, MCPEmails le récupère en direct chez Microsoft, le transmet à Claude et n'en garde aucune copie. Pour la boîte, nous conservons le jeton OAuth issu de votre connexion Microsoft, chiffré au repos, plus les quelques informations dont a besoin une fonctionnalité que vous activez, comme un message programmé en attente d'envoi. Pour déconnecter la boîte, supprimez-la dans MCPEmails, ou retirez MCPEmails des applications qui ont accès à votre compte Microsoft. [Pourquoi le « courriel jamais stocké » compte](/blog/why-email-never-stored-matters) explique ce principe, et [est-il sûr de donner à un agent IA l'accès à ses e-mails ?](/blog/is-it-safe-to-give-ai-agent-email-access) détaille les points de vigilance, comme les instructions cachées dans un e-mail.

## FAQ

**Puis-je connecter Claude à Outlook.com ou Hotmail ?**
Oui, de deux façons. Sur Free, Pro, Max ou Ultra, le connecteur Microsoft 365 intégré à Claude accepte directement un compte Microsoft personnel, sans pièces jointes. Pour les pièces jointes, plusieurs boîtes, une formule Team ou Enterprise, ou la même boîte dans ChatGPT, connectez l'adresse à MCPEmails avec Se connecter avec Microsoft, ajoutez \`https://mcpemails.com/api/mcp\` dans Claude sous Personnaliser → Connecteurs, et Claude peut lire, rechercher, envoyer et ranger vos e-mails Outlook.com, Hotmail, Live ou MSN.

**Pourquoi le connecteur Microsoft 365 de Claude refuse-t-il mon adresse Hotmail ?**
Vérifiez la formule. Anthropic indique que les comptes Microsoft personnels se connectent sur Free, Pro, Max et Ultra, et que les formules Team et Enterprise ne voient pas cette option. Une adresse professionnelle ou scolaire est un autre cas : un administrateur général de son tenant Microsoft Entra doit d'abord donner son consentement. Sur une formule Team ou Enterprise, MCPEmails en connecteur personnalisé est la voie pour une adresse personnelle.

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
