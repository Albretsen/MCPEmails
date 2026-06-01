export default {
  title: 'OAuth ou clés API pour l’accès e-mail de l’IA : que choisir ?',
  description: 'OAuth ou clés API pour l’accès e-mail de l’IA : OAuth pour claude.ai, Claude Desktop et Cursor ; une clé API restreinte pour Cline, JetBrains et les scripts.',
  coverAlt: 'OAuth versus clés API pour connecter les agents IA à l’e-mail — MCPEmails',
  content: `Lorsque vous connectez un agent IA à votre e-mail via MCP Emails, vous vous authentifiez de deux façons possibles : par OAuth ou par une clé API. En bref : OAuth si votre client le prend en charge (claude.ai, Claude Desktop, Cursor), et une clé API restreinte sinon (Cline, JetBrains, scripts, cURL). Les deux atteignent le même point de terminaison et exposent les mêmes outils. La différence tient à qui gère le secret et à la facilité avec laquelle vous pouvez tout couper.

Il ne s’agit pas d’un compromis entre sécurité et commodité où vous sacrifiez l’un pour l’autre. Les deux chemins sont limités exactement à \`read:email\`, \`send:email\`, ou les deux, et tous deux peuvent être révoqués depuis le tableau de bord en un clic. La vraie question est de savoir lequel convient au client que vous utilisez réellement. Pour une vue d’ensemble de la façon dont tout cela s’articule, commencez par le guide de référence, [comment donner à votre agent IA l’accès à l’e-mail](/blog/how-to-give-your-ai-agent-email-access).

## La recommandation en 30 secondes

Utilisez **OAuth** quand votre client MCP le prend en charge. Cela concerne aujourd’hui claude.ai, Claude Desktop et Cursor. Vous collez une URL, vous vous connectez, vous approuvez les scopes, et c’est terminé. Aucun secret à copier, aucun secret à stocker, aucun secret à divulguer.

Utilisez une **clé API** quand votre client n’a pas de flux OAuth. Cline, l’assistant IA de JetBrains, une tâche cron Python, un script shell qui fait transiter du JSON-RPC via cURL — tous ont besoin d’un jeton bearer. Vous en créez un dans le tableau de bord, vous le restreignez, vous le copiez une fois, et vous le passez dans l’en-tête \`Authorization\`.

Si les deux sont possibles pour un même client, choisissez OAuth. Moins de secrets dans vos fichiers de configuration reste toujours le meilleur choix par défaut.

## Comment OAuth fonctionne ici

OAuth est le chemin sans clé. Au lieu de générer vous-même un identifiant et de le coller quelque part, le client et le serveur le négocient directement, et le jeton vit à l’intérieur du client plutôt que dans un fichier de configuration que vous gérez.

Dans claude.ai, le flux est le suivant : **Customize → Connectors → Add connector → coller l’URL → Connect → se connecter et approuver.** L’URL est le point de terminaison MCP, \`https://mcpemails.com/api/mcp\`. Une fois que vous avez approuvé, l’agent a accès et vous n’avez jamais touché à un secret.

En coulisses, c’est un OAuth standard et à jour :

- **Authorization Code + PKCE** (RFC 7636), donc aucun secret client n’est jamais transmis. PKCE est le même mécanisme qui protège les connexions des applications mobiles et monopages.
- **Dynamic Client Registration** (RFC 7591), donc le client s’enregistre lui-même sans aucune configuration manuelle de votre côté.
- **Les jetons se renouvellent automatiquement** dans les clients pris en charge. Vous n’avez pas à surveiller une expiration.
- **Les scopes correspondent exactement à ce que vous approuvez** sur l’écran de consentement : \`read:email\`, \`send:email\`, ou les deux.

L’avantage concret : le jeton n’apparaît jamais sous la forme d’une chaîne de caractères que vous pourriez accidentellement commiter, journaliser ou coller dans la mauvaise conversation. Quand vous voulez couper l’accès, vous révoquez la connexion dans le tableau de bord et l’agent est verrouillé immédiatement. Et si cette révocation compte vraiment, c’est parce que la boîte de réception elle-même reste intacte : [l’e-mail n’est jamais stocké](/blog/why-email-never-stored-matters) chez nous, dès le départ.

## Comment les clés API fonctionnent ici

Certains clients ne parlent pas OAuth. Ce n’est pas un reproche. Cline, JetBrains et tout ce que vous écrivez vous-même attendent simplement un jeton bearer, qui est la manière plus ancienne — et parfaitement valable — d’authentifier une machine.

Vous en créez une dans **Dashboard → API Keys** :

1. Nommez la clé d’une façon qui vous parlera plus tard (\`cline-laptop\`, \`triage-cron\`).
2. Choisissez ses scopes : \`read:email\`, \`send:email\`, ou les deux.
3. Copiez-la. Elle est affichée **une seule fois** et jamais plus. Si vous la perdez, vous en créez une nouvelle.

La clé ressemble à \`mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456\`, et vous la passez à chaque requête :

\`\`\`
Authorization: Bearer mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456
\`\`\`

Un appel JSON-RPC brut pour lister vos boîtes de réception ressemble à ceci :

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "list_inboxes", "arguments": {} }
}
\`\`\`

Envoyez cela en POST vers \`https://mcpemails.com/api/mcp\` avec l’en-tête bearer et vous récupérez vos boîtes de réception connectées et leurs identifiants. À partir de là, l’agent appelle \`list_messages\`, \`read_email\`, \`search_emails\`, \`send_email\` et \`reply_to_email\` — les six outils principaux, plus quelques autres pour les drapeaux, les dossiers, la planification et les contacts.

La seule chose que les clés API exigent de vous et qu’OAuth ne demande pas : traitez la clé comme un mot de passe. C’est un secret à longue durée de vie, en clair. Placez-le dans une variable d’environnement, pas dans du code source que vous pousserez sur GitHub. Si une clé fuite, révoquez-la depuis le tableau de bord et passez à une nouvelle.

## Scopes : accordez le minimum, à chaque fois

Cette partie est identique pour les deux méthodes, et c’est le contrôle de sécurité qui fait le plus gros du travail. Une connexion qui peut seulement \`read:email\` ne peut rien envoyer, quoi que l’agent décide de faire. Si vous construisez un [workflow de résumé et de tri](/blog/ai-agent-triage-summarize-inbox), accordez l’accès en lecture seule. L’agent lit, classe et rapporte, et il n’existe aucun chemin par lequel un modèle confus ou manipulé pourrait envoyer un message.

N’ajoutez \`send:email\` que lorsque l’envoi est la tâche réelle, comme pour un [répondeur automatique construit sur les outils MCP](/blog/build-email-auto-responder-mcp-agent). Et même là, restreignez une clé ou une connexion distincte par tâche plutôt qu’un identifiant tout-puissant que vous réutilisez partout. Le moindre privilège n’est pas de la paranoïa. C’est l’assurance la moins chère que vous achèterez.

## Alors, lequel utiliser ?

### Utilisez OAuth si…

Votre client est claude.ai, Claude Desktop ou Cursor. Vous ne voulez aucun secret dans votre configuration. Vous voulez que le renouvellement des jetons soit géré pour vous. Vous voulez la révocation la plus propre possible. C’est l’option par défaut et c’est celle vers laquelle vous devriez vous tourner en premier.

### Utilisez une clé API si…

Votre client n’a pas de support OAuth — Cline, JetBrains, les exécuteurs d’outils façon OpenAI, ou votre propre code. Vous scriptez contre le point de terminaison avec cURL ou un petit programme. Vous avez besoin d’un identifiant stable qu’un processus sans interface peut utiliser sans qu’un humain ait à cliquer sur un écran de consentement. Une clé restreinte est exactement ce qu’il faut ici, et il existe un guide complet pour les [clients Cursor, Cline et VS Code](/blog/email-for-ai-agents-cursor-cline-vscode).

Une dernière chose vraie quel que soit votre choix : les limites de débit. Chaque clé API est plafonnée à 100 requêtes/minute, 1 000/heure et 10 000/jour, et chaque espace de travail dispose d’un plafond de pointe selon le plan (60/min sur [Free](/pricing), jusqu’à 1 000/min sur Team). Quand vous atteignez une limite, le serveur vous renvoie une valeur \`retry_after\` en secondes. Respectez-la, et ne réessayez jamais à l’aveugle un \`send_email\` — vous enverriez le message deux fois.

## Le bilan

OAuth et les clés API ne forment pas un classement de sécurité. Ce sont des correspondances avec votre client. OAuth est le meilleur choix par défaut parce qu’il garde les secrets entièrement hors de vos mains, mais une clé API restreinte et bien stockée est réellement sûre pour les clients et les scripts qui en ont besoin. Choisissez les scopes avec soin, stockez les clés dans des variables d’environnement, et révoquez tout ce que vous n’utilisez pas.

Prêt à en brancher un ? Connecter une boîte de réception et un client prend environ [deux minutes de bout en bout](/blog/connect-email-to-ai-agent-under-2-minutes), ou vous pouvez lire la [documentation](/docs) complète et [commencer gratuitement](/signup).`,
};
