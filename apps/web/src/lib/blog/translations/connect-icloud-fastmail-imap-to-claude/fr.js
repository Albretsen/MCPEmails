export default {
  title: 'Comment connecter iCloud, Fastmail ou n’importe quelle boîte IMAP à Claude',
  description:
    'Connectez iCloud, Fastmail ou n’importe quelle boîte IMAP à Claude avec un mot de passe d’application. Configuration pas à pas, l’endpoint MCP et ce que l’IMAP permet là où Gmail bloque.',
  coverAlt: 'Connecter iCloud, Fastmail et n’importe quelle boîte IMAP à Claude via MCP',
  content: `Connecter iCloud, Fastmail ou n’importe quelle boîte IMAP à Claude demande une seule chose dont Gmail et Outlook se passent : un **mot de passe d’application**. Vous le générez dans votre fournisseur de messagerie, vous le collez une fois dans MCP Emails, et Claude peut lire, rechercher et envoyer via cette boîte. Pas de chorégraphie OAuth, aucun réglage de serveur SMTP à mémoriser.

C’est la voie à suivre pour tout fournisseur qui n’est ni Gmail ni Microsoft. iCloud, Fastmail, Yahoo, Zoho, Yandex et tout hôte IMAP générique passent par le même transport IMAP/SMTP, ils partagent donc un jeu de fonctionnalités identique. Si vous arrivez à obtenir un mot de passe d’application auprès du fournisseur, vous pouvez le connecter. Un bel avantage par rapport aux fournisseurs OAuth : l’IMAP offre à Claude une vraie suppression définitive.

## Pourquoi ces fournisseurs utilisent un mot de passe d’application, et non OAuth

Gmail et Outlook exposent des API OAuth modernes, MCP Emails les connecte donc en une seule étape de connexion. iCloud et Fastmail n’offrent pas cette voie aux outils de messagerie tiers. À la place, ils vous remettent un **mot de passe d’application** — un long mot de passe généré aléatoirement, limité à une seule application, distinct du mot de passe réel de votre compte et révocable indépendamment.

Une mise au point qui s’impose, parce que d’anciens articles se trompent : **Fastmail fonctionne uniquement avec un mot de passe d’application.** Fastmail a déjà pris en charge un flux OAuth pour certaines intégrations, mais pour se connecter à MCP Emails aujourd’hui, vous générez un mot de passe d’application dans les réglages de Fastmail. Comme pour iCloud. Si un guide vous dit de « vous connecter avec Fastmail » via OAuth, il est dépassé.

Le mot de passe d’application devient l’unique identifiant que MCP Emails conserve pour cette boîte, [chiffré avec AES-256-GCM au repos](/blog/why-email-never-stored-matters) et déchiffré uniquement à l’intérieur d’une Edge Function isolée au moment de l’appel. Vos e-mails réels ne sont jamais stockés — chaque appel d’outil les récupère en direct auprès du fournisseur, puis les supprime.

## Générer un mot de passe d’application pour iCloud

1. Rendez-vous sur [appleid.apple.com](https://appleid.apple.com) et connectez-vous avec votre Apple Account.
2. Dans la section **Sign-In and Security**, ouvrez **App-Specific Passwords**.
3. Cliquez sur le **+** (Generate an app-specific password), donnez-lui un libellé comme \`MCP Emails\`, puis confirmez avec le mot de passe de votre Apple Account.
4. Apple vous affiche un mot de passe au format \`abcd-efgh-ijkl-mnop\`. Copiez-le maintenant. Vous ne pourrez pas le revoir plus tard.

Vous aurez besoin de l’authentification à deux facteurs activée sur votre Apple Account — les mots de passe d’application ne sont pas disponibles sans elle. L’hôte IMAP d’iCloud est \`imap.mail.me.com\` et le SMTP est \`smtp.mail.me.com\`, mais MCP Emails les remplit pour vous lorsque vous choisissez iCloud comme fournisseur, vous n’aurez donc généralement pas à y toucher.

## Générer un mot de passe d’application pour Fastmail

1. Connectez-vous à Fastmail et ouvrez **Settings → Privacy & Security → Connected apps & API tokens** (les comptes plus anciens le nomment **App Passwords**).
2. Cliquez sur **New app password**.
3. Nommez-le (\`MCP Emails\` fait l’affaire) et, pour l’accès, choisissez **Mail (IMAP/SMTP)** afin qu’il puisse à la fois lire et envoyer.
4. Fastmail génère le mot de passe une seule fois. Copiez-le avant de fermer la boîte de dialogue.

L’hôte IMAP de Fastmail est \`imap.fastmail.com\` et le SMTP est \`smtp.fastmail.com\`. Là encore, choisir Fastmail dans MCP Emails les renseigne automatiquement.

## Connecter une boîte IMAP générique (tout le reste)

Pour Yahoo, Zoho, Yandex, un serveur de messagerie auto-hébergé ou toute autre solution dotée d’un endpoint IMAP, les étapes ont la même forme : obtenez un mot de passe d’application auprès du fournisseur (la plupart de ceux qui gèrent la 2FA en exigent un), puis fournissez quatre choses à MCP Emails :

- **L’hôte et le port IMAP** (souvent \`993\` pour TLS)
- **L’hôte et le port SMTP** (souvent \`465\` ou \`587\`)
- Votre **adresse e-mail** comme nom d’utilisateur
- Le **mot de passe d’application** comme mot de passe

Si vous n’avez vraiment qu’un mot de passe classique et que le fournisseur ne propose pas de mots de passe d’application, cela fonctionnera aussi — mais le mot de passe d’application reste le bon choix. Il limite la zone d’impact. Révoquez-le et seule cette connexion s’arrête, pas tout votre compte.

## Connecter la boîte dans MCP Emails

Une fois le mot de passe copié :

1. Ouvrez le dashboard et allez dans **Inboxes → Connect Inbox**.
2. Choisissez votre fournisseur — **iCloud**, **Fastmail** ou **Generic IMAP**.
3. Collez votre adresse e-mail et le mot de passe d’application. Pour l’IMAP générique, confirmez aussi l’hôte et le port.
4. Enregistrez. La boîte est opérationnelle en moins d’une minute.

C’est tout. Si vous voulez la version la plus rapide possible, quel que soit le fournisseur, le [guide de connexion en moins de deux minutes](/blog/connect-email-to-ai-agent-under-2-minutes) couvre le tout de bout en bout.

## Pointer Claude vers votre boîte

Connecter la boîte et connecter Claude sont deux étapes distinctes. La boîte vit dans MCP Emails ; vous donnez maintenant à Claude l’endpoint [MCP](https://modelcontextprotocol.io) pour qu’il puisse appeler les outils.

Dans claude.ai :

1. Allez dans **Customize → Connectors**.
2. Cliquez sur **Add connector** et collez l’endpoint : \`https://www.mcpemails.com/api/mcp\`
3. Cliquez sur **Connect**, connectez-vous avec votre compte MCP Emails et approuvez les scopes souhaités — \`read:email\`, \`send:email\` ou les deux.

Aucune clé API, aucun fichier de configuration. claude.ai utilise OAuth avec PKCE en coulisses, et le jeton que reçoit Claude est limité exactement à ce que vous avez approuvé. Si vous êtes sur un client qui ne gère pas OAuth — Cursor, Cline, un script cURL — vous créez plutôt une clé limitée, ce que je détaille dans [l’accès e-mail pour Cursor, Cline et VS Code](/blog/email-for-ai-agents-cursor-cline-vscode).

Une fois connecté, demandez d’abord à Claude d’exécuter \`inbox_list\`. Cela renvoie votre boîte et son \`inbox_id\`, vous n’avez donc jamais à copier-coller un UUID. À partir de là, place aux [outils principaux](/docs) — \`email_read\` (lister, lire et rechercher des messages), \`email_compose\` (envoyer, répondre, transférer) et \`email_organize\` — plus quelques autres pour les dossiers, les brouillons, la planification et les contacts. Chacun s’utilise via un paramètre \`action\`.

Un prompt pour confirmer que tout fonctionne :

\`\`\`
Use inbox_list to find my iCloud inbox, then summarize my 5 most recent unread messages.
\`\`\`

## La seule chose que l’IMAP fait et que Gmail et Outlook ne peuvent pas

Voici le point que les gens oublient. Quand Claude « supprime » un message sur Gmail ou Outlook, il part à la corbeille. C’est une limite stricte des API Gmail et Microsoft Graph — elles n’exposent pas de suppression définitive aux applications tierces. Le message reste dans la corbeille jusqu’à l’expiration de la fenêtre de rétention du fournisseur.

L’IMAP, c’est différent. Fastmail, iCloud, Yahoo, Zoho, Yandex et l’IMAP générique prennent tous en charge le **hard expunge** — Claude peut supprimer définitivement un message, et pas seulement le mettre à la corbeille. Si vous voulez un agent qui fait vraiment le ménage derrière lui, l’IMAP est le seul transport qui le permet. Pratique, et aussi une raison d’être réfléchi quant aux scopes que vous accordez. L’expunge est irréversible.

La recherche se comporte elle aussi un peu différemment. Gmail dispose de toute sa syntaxe d’opérateurs, Outlook utilise KQL et les fournisseurs IMAP utilisent la recherche textuelle IMAP — capable, mais pas aussi expressive que les opérateurs de Gmail. Bon à savoir si vous écrivez des prompts orientés recherche.

## Ce que vous pouvez construire une fois la connexion établie

Le fonctionnement est le même quel que soit le fournisseur, donc tout workflow que vous avez vu pour Gmail marche sur votre boîte Fastmail ou iCloud. En voici quelques-uns qui en valent la peine :

- Un tri matinal qui signale ce qui requiert un humain et rédige des réponses au reste. Voir [tri et synthèse de la boîte de réception](/blog/ai-agent-triage-summarize-inbox).
- Un répondeur automatique quasi en temps réel. Une réserve honnête : MCP Emails fonctionne par interrogation périodique (poll), pas par push — il n’y a pas de webhooks, l’agent vérifie donc l’arrivée de nouveaux messages selon une planification. Le [montage d’un répondeur automatique](/blog/build-email-auto-responder-mcp-agent) explique comment bien s’y prendre.

Si vous hésitez encore à brancher l’e-mail sur un agent tout court, commencez par l’article pilier : [comment donner à votre agent IA l’accès à l’e-mail](/blog/how-to-give-your-ai-agent-email-access).

## Pour conclure

iCloud, Fastmail et l’IMAP ne sont pas des citoyens de seconde zone ici. Générez un mot de passe d’application, collez-le dans **Inboxes → Connect Inbox**, pointez Claude vers l’[endpoint](/docs) et vous obtenez un agent avec un accès complet en lecture/envoi, plus une suppression définitive que les fournisseurs OAuth ne peuvent pas offrir. C’est [gratuit pour démarrer](/signup), sans carte, avec un nombre illimité de boîtes.`,
};
