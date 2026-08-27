export default {
  title: 'Configurer l’e-mail pour les agents IA dans Cursor, Cline et VS Code',
  description: 'Donnez à votre agent de code l’accès à l’e-mail dans Cursor, Cline et VS Code. Cursor utilise OAuth ; Cline et les clients personnalisés utilisent une clé API limitée via MCP. Configuration complète.',
  coverAlt: 'Configuration de l’accès e-mail pour les agents de code IA dans Cursor, Cline et VS Code via MCP',
  content: `Voici la version courte. Pour donner à un agent de code dans votre éditeur l’accès à une véritable boîte de réception, pointez-le vers un seul endpoint MCP : \`https://www.mcpemails.com/api/mcp\`. Cursor parle OAuth, donc vous collez cette URL et vous vous connectez. Cline, la configuration MCP brute de VS Code et n’importe quel script personnalisé ne font pas la danse OAuth ; ils s’authentifient donc avec une clé API limitée envoyée dans un en-tête \`Authorization: Bearer\`. Même endpoint, mêmes outils, deux façons d’entrer.

Ce guide couvre les deux chemins, montre comment générer une clé API limitée précisément à \`read:email\` et \`send:email\`, et se termine par un workflow de dev que j’utilise vraiment : l’agent trie ma boîte de réception et envoie des réponses sans que je quitte l’éditeur. Si vous voulez d’abord la vue d’ensemble, le guide pilier sur [comment donner à votre agent IA l’accès à l’e-mail](/blog/how-to-give-your-ai-agent-email-access) est le bon point de départ.

## Avant de câbler le moindre client : connectez une boîte de réception

Le serveur MCP ne possède pas votre courrier. Il établit une connexion en direct avec le fournisseur que vous utilisez déjà, récupère les messages au moment de l’appel, puis les jette. Rien de votre e-mail n’est stocké. La première étape se passe donc dans le tableau de bord, pas dans votre éditeur.

Allez dans **Dashboard → Inboxes → Connect Inbox** et choisissez un fournisseur :

- **Gmail** ou **Outlook / Microsoft 365** → OAuth en un clic. Connectez-vous avec Google ou Microsoft et approuvez.
- **iCloud, Fastmail, Yahoo, Zoho, ou n’importe quel hôte IMAP générique** → un mot de passe spécifique à l’application. Générez-le dans les paramètres du fournisseur (pour iCloud, c’est appleid.apple.com) et collez-le.

Fastmail fonctionne uniquement avec un mot de passe d’application, pas avec OAuth, alors ne cherchez pas un écran de consentement à la Google de ce côté-là. Si vous êtes sur iCloud ou Fastmail, le [guide de configuration iCloud, Fastmail et IMAP](/blog/connect-icloud-fastmail-imap-to-claude) donne les détails par fournisseur. Pour Outlook, voyez [connecter Outlook et Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Une fois une boîte de réception connectée, votre agent l’atteint via des outils. Vous ne collez jamais d’UUID ni de mot de passe dans la configuration de votre éditeur.

## Cursor : collez l’URL, connectez-vous, terminé

Cursor prend en charge OAuth 2.0 pour les serveurs MCP, ce qui est le chemin sans douleur. Il n’y a ni clé API ni secret à gérer dans un fichier de configuration.

1. Ouvrez les paramètres de Cursor et trouvez la section des serveurs MCP.
2. Ajoutez un nouveau serveur avec l’URL \`https://www.mcpemails.com/api/mcp\`.
3. Cursor ouvre une fenêtre de navigateur. Connectez-vous à votre compte MCP Emails et approuvez les scopes que vous voulez donner à l’agent — \`read:email\`, \`send:email\`, ou les deux.
4. La connexion passe au vert et les outils d’e-mail apparaissent dans la liste d’outils de Cursor.

En coulisses, c’est OAuth 2.0 authorization code avec PKCE, et le jeton détenu par Cursor est limité exactement à ce que vous avez approuvé. Si vous n’avez accordé que \`read:email\`, l’agent ne peut littéralement pas envoyer. Quand vous avez terminé, révoquez la connexion depuis **Dashboard → API Keys** (les autorisations OAuth y vivent aussi) en un clic, et l’accès de Cursor meurt immédiatement.

Claude Desktop et claude.ai suivent le même flux « coller et approuver » si vous les utilisez aussi.

## Cline, VS Code brut et scripts personnalisés : utilisez une clé API

Cline, la configuration \`mcp\` nue de VS Code, JetBrains et tout ce que vous scriptez vous-même n’implémentent pas le handshake OAuth. Pour ceux-là, vous créez une clé API et l’envoyez comme jeton porteur. C’est aussi le bon choix pour les tâches CI et l’automatisation pilotée par cron, où aucun humain n’est là pour cliquer sur un écran d’approbation.

### Étape 1 : créer une clé API limitée

Dans **Dashboard → API Keys**, cliquez sur **Create key**. Donnez-lui un nom que vous reconnaîtrez plus tard (\`cline-laptop\`, \`triage-cron\`), puis choisissez ses scopes :

- \`read:email\` pour lister, rechercher et lire.
- \`send:email\` pour envoyer et répondre.

N’accordez que ce dont le client a besoin. Un assistant de tri en lecture seule n’a aucune raison de détenir \`send:email\`. La clé n’est affichée qu’une seule fois — copiez-la à l’instant où elle apparaît, car vous ne pourrez plus la revoir. Si vous la perdez, vous la faites tourner, vous ne la récupérez pas.

### Étape 2 : placez la clé dans la configuration de votre client

Pour Cline (et la plupart des configurations MCP de VS Code), ajoutez le serveur au JSON de configuration MCP avec l’en-tête porteur :

\`\`\`json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

Un appel cURL brut pour confirmer que la clé fonctionne avant de toucher au moindre éditeur :

\`\`\`bash
curl -s https://www.mcpemails.com/api/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

Si vous récupérez une liste d’outils, vous êtes connecté. Une erreur \`-32001\` signifie que la clé est mauvaise ou qu’il lui manque un scope — celle-là n’est pas réessayable, alors corrigez la clé plutôt que de boucler. Ne committez pas la clé. Lisez-la depuis une variable d’environnement et gardez-la hors de git. Si vous hésitez sur le modèle d’authentification à utiliser et où, [OAuth contre clés API pour l’accès e-mail des IA](/blog/oauth-vs-api-keys-ai-email-access) expose les compromis.

## Les outils dont dispose votre agent

Les deux chemins exposent la même surface. Une poignée d’outils consolidés, basés sur des actions, couvrent le travail :

- \`inbox_list\` — appelez toujours celui-ci en premier pour découvrir les boîtes de réception connectées et leurs ID.
- \`email_read\` (action \`list\`) — paginé, du plus récent au plus ancien.
- \`email_read\` (action \`read\`) — texte brut analysé, HTML assaini en option, pièces jointes.
- \`email_read\` (action \`search\`) — recherche native du fournisseur (opérateurs Gmail, KQL Outlook, texte IMAP).
- \`email_compose\` (action \`send\`) — composez avec CC/BCC, HTML, pièces jointes jusqu’à 10 MB.
- \`email_compose\` (action \`reply\`) — définit pour vous les en-têtes In-Reply-To et References pour que le fil reste intact.

Il y en a quelques autres pour les drapeaux et les déplacements (\`email_organize\`), les dossiers, l’envoi programmé et les contacts, mais ces quelques-uns font l’essentiel du vrai travail.

## Un workflow de dev qui gagne sa place

C’est ici que ça paie. Je garde une clé lecture+envoi câblée dans mon éditeur et je m’appuie sur l’agent pendant les moments de la journée que je perdrais autrement dans la boîte de réception.

Tri matinal, tapé directement dans le panneau de chat :

> Appelle inbox_list, puis liste les non lus de ma boîte pro des 12 dernières heures. Range-les : à répondre, pour info, et bruit. Pour le groupe « pour info », donne-moi une ligne chacun.

L’agent exécute \`inbox_list\`, puis \`email_read\` avec l’action \`list\` et \`unread_only\` activé, lit ceux qui comptent et me rend un récapitulatif trié. Quand j’en repère un auquel je veux répondre, j’enchaîne :

> Réponds au message du prestataire en design pour confirmer que jeudi 14h convient, fais court.

Il appelle \`email_compose\` avec l’action \`reply\`, le fil est géré, et la réponse part via mon propre Gmail — elle arrive donc depuis mon adresse avec la réputation de mon domaine, pas un relais quelconque. Pour un traitement plus poussé des prompts de tri, voyez [comment faire trier et résumer votre boîte de réception par un agent IA](/blog/ai-agent-triage-summarize-inbox).

Une limitation honnête : il n’y a pas de webhooks. Le serveur ne vous pousse pas de nouveau courrier. Si vous voulez que l’agent réagisse aux messages entrants, vous interrogez le serveur — \`email_read\` avec l’action \`list\` et \`unread_only: true\` selon un planning. C’est un choix de conception délibéré, et il façonne la manière dont vous construisez tout ce qui est réactif, comme un [répondeur automatique via MCP](/blog/build-email-auto-responder-mcp-agent).

## Limites de débit pour l’accès scripté

Si vous pilotez le serveur depuis une tâche cron ou une boucle d’agent serrée, faites attention aux limites. Chaque clé API est plafonnée à **100 requêtes par minute, 1 000 par heure et 10 000 par jour**, sur tous les forfaits. À cela s’ajoute un plafond de pic par espace de travail fixé par votre forfait : 60/min sur Gratuit, 120/min sur Personal (5 $/mois), 300/min sur Pro (29 $/mois), 1 000/min sur Team (79 $/mois). Voyez la [page des tarifs](/pricing) pour le détail complet.

Quand vous atteignez une limite de débit, le serveur renvoie une erreur réessayable (code \`-32003\`) avec \`data.retry_after\` en secondes. Respectez-la — patientez d’autant et réessayez. Tout n’est pas réessayable pour autant : si vous épuisez l’allocation mensuelle d’actions de votre formule, l’appel renvoie un résultat d’outil normal avec \`isError: true\` et un bloc \`_meta["com.mcpemails/usage_limit"]\`, sans \`retry_after\`, et aucun réessai ne débloque cela avant \`reset_at\`. Et ne réessayez jamais à l’aveugle un envoi de \`email_compose\` sur un échec générique ; vous enverriez des doublons. Vérifiez d’abord s’il est réellement parti.

## Pour conclure

Cursor vous connecte avec une URL et une connexion. Tout le reste demande une clé limitée et un en-tête porteur. Les deux frappent le même endpoint et les mêmes outils, et les deux gardent vos identifiants hors de votre dépôt et hors du contexte du modèle.

[Commencez gratuitement](/signup) et connectez votre première boîte de réception, ou lisez la [documentation](/docs) pour la référence complète des outils.`,
};
