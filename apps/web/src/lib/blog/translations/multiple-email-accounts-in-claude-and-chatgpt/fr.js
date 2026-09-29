const translation = {
  title: 'Plusieurs comptes e-mail dans Claude et ChatGPT : toutes vos boîtes, un seul connecteur',
  description:
    'Comment ajouter plusieurs comptes e-mail à Claude et ChatGPT en même temps, y compris les boîtes d\'entreprise chez IONOS, Zoho, Namecheap, Google Workspace ou sur votre propre serveur, avec un seul connecteur MCP qui fonctionne dans les deux.',
  coverAlt:
    'Plusieurs comptes e-mail professionnels et personnels connectés à Claude et ChatGPT via un seul connecteur MCP',
  content: `Vous voulez poser une seule question et obtenir la réponse sur toutes les boîtes que vous gérez : votre propre adresse, info@, ventes@, la boîte des factures, peut-être un Gmail personnel. Ce guide explique comment faire entrer plusieurs comptes e-mail dans Claude et ChatGPT en même temps, ce que couvrent déjà les connecteurs intégrés, et dans quels cas il vous faut plutôt un serveur MCP.

**Aller à :** [Connecteurs intégrés](#ce-que-font-les-connecteurs-intgrs) · [Un connecteur pour toutes les boîtes](#un-seul-connecteur-pour-toutes-les-botes) · [Configuration Claude](#lajouter-claude) · [Configuration ChatGPT](#lajouter-chatgpt) · [Offres](#combien-de-botes-chaque-offre-connecte)

## Ce que font les connecteurs intégrés

Les deux assistants proposent leurs propres connecteurs de messagerie, et ceux-ci évoluent vite. Voici où ils en étaient au moment de la rédaction (septembre 2026).

- **ChatGPT.** Depuis fin août 2026, ses propres plugins Gmail, Google Calendar et Google Contacts peuvent accueillir plus d'un compte sur Plus, Pro, Business et Enterprise, si bien qu'un Gmail personnel et un Gmail professionnel peuvent cohabiter dans la même conversation. En septembre, OpenAI a étendu les comptes multiples à d'autres plugins. Si toutes vos boîtes sont des comptes Google, le plugin de ChatGPT peut suffire.
- **Claude.** Le centre d'aide d'Anthropic décrit le connecteur Gmail comme accédant à "the Google account you've connected", c'est-à-dire le compte Google que vous avez connecté. Un compte Google par connexion.

Ce qu'aucun des deux ne sait faire, c'est atteindre la boîte qu'une entreprise utilise réellement sur son propre domaine quand ce domaine n'est ni chez Google ni chez Microsoft : IONOS, Zoho Mail, Namecheap Private Email, STRATO, Migadu, un hébergeur cPanel ou votre propre serveur. Ces boîtes parlent IMAP et SMTP, et pour les atteindre il faut un outil qui parle IMAP.

## Un seul connecteur pour toutes les boîtes

MCP Emails est un serveur MCP hébergé. Vous y connectez chaque boîte une fois, et votre client IA les atteint toutes via une seule URL :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **N'importe quel mélange de fournisseurs.** Gmail et Google Workspace (mot de passe d'application ou connexion avec Google), Outlook et Microsoft 365 (connexion avec Microsoft), iCloud, Fastmail, Yahoo, Zoho, Yandex, et toute boîte qui parle IMAP et SMTP. Il existe une page par hébergeur dans [connect](/connect), dont [IONOS](/connect/ionos), [Zoho Mail](/connect/zoho), [Namecheap](/connect/namecheap), [STRATO](/connect/strato), [Migadu](/connect/migadu), [Google Workspace](/connect/google-workspace) et [Microsoft 365](/connect/office365).
- **Les mêmes boîtes dans les deux assistants.** C'est un serveur MCP standard : la même connexion fonctionne dans Claude et dans ChatGPT, ainsi que dans Cursor, VS Code et d'autres clients MCP. Ajoutez une boîte une fois, et tous les clients la voient.
- **L'agent sait quelle boîte est laquelle.** Il appelle \`inbox_list\` et obtient chaque adresse connectée avec son nom affiché. Tous les autres outils nomment la boîte sur laquelle ils agissent : il vous suffit de dire « dans ventes@ », en langage courant.
- **Les réponses partent de la bonne adresse.** Chaque boîte envoie via son propre fournisseur ou serveur SMTP, avec son propre nom d'expéditeur et sa propre signature. Une réponse à un fil de support@ part de support@.

Le courrier est récupéré en direct à chaque requête et n'est pas stocké. La seule exception est un message que vous planifiez pour plus tard, conservé jusqu'à son envoi.

## Connecter les boîtes

Dans le tableau de bord MCP Emails, ouvrez **Inboxes**, puis **Connect Inbox**, une fois par boîte :

- **Boîte d'entreprise sur son propre domaine.** Choisissez **IMAP** et saisissez l'adresse. Les hébergeurs courants sont reconnus à partir de l'adresse, et un domaine Google Workspace est reconnu grâce à ses enregistrements de messagerie : les réglages se remplissent donc tout seuls. Utilisez le mot de passe ou le mot de passe d'application exigé par votre hébergeur.
- **Gmail ou Google Workspace.** Un mot de passe d'application, ou la connexion avec Google. Sur Workspace, c'est votre administrateur qui décide si les mots de passe d'application et l'IMAP sont autorisés.
- **Outlook ou Microsoft 365.** Connexion avec Microsoft. Un compte professionnel ou scolaire peut nécessiter qu'un administrateur informatique approuve l'application une seule fois pour toute l'organisation.

Donnez à chaque boîte un nom affiché clair, par exemple « Acme Ventes » plutôt que « travail2 ». C'est ce que l'agent lit pour les distinguer, et c'est le nom que voient les destinataires.

## L'ajouter à Claude

Dans claude.ai ou Claude Desktop :

1. Ouvrez **Settings**, puis **Connectors**.
2. Choisissez **Add custom connector** et collez \`https://mcpemails.com/api/mcp\`.
3. Sélectionnez **Connect**, connectez-vous à MCP Emails et approuvez.

Toutes les boîtes que vous avez connectées sont maintenant disponibles. Le [guide Claude](/blog/connect-claude-to-email) donne les détails.

## L'ajouter à ChatGPT

Les connecteurs personnalisés exigent ChatGPT Plus, Pro, Business, Enterprise ou Edu, sur le web, avec le mode développeur activé. Sur Business et Enterprise, un administrateur doit parfois d'abord l'autoriser.

1. Activez le **mode développeur** dans les réglages de ChatGPT, sous les paramètres avancés des applications et connecteurs.
2. Créez un connecteur, collez \`https://mcpemails.com/api/mcp\`, choisissez **OAuth** et autorisez avec MCP Emails.
3. Dans chaque nouvelle conversation, cliquez sur **+**, choisissez **Developer mode** et sélectionnez l'app MCP Emails.

Le [guide ChatGPT](/blog/connect-chatgpt-to-email) détaille les menus et les erreurs courantes.

## Des prompts qui utilisent plusieurs boîtes

> Parcours ventes@ et info@ et liste toutes les demandes de cette semaine auxquelles personne n'a répondu. Une seule liste combinée, étiquetée avec la boîte d'origine. N'envoie et ne déplace rien.

> Trouve la facture Hetzner du mois d'août. Cherche dans toutes les boîtes connectées et dis-moi dans laquelle elle se trouve.

> Rédige depuis support@ une réponse à la dernière réclamation de livraison. Montre-la-moi avant de l'envoyer.

Un appel atteint une seule boîte : « cherche dans toutes les boîtes » revient donc à ce que l'agent lance la recherche une fois par boîte et fusionne les réponses. Demandez une seule liste combinée, sinon vous obtiendrez un rapport par compte. [Gérer plusieurs comptes e-mail avec l'IA](/blog/manage-multiple-email-accounts-with-ai) approfondit le cadrage des demandes, l'identité d'expéditeur et la validation boîte par boîte.

## Garder un humain sur le bouton d'envoi

Activez **Vérifier avant d'envoyer** (Review before sending) sur n'importe quelle boîte, et chaque envoi, réponse, transfert, envoi de brouillon et envoi planifié depuis cette boîte attend votre validation dans le tableau de bord. Le réglage se fait boîte par boîte : la boîte des factures peut être retenue pendant que la vôtre envoie librement. Il est inclus dans toutes les offres, y compris l'offre gratuite. Voir [la validation humaine des envois par un agent IA](/blog/approve-ai-agent-email-sends).

## Combien de boîtes chaque offre connecte

- **Offre gratuite :** une boîte.
- **Personal :** trois boîtes.
- **Pro :** toutes les boîtes que vous gérez, sans limite, avec un seul identifiant.
- **Team :** quand une deuxième personne a besoin de son propre identifiant.

Une entreprise avec info@, ventes@ et factures@ plus votre propre adresse, cela fait quatre boîtes, donc Pro. Les prix actuels figurent sur la [page des tarifs](/pricing), et [MCP Emails pour les entreprises](/for/business) montre comment une seule personne gère toutes les boîtes de l'entreprise depuis un seul agent.

## FAQ

**Claude peut-il utiliser plusieurs comptes e-mail à la fois ?**
Oui, via un serveur MCP. Connectez chaque boîte à MCP Emails, ajoutez un seul connecteur personnalisé à Claude, et Claude les voit toutes et nomme la boîte à chaque appel.

**ChatGPT peut-il utiliser plusieurs comptes e-mail ?**
Son propre plugin Gmail peut désormais accueillir plusieurs comptes Google. Pour les boîtes qui ne sont pas chez Google, comme une adresse d'entreprise chez IONOS, Zoho ou un hébergeur cPanel, ajoutez MCP Emails comme connecteur personnalisé, et toutes les boîtes connectées sont disponibles.

**Faut-il un connecteur distinct par boîte ?**
Non. Une seule URL de connecteur couvre toutes les boîtes de votre espace de travail MCP Emails, et la même URL fonctionne dans Claude, ChatGPT et les autres clients MCP.

**Une réponse partira-t-elle de la bonne adresse ?**
Oui. Chaque boîte envoie via son propre fournisseur ou serveur de messagerie, avec son propre nom affiché et sa propre signature. Envoyer depuis une adresse qui n'est pas celle de la boîte ne fonctionne que pour une adresse Gmail Send As vérifiée, sur une boîte connectée avec Google, et c'est refusé partout ailleurs.

**Le courrier de tous ces comptes est-il stocké ?**
Non. Le contenu des messages est récupéré en direct chez votre fournisseur à chaque requête, puis supprimé. Ce qui est conservé, c'est l'identifiant chiffré de chaque boîte. Voir [sécurité](/security).

## Étape suivante

[Commencez gratuitement](/signup) avec votre boîte la plus chargée, ajoutez le connecteur MCP Emails à Claude ou ChatGPT, et demandez ce qui attend une réponse aujourd'hui. Ajoutez les autres boîtes quand vous voudrez une seule réponse au lieu de plusieurs.`,
};

export default translation;
