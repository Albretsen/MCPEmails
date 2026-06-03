export default {
  title: 'Comment faire trier et résumer votre boîte de réception par votre agent IA',
  description:
    'Un guide pratique pour le tri de la boîte de réception par un agent IA : des prompts prêts à copier-coller pour lister le courrier non lu, lire l’essentiel, résumer, prioriser et interroger à intervalle régulier.',
  coverAlt: 'Un agent IA trie et résume une boîte de réception via MCP — MCP Emails',
  content: `Le moyen le plus rapide d’amener un agent IA à trier votre boîte de réception est de vous appuyer sur deux outils dans l’ordre : \`inbox_list\` pour trouver votre boîte aux lettres, puis \`email_read\` — avec \`action: list\` et \`unread_only: true\` pour récupérer les nouveautés, puis \`action: read\` pour la poignée de messages qui semblent importants — puis une instruction en langage clair pour les résumer et les classer. Voilà toute la boucle. Si vous voulez qu’il rédige ou envoie des réponses, vous ajoutez \`email_compose\` avec \`action: reply\` à la fin.

Cet article vous donne les prompts exacts que j’utilise, ce à quoi ressemble une bonne sortie, et comment exécuter la même boucle de façon planifiée pour que votre tri matinal soit fait avant même que vous ne vous installiez. Il suppose que votre agent a déjà accès à votre messagerie via [MCP Emails](/blog/how-to-give-your-ai-agent-email-access). Si vous n’avez pas encore connecté de boîte, le [guide de connexion en moins de deux minutes](/blog/connect-email-to-ai-agent-under-2-minutes) vous y amène d’abord.

## La boucle de tri, en une image

Chaque session de tri suit les mêmes cinq étapes. Votre agent détermine l’ordre tout seul une fois que vous décrivez l’objectif, mais il est utile de savoir ce qui se passe sous le capot :

1. \`inbox_list\` — découvrir les boîtes connectées et leurs UUID \`inbox_id\`. L’agent ne code jamais un UUID en dur ; il en cherche un ici.
2. \`email_read\` avec \`action: list\` et \`unread_only: true\` — récupérer la file des non-lus d’une boîte, du plus récent au plus ancien.
3. \`email_read\` avec \`action: read\` — ouvrir le corps complet des quelques messages qui méritent une lecture détaillée.
4. Résumer et prioriser — du pur raisonnement, aucun appel d’outil. Le modèle regroupe, classe et explique.
5. \`email_compose\` avec \`action: reply\` (facultatif) — rédiger ou envoyer pour ceux qui appellent une réponse.

Les étapes 1 à 4 sont en lecture seule. Si vous vous êtes connecté avec [une autorisation OAuth ou une clé API](/blog/oauth-vs-api-keys-ai-email-access) limitée au périmètre \`read:email\`, l’agent est physiquement incapable d’envoyer quoi que ce soit, ce qui est exactement ce que vous voulez pour un résumé automatisé que vous parcourrez plus tard.

## Prompt 1 : le résumé du matin

Commencez simple. C’est celui que je lance la plupart des jours. Collez-le dans Claude (ou n’importe quel client MCP connecté à MCP Emails) et laissez-le travailler :

> Regarde ma boîte de réception principale. Récupère tout ce qui n’est pas lu, puis donne-moi un résumé réparti en trois catégories : à répondre aujourd’hui, pour info / peut attendre, et probablement du bruit. Pour chaque élément des deux premières catégories, donne-moi une ligne : de qui ça vient et ce qu’ils veulent. N’ouvre rien dont je n’ai pas besoin — survole d’abord les objets et les expéditeurs, ne lis le corps que quand l’objet est ambigu.

Remarquez ce que fait ce prompt. Il dit à l’agent de s’appuyer sur les métadonnées de \`email_read\` (action list) (expéditeur, objet, extrait) et de n’appeler \`email_read\` avec \`action: read\` que parcimonieusement. Cela garde la session rapide et reste bien en dessous des limites de débit — 100 requêtes par minute par clé API, et un plafond par espace de travail qui démarre à 60/min sur le plan Free. Une file de 40 messages non lus triée ainsi représente peut-être une douzaine d’appels d’outils, pas quarante.

Une bonne réponse ressemble à ceci :

\`\`\`text
NEEDS A REPLY TODAY (3)
- Dana (Acme): contract redline is back, wants sign-off before Fri
- Priya: blocked on the staging creds, asking you directly
- Stripe: a payment dispute opened, response due in 5 days

FYI / CAN WAIT (4)
- GitHub: 2 PRs merged into main overnight
- Notion: weekly digest
- Lena: shared the Q3 deck, no ask
- AWS: scheduled maintenance next Tuesday

PROBABLY NOISE (11): newsletters, 2 calendar invites already on your
calendar, LinkedIn, 6 marketing blasts.
\`\`\`

C’est réellement utile, d’une manière qu’une boîte brute ne l’est pas. L’agent a lu les trois messages dont l’objet ne rendait pas la demande évidente, et il a laissé les onze newsletters fermées.

## Prompt 2 : tri en profondeur avec priorités et raisonnement

Quand le nombre de non-lus est moche — un lundi après un long week-end — je veux plus que des catégories. Je veux que l’agent défende son classement pour que je puisse lui faire confiance :

> Ma boîte est un chantier. Trie tout ce qui n’est pas lu des 4 derniers jours. Classe les 8 premiers selon leur urgence réelle, pas selon le volume sonore de l’expéditeur. Pour chacun, indique-moi l’échéance s’il y en a une, qui est bloqué, et ton raisonnement en une phrase pour ce rang. Lis le corps complet de tout ce qui figure dans ton top 8 pour ne pas avoir à deviner.

La phrase « pas selon le volume sonore de l’expéditeur » a son importance. Sans elle, les agents accordent trop de poids aux objets en MAJUSCULES et aux « URGENT » des systèmes automatisés. Avec elle, vous obtenez du jugement :

\`\`\`text
1. Priya — blocked on staging creds since Thu. A teammate can't ship
   until you respond. No formal deadline but it's costing time now.
2. Stripe dispute — hard deadline in 5 days, money attached, but you
   have buffer so it's #2 not #1.
3. Dana (Acme) — contract sign-off by Fri. Important, not yet urgent.
...
\`\`\`

Pour ce prompt, l’agent appellera \`email_read\` avec \`action: read\` huit fois, une fois par élément du top, parce que vous lui avez demandé d’arrêter de deviner. C’est le bon compromis : quelques appels supplémentaires pour des classements sur lesquels vous pouvez agir. Si l’agent atteint effectivement une limite en cours d’exécution, MCP Emails renvoie une erreur réessayable avec une valeur \`retry_after\` en secondes — un client bien élevé attend ce délai et reprend plutôt que de marteler le serveur.

## Prompt 3 : un tri qui se termine par une réponse

Le tri prend plus de valeur quand il boucle les choses. Une fois que vous faites confiance aux résumés, laissez l’agent rédiger. Je garde un humain dans la boucle pour les envois, donc mon prompt demande des brouillons, pas le pilote automatique :

> Même tri que d’habitude. Pour tout ce qui est dans « à répondre aujourd’hui » et que je peux régler en deux phrases, rédige la réponse et montre-la-moi. N’envoie pas encore — je dirai « envoie 1 et 3 » ou je les modifierai. Reprends mon ton habituel : court, direct, sans remplissage corporate.

L’agent exécute la boucle en lecture seule, puis écrit les brouillons en ligne. Quand vous dites « envoie 1 et 3 », il appelle \`email_compose\` avec \`action: reply\` pour ces deux-là. Les réponses s’insèrent automatiquement dans le fil — MCP Emails définit pour vous les en-têtes \`In-Reply-To\` et \`References\`, de sorte que votre réponse atterrit dans la bonne conversation au lieu d’en démarrer une nouvelle. Le courrier part via votre propre fournisseur (l’API Gmail, Microsoft Graph ou votre SMTP), de sorte que la délivrabilité et la réputation de votre domaine restent les vôtres. Rien n’est relayé depuis un quelconque domaine d’envoi partagé.

Si vous voulez aller plus loin et vous retirer complètement de la boucle, c’est une autre forme d’automatisation — voyez [construire un répondeur automatique avec un agent MCP](/blog/build-email-auto-responder-mcp-agent) pour les garde-fous que je mettrais en place avant de laisser un agent envoyer sans surveillance.

## Exécuter le tri de façon planifiée

Voici la limite, en toute honnêteté : MCP fonctionne en **interrogation, pas en notification poussée.** MCP Emails n’a pas de webhooks et n’envoie aucun événement initié par le serveur. Votre agent n’est pas prévenu quand un courrier arrive. Pour faire du tri en continu, quelque chose doit appeler \`email_read\` avec \`action: list\` et \`unread_only: true\` sur une minuterie.

En pratique, cela signifie l’une de deux configurations :

- Une tâche planifiée — une entrée cron, une tâche planifiée dans votre plateforme d’agent, ou la planification propre à Claude si votre client la prend en charge — qui déclenche le prompt de résumé du matin à 8 h, puis de nouveau après le déjeuner. Deux fois par jour couvre la plupart des gens.
- Une boucle d’agent toujours active qui interroge toutes les quelques minutes pendant les heures de travail. C’est excessif pour une boîte personnelle et cela consomme du débit pour peu de gain. Réservez-le aux boîtes réellement sensibles au temps comme support@ ou alerts@.

J’utilise la version par tâche planifiée. Deux interrogations par jour, chacune un unique prompt de résumé du matin sur ma boîte principale. Cela coûte une poignée d’appels d’outils et dépose un récapitulatif net devant moi avant même que j’ouvre le client de messagerie. Pour la plupart des gens, ça l’emporte sur une boucle en temps réel sur tous les axes qui comptent.

Quelle que soit la cadence que vous choisissez, gardez l’interrogation honnête : interroger plus souvent ne veut pas dire plus vite, ça veut juste dire plus de requêtes contre le même plafond de 60 à 1 000 par minute. Adaptez l’intervalle à la vitesse réelle à laquelle la boîte bouge.

## Quelques détails qui rendent le tri nettement meilleur

- **Nommez la boîte.** Si vous avez connecté plus d’un compte, dites « ma boîte pro » ou « la boîte de support ». L’agent la retrouve à partir des titres de \`inbox_list\`, et vous lui évitez de trier la mauvaise boîte aux lettres.
- **Donnez-lui un barème, pas juste « résume ».** « Urgent = quelqu’un est bloqué ou il y a une échéance le jour même » produit des classements bien meilleurs que de laisser l’urgence indéfinie.
- **Plafonnez les lectures.** « N’ouvre le corps que quand l’objet est ambigu » ou « lis le top 8 » garde les sessions rapides et bon marché. Un « lis tout » sans limite est lent et rarement meilleur.
- **Restez en lecture seule jusqu’à ce que vous lui fassiez confiance.** Tournez avec un périmètre \`read:email\` pendant une semaine. N’ajoutez \`send:email\` qu’une fois que les brouillons sont systématiquement bons.

Si le tri est le premier workflow que vous essayez, c’est un bon point de départ — c’est en lecture seule, le bénéfice est immédiat, et il construit la confiance que vous voudrez avoir avant de céder l’accès en envoi. Pour plus d’idées une fois à l’aise, voici [sept choses qu’un agent IA peut faire avec un accès à la boîte de réception](/blog/7-things-ai-agent-can-do-with-inbox-access).

## Essayez sur votre propre boîte

Connectez une boîte, collez le Prompt 1, et regardez votre agent dégrossir un arriéré de 40 messages en moins d’une minute. C’est [gratuit pour commencer](/signup), sans carte requise, et vous pouvez révoquer l’accès depuis le tableau de bord en un clic. La [référence des outils dans la documentation](/docs) contient chaque paramètre si vous préférez câbler la boucle dans un script plutôt que dans une conversation.`,
};
