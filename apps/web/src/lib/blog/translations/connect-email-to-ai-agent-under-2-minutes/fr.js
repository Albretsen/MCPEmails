export default {
  title: 'Comment connecter votre e-mail à un agent IA en moins de 2 minutes (Gmail, Outlook, iCloud, Fastmail et IMAP)',
  description: 'Connectez votre e-mail à un agent IA en moins de 2 minutes. Configuration pas à pas pour Gmail, Outlook, iCloud, Fastmail et n’importe quelle boîte IMAP via MCP — aucun e-mail n’est jamais stocké.',
  coverAlt: 'Connectez votre e-mail à un agent IA en moins de 2 minutes — Gmail, Outlook, iCloud, Fastmail et IMAP via MCP',
  content: `Vous connectez votre e-mail à un agent IA en deux gestes : connectez la boîte de réception dans le tableau de bord MCP Emails, puis pointez votre agent vers une seule URL d’endpoint. Avec un client compatible OAuth comme claude.ai, c’est tout. Pas de code, pas de SDK, et votre e-mail n’est stocké nulle part — chaque lecture et chaque envoi interroge votre fournisseur en direct, puis est aussitôt jeté dès que l’agent l’a reçu.

C’est le guide rapide. Choisissez votre fournisseur ci-dessous, suivez les quatre ou cinq étapes, et vous aurez Claude (ou Cursor, ou un script maison) en train de lire et d’envoyer de vrais e-mails à peu près le temps qu’il faut pour relire ce paragraphe deux fois. Pour la version plus approfondie « qu’est-ce que c’est et est-ce sûr », commencez par le [guide complet pour donner à votre agent IA un accès à l’e-mail](/blog/how-to-give-your-ai-agent-email-access).

## L’étape commune à tous les fournisseurs : connectez votre client

Avant de toucher au moindre fournisseur, décidez comment votre agent IA va dialoguer avec MCP Emails. Il y a deux chemins, et tous deux utilisent le même endpoint et les mêmes outils.

**Chemin A — client OAuth (claude.ai, Claude Desktop, Cursor).** Pas de clé d’API. Vous collez une URL et approuvez une connexion :

1. Dans claude.ai, allez dans **Customize → Connectors → Add connector**.
2. Collez l’endpoint : \`https://www.mcpemails.com/api/mcp\`
3. Cliquez sur **Connect**, connectez-vous à votre compte MCP Emails et approuvez les portées souhaitées (\`read:email\`, \`send:email\`, ou les deux).

C’est tout pour le côté client. Les jetons sont limités exactement à ce que vous avez approuvé, et vous pouvez révoquer la connexion depuis le tableau de bord en un clic. Si vous voulez voir les compromis détaillés, lisez [OAuth ou clés d’API pour l’accès à l’e-mail par l’IA](/blog/oauth-vs-api-keys-ai-email-access).

**Chemin B — client à clé d’API (Cline, JetBrains, cURL, agents maison).** Pour tout ce qui n’a pas d’OAuth intégré :

1. Allez dans **Dashboard → API Keys** et créez une clé.
2. Choisissez ses portées (\`read:email\`, \`send:email\`).
3. Copiez-la une seule fois (elle n’est affichée qu’une fois) et passez-la dans un en-tête : \`Authorization: Bearer <your-api-key>\`, là encore vers \`https://www.mcpemails.com/api/mcp\`.

Si vous vivez dans un éditeur, la [configuration de l’e-mail pour Cursor, Cline et VS Code](/blog/email-for-ai-agents-cursor-cline-vscode) couvre ce chemin de bout en bout.

Passons à la boîte de réception. Chaque fournisseur ci-dessous démarre de la même façon : **Dashboard → Inboxes → Connect Inbox**, puis choisissez votre fournisseur.

## Connectez chaque fournisseur

### Gmail (OAuth)

Le plus rapide du lot, parce que c’est Google qui fait le travail.

1. **Dashboard → Inboxes → Connect Inbox → Gmail.**
2. Vous êtes redirigé vers la connexion Google. Choisissez le compte.
3. Approuvez l’accès en lecture et en envoi sur l’écran de consentement.
4. Vous revenez dans le tableau de bord avec la boîte de réception connectée. Terminé.

Aucun mot de passe ne change jamais de mains. MCP Emails conserve un jeton OAuth chiffré et appelle directement l’API Gmail. Les recherches utilisent les opérateurs natifs de Gmail (\`from:\`, \`is:unread\`, \`after:\`), donc votre agent peut être précis.

### Outlook / Microsoft 365 (OAuth)

Même schéma que Gmail, fournisseur d’identité différent.

1. **Dashboard → Inboxes → Connect Inbox → Outlook / Microsoft 365.**
2. Connectez-vous avec votre compte Microsoft sur la page de Microsoft.
3. Approuvez les autorisations.
4. La boîte de réception apparaît connectée. L’envoi passe par Microsoft Graph, c’est donc un message normal depuis votre propre compte.

Si votre locataire applique des règles d’accès conditionnel ou de consentement administrateur, le [guide de configuration d’Outlook et Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) détaille les pièges du côté administrateur.

### iCloud (mot de passe d’application)

iCloud ne propose pas d’OAuth aux tiers, vous générez donc un mot de passe d’application. Cela prend une minute de plus.

1. Allez sur [appleid.apple.com](https://appleid.apple.com), connectez-vous et ouvrez la section **Sign-In and Security**.
2. Sous **App-Specific Passwords**, créez-en un nouveau et nommez-le « MCP Emails ».
3. Copiez le mot de passe généré (il ressemble à \`xxxx-xxxx-xxxx-xxxx\`).
4. Dans **Dashboard → Inboxes → Connect Inbox → iCloud**, saisissez votre adresse iCloud et collez ce mot de passe d’application.

iCloud fonctionne sur IMAP/SMTP en coulisses, vous disposez donc du même jeu d’outils que tout le monde.

### Fastmail (mot de passe d’application — pas OAuth)

Une rapide mise au point si vous avez lu d’anciennes docs : **Fastmail se connecte avec un mot de passe d’application, pas avec OAuth.** Ne cherchez pas de bouton « Se connecter avec Fastmail » : il n’y en a pas ici.

1. Dans Fastmail, ouvrez **Settings → Privacy & Security → Integrations** (ou **App Passwords**).
2. Créez un nouveau mot de passe d’application. Donnez-lui l’accès au courrier (IMAP/SMTP) et nommez-le « MCP Emails ».
3. Copiez le mot de passe que Fastmail génère.
4. Dans **Dashboard → Inboxes → Connect Inbox → Fastmail**, saisissez votre adresse Fastmail et collez-le.

C’est tout — du côté de l’agent, Fastmail se comporte exactement comme les autres fournisseurs IMAP.

### IMAP générique (Yahoo, Zoho, Yandex et les autres)

Tout ce qui parle IMAP/SMTP fonctionne via un seul connecteur. Le principe est identique à iCloud et Fastmail : créez un mot de passe d’application chez votre fournisseur, puis collez-le.

1. Dans les paramètres de sécurité de votre fournisseur, créez un **mot de passe d’application** (Yahoo, Zoho et Yandex le cachent tous dans la sécurité du compte). Utilisez un vrai mot de passe d’application, pas votre mot de passe de connexion — la plupart des fournisseurs bloquent de toute façon désormais l’IMAP avec mot de passe simple.
2. **Dashboard → Inboxes → Connect Inbox → IMAP.**
3. Saisissez votre adresse e-mail et le mot de passe d’application. MCP Emails détecte automatiquement les serveurs courants ; si le vôtre est inhabituel, indiquez l’hôte et le port IMAP et SMTP que votre fournisseur précise.
4. Enregistrez. La boîte de réception se connecte et est prête.

Pour les particularités de chaque fournisseur sur iCloud, Fastmail et la longue traîne des hôtes IMAP, l’[analyse approfondie d’iCloud, Fastmail et IMAP](/blog/connect-icloud-fastmail-imap-to-claude) est la référence de dépannage.

## Premier appel : découvrir, puis agir

Quel que soit le fournisseur choisi, le premier geste de l’agent est toujours le même. Faites-lui appeler \`inbox_list\` pour découvrir ce qui est connecté et récupérer l’\`inbox_id\` de chaque boîte — l’agent ne copie-colle jamais un UUID. À partir de là, il s’appuie sur un petit ensemble d’outils consolidés : \`email_read\` (avec un \`action\` de \`list\`, \`read\` ou \`search\`), \`email_compose\` (\`send\`, \`reply\` ou \`forward\`) et \`email_organize\` pour déplacer, marquer et archiver, plus \`folder\`, \`draft\`, \`schedule\` et \`contact_search\` :

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose",
    "email_organize"
  ]
}
\`\`\`

Un bon test rapide : demandez à votre agent « résume mes trois e-mails non lus les plus récents ». Il exécutera \`inbox_list\`, puis \`email_read\` avec \`action: "list"\` et \`unread_only: true\`, puis \`email_read\` avec \`action: "read"\` sur chacun. Si cela fonctionne, votre connexion est active.

Une réserve honnête à poser d’emblée : MCP Emails fonctionne par sondage. Il n’y a pas de webhooks ni d’événements push, un agent réagit donc au nouveau courrier en le vérifiant selon une planification plutôt qu’en recevant une notification. C’est le bon modèle pour la plupart des flux de travail, et c’est ainsi que fonctionnent les modèles de [tri et résumé de la boîte de réception](/blog/ai-agent-triage-summarize-inbox).

## Pourquoi c’est sûr de le faire rapidement

Ici, la rapidité ne vient pas de raccourcis sur la sécurité. L’e-mail est récupéré en direct à chaque appel et n’est jamais stocké — les corps, les objets et les pièces jointes sont remis à l’agent puis abandonnés immédiatement. La seule chose conservée par boîte de réception est votre jeton OAuth ou votre mot de passe d’application, chiffré en AES-256-GCM et déchiffré uniquement à l’intérieur d’une fonction isolée au moment de l’appel. L’envoi passe toujours par votre propre fournisseur, donc la réputation de votre domaine reste la vôtre. Si vous voulez l’architecture en détail, lisez [pourquoi « l’e-mail n’est jamais stocké » compte vraiment](/blog/why-email-never-stored-matters).

## Pour conclure

C’est tout : une connexion de boîte de réception, un endpoint, une poignée d’outils. Tous les forfaits sont illimités en boîtes de réception, en appels et en clés, et le forfait Free ne coûte rien et ne demande pas de carte — consultez les [tarifs](/pricing) si vous avez besoin de limites de pointe plus élevées ou du SSO. Prêt à l’essayer ? [Commencez gratuitement](/signup), connectez votre boîte de réception et collez l’endpoint dans votre agent.`,
};
