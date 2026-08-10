export default {
  title: 'Comment donner à votre agent IA un accès à la messagerie (le guide complet 2026)',
  description:
    'Donnez à votre agent IA un accès en lecture et en envoi à une vraie boîte mail via MCP — Gmail, Outlook, iCloud, Fastmail ou IMAP. Fonctionnement, outils, sécurité et configuration.',
  coverAlt: 'Comment donner à votre agent IA un accès à la messagerie via MCP — MCPEmails',
  content: `Pour donner à un agent IA un accès à la messagerie, vous connectez votre boîte mail à un serveur MCP et vous pointez votre agent vers une seule URL de point de terminaison. L'agent dispose alors d'un petit ensemble d'outils pour lire, rechercher et envoyer des e-mails. Le plus difficile, ce n'est pas l'agent — c'est de faire tout cela sans laisser fuiter votre mot de passe dans un prompt, un journal ou une base vectorielle. C'est ce dernier kilomètre qui fait l'objet de ce guide.

Si vous voulez juste la voie rapide : connectez une boîte mail dans le tableau de bord, collez le point de terminaison MCP dans [claude.ai](https://claude.ai), Claude Desktop, Cursor ou votre propre agent, et appelez d'abord \`inbox_list\`. Le reste de cet article explique ce qui se passe réellement, pourquoi le modèle de sécurité est important et comment câbler chaque fournisseur pris en charge.

## Ce que signifie vraiment « l'e-mail via MCP »

Le [Model Context Protocol](https://modelcontextprotocol.io) est une manière standardisée d'exposer des outils à un modèle de langage via HTTP. Un serveur e-mail MCP présente votre boîte mail non pas comme de l'IMAP brut, mais comme une poignée de verbes typés que l'agent peut appeler : lister les messages, en lire un, rechercher, envoyer, répondre. L'agent raisonne sur ces verbes. Il ne touche jamais au protocole de messagerie sous-jacent, et il ne voit jamais vos identifiants.

C'est toute l'idée derrière [MCP Emails](/). Un point de terminaison, un ensemble d'outils, n'importe quel client compatible MCP. Si vous voulez l'explication de l'architecture depuis les fondations, l'article complémentaire [qu'est-ce qu'un serveur e-mail MCP](/blog/what-is-an-mcp-email-server) la décrit en termes simples.

## Pourquoi le dernier kilomètre est difficile

Brancher un modèle sur la messagerie semble trivial jusqu'à ce que vous l'essayiez pour de vrai. Trois choses posent problème :

1. **L'authentification diffère selon chaque fournisseur.** Gmail veut OAuth avec des scopes précis. Outlook veut l'identité Microsoft. iCloud et Fastmail veulent un mot de passe spécifique à l'application. Chacun a son propre cycle de rafraîchissement des jetons et ses propres modes de défaillance.
2. **Les identifiants sont radioactifs.** Un mot de passe de boîte mail qui traîne dans une transcription de discussion ou une ligne de journal est une fuite qui ne demande qu'à arriver. Vous ne pouvez pas laisser le modèle détenir le secret.
3. **L'e-mail est mal adapté aux agents.** MIME, en-têtes de fil de discussion, HTML contre texte brut, pièces jointes, dossiers qui sont en réalité des étiquettes. Le modèle a besoin d'une réponse propre, pas de RFC 5322.

La solution naïve du bricolage maison — donner au modèle une bibliothèque IMAP et votre mot de passe — échoue sur ces trois points à la fois. La plupart des dépôts « Gmail MCP server » sur GitHub s'arrêtent exactement là.

## Comment MCP Emails résout le problème

Quatre décisions de conception font le gros du travail. Ce sont elles qui font que je confie ma propre boîte mail à cet outil.

### L'e-mail est récupéré en direct et jamais stocké

Chaque appel d'outil contacte votre fournisseur en temps réel : l'API Gmail, Microsoft Graph ou IMAP/SMTP. Les corps de message, les objets et les pièces jointes sont remis à l'agent puis immédiatement écartés. Rien n'est mis en cache, indexé ou entreposé. La seule chose conservée par boîte mail est l'identifiant nécessaire pour effectuer l'appel suivant. Si vous voulez la version longue des raisons pour lesquelles cela compte, lisez [pourquoi « l'e-mail jamais stocké » est important](/blog/why-email-never-stored-matters).

### Les identifiants sont chiffrés au repos en AES-256-GCM

Le jeton OAuth ou le mot de passe d'application de chaque boîte mail est chiffré avant d'être écrit dans la base de données. Le déchiffrement n'a lieu qu'à l'intérieur d'une Edge Function isolée, au moment de l'appel, à l'aide d'une clé qui vit comme secret d'environnement séparé de la base de données. Ainsi, même une fuite de la base de données ne livre à un attaquant que du texte chiffré, pas votre boîte mail.

### L'envoi passe par votre propre fournisseur

Lorsque l'agent envoie ou répond, l'e-mail part via votre Gmail, votre Microsoft 365 ou votre serveur SMTP. MCP Emails ne relaie jamais depuis son propre domaine. Votre délivrabilité et la réputation de votre domaine restent entièrement les vôtres — pas de roulette du dossier spam liée à une IP partagée.

### C'est du MCP standard via HTTP

Le serveur parle Streamable HTTP conformément à la spécification MCP 2025-06-18. Aucun SDK à installer, aucun client personnalisé. Il s'intègre dans tout ce qui parle MCP.

## Les outils dont dispose votre agent

Une poignée d'outils consolidés, basés sur des actions, couvrent toute la surface : lire, composer, organiser, plus d'autres pour les dossiers, la planification et les contacts. L'agent commence toujours par \`inbox_list\` pour découvrir ce qui est connecté et récupérer l'ID de chaque boîte mail — il ne code jamais en dur un UUID.

- \`inbox_list\` — découvrir les comptes connectés et leurs capacités
- \`email_read\` (action \`list\`) — paginé, du plus récent au plus ancien, par boîte mail
- \`email_read\` (action \`read\`) — texte brut analysé, HTML assaini en option, pièces jointes en option
- \`email_read\` (action \`search\`) — syntaxe native du fournisseur (opérateurs Gmail, KQL Outlook, recherche texte IMAP)
- \`email_compose\` (action \`send\`) — composer avec CC/CCI, HTML et pièces jointes jusqu'à 10 MB au total
- \`email_compose\` (action \`reply\`) — pareil, et il définit pour vous les en-têtes de fil de discussion (In-Reply-To, References)
- \`email_organize\` — déplacer, supprimer, marquer ou archiver (une action par appel)

Une limitation honnête qui mérite d'être énoncée d'emblée : il s'agit de **scrutation, pas de notification poussée**. Il n'y a pas de webhooks. Pour réagir aux nouveaux e-mails, votre agent interroge selon un calendrier, par exemple \`email_read\` (action \`list\`) avec \`unread_only: true\`. Tout répondeur automatique que vous construisez fonctionne sur une minuterie, pas sur un déclencheur instantané. Le [guide de construction d'un répondeur automatique](/blog/build-email-auto-responder-mcp-agent) montre comment bien le faire.

Une exécution de tri matinal se lit ainsi :

\`\`\`json
{
  "step1": "inbox_list                  → finds your work Gmail",
  "step2": "email_read (action list)    → last 24h, unread_only",
  "step3": "email_read (action read)    → full body for anything urgent",
  "step4": "email_compose (action reply) → draft, or just summarize and wait"
}
\`\`\`

Aucun mot de passe n'a transité sur le réseau. L'agent détenait des capacités, pas des identifiants. Pour plus d'idées, consultez [7 choses qu'un agent IA peut faire avec un accès à la boîte mail](/blog/7-things-ai-agent-can-do-with-inbox-access) et le [parcours plus approfondi de tri et de synthèse](/blog/ai-agent-triage-summarize-inbox).

## Fournisseurs pris en charge et comment chacun se connecte

Vous connectez une boîte mail une seule fois dans **Dashboard → Inboxes → Connect Inbox**. La manière de vous authentifier dépend du fournisseur.

### Fournisseurs OAuth (en un clic)

- **Gmail** — OAuth 2.0 via la connexion Google.
- **Outlook / Microsoft 365** — OAuth 2.0 via la connexion Microsoft. Détails de configuration dans [connecter Outlook et Microsoft 365 à un agent IA](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

### Fournisseurs à mot de passe d'application

iCloud, Fastmail, Yahoo, Zoho, Yandex et toute boîte mail IMAP générique se connectent avec un mot de passe spécifique à l'application plutôt qu'avec OAuth. Vous générez le mot de passe dans les paramètres de sécurité de votre fournisseur et le collez dans MCP Emails. Les mots de passe iCloud proviennent d'appleid.apple.com ; Fastmail fonctionne **uniquement avec un mot de passe d'application** (créez-en un dans les paramètres de Fastmail). Ils empruntent tous le même transport IMAP/SMTP et partagent un ensemble de fonctionnalités identique. Le parcours complet se trouve dans [connecter iCloud, Fastmail ou n'importe quelle boîte IMAP à Claude](/blog/connect-icloud-fastmail-imap-to-claude).

## Connexion de votre client IA

Même point de terminaison, mêmes outils, deux façons d'entrer selon que votre client parle OAuth ou non.

### Clients compatibles OAuth (sans clé API)

claude.ai, Claude Desktop, Cursor et les clients similaires se connectent avec OAuth 2.0 Authorization Code + PKCE et l'enregistrement dynamique de client RFC 7591. Dans claude.ai, c'est **Customize → Connectors → Add connector**, collez l'URL du point de terminaison MCP, cliquez sur Connect, connectez-vous à votre compte MCP Emails et approuvez. Les jetons sont limités exactement à ce que vous approuvez : \`read:email\`, \`send:email\`, ou les deux.

### Clients sans OAuth (clé API)

Cline, JetBrains, les scripts personnalisés et le cURL brut utilisent une clé API à scopes définis. Créez-en une dans **Dashboard → API Keys**, choisissez ses scopes et copiez-la (elle n'est affichée qu'une fois). Transmettez-la sous la forme \`Authorization: Bearer <api-key>\`. La configuration complète pour ces clients se trouve dans [l'e-mail pour les agents IA dans Cursor, Cline et VS Code](/blog/email-for-ai-agents-cursor-cline-vscode), et le compromis entre les deux approches est traité dans [OAuth contre clés API pour l'accès des IA à la messagerie](/blog/oauth-vs-api-keys-ai-email-access).

Dans les deux cas, vous révoquez n'importe quelle connexion depuis le tableau de bord en un clic. Récupérez l'URL exacte du point de terminaison depuis [la documentation](/docs) — copiez-la de là plutôt que de la saisir à la main.

## Est-ce sûr ? Et les limites de débit

Réponse courte : oui, et l'article [est-il sûr de donner à un agent IA un accès à la messagerie](/blog/is-it-safe-to-give-ai-agent-email-access) expose l'argumentaire complet. Le modèle détient des capacités à scopes définis, pas votre mot de passe ; les identifiants sont chiffrés ; rien n'est stocké ; l'envoi reste sur votre fournisseur ; l'accès se révoque en un clic.

Côté limites de débit, chaque clé API est plafonnée à 100 requests/min, 1 000/hour et 10 000/day sur tous les forfaits. Il existe aussi un plafond de pointe par espace de travail qui évolue avec votre forfait — 60/min sur Free, 300/min sur Agent, 1 000/min sur Scale. Lorsque vous atteignez une limite, le serveur renvoie une erreur réessayable avec une valeur \`retry_after\` en secondes. Respectez-la. Et ne réessayez jamais aveuglément un envoi via \`email_compose\` — vous enverriez des doublons.

## Tarifs

Tous les forfaits incluent des boîtes mail et des clés API illimitées. Les appels facturables réussis utilisent une allocation d'actions : 2 500 sur Free, 50 000 sur Agent et 300 000 sur Scale par période de facturation ; les appels échoués et inbox_list sont gratuits.

- **Free — $0 forever.** Sans carte. 60 req/min, analyses sur 7 jours, support communautaire.
- **Agent — $12/month** (ou $120/year). 50 000 actions par période de facturation, 300 req/min, analyses sur 90 jours, support par e-mail.
- **Scale — $49/month** (ou $490/year). 300 000 actions par période de facturation, 1 000 req/min, rôles d'équipe et plusieurs espaces de travail, SSO avec SAML/OIDC plus journal d'audit, analyses sur 1 an, support prioritaire.

Détail complet sur la [page des tarifs](/pricing).

## Pour commencer

Connectez une boîte mail, collez le point de terminaison dans votre agent et appelez \`inbox_list\`. C'est tout l'onboarding. [Commencez gratuitement](/signup) ou parcourez le [guide de démarrage rapide](/docs#quickstart) — votre agent lira de vrais e-mails en quelques minutes.`,
};
