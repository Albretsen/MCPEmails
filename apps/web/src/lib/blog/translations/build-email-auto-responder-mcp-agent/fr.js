const translation = {
  title: 'Créer un répondeur automatique d’e-mails avec un agent connecté en MCP',
  description: 'Créez un répondeur automatique d’e-mails avec un agent IA connecté en MCP : interroger les non lus, rédiger et répondre en toute sécurité avec scopes, limites de débit et garde-fous.',
  coverAlt: 'Créer un répondeur automatique d’e-mails avec un agent connecté en MCP — MCPEmails',
  content: `Un répondeur automatique d’e-mails bâti sur MCP Emails est une boucle, pas un webhook. Il n’y a aucun événement initié par le serveur : votre agent **interroge** (poll) les e-mails non lus selon une planification avec \`email_read\` (action \`list\`), lit chaque message avec \`email_read\` (action \`read\`), rédige une réponse et appelle \`email_compose\` (action \`reply\`). Cet article déroule toute la construction : la boucle d’interrogation, les scopes dont vous avez besoin, comment encaisser les limites de débit, et les garde-fous qui empêchent un agent d’inonder vos contacts de réponses hallucinées.

C’est l’extrémité avancée de l’histoire racontée dans [donnez à votre agent IA un accès à l’e-mail](/blog/how-to-give-your-ai-agent-email-access). Si vous voulez simplement du tri et des résumés matinaux sans rien envoyer, lisez d’abord [tri et résumé de boîte de réception par un agent IA](/blog/ai-agent-triage-summarize-inbox) — c’est l’endroit le plus sûr pour commencer. Revenez ici quand vous voudrez vraiment que l’agent appuie sur envoyer.

## La part d’honnêteté : il n’y a pas de webhook

La plupart des tutoriels de « répondeur automatique » supposent qu’un événement push se déclenche dès qu’un e-mail arrive. MCP Emails ne fonctionne pas ainsi, et aucun serveur MCP que je connaisse ne le fait. MCP est un protocole d’outils requête/réponse. Le serveur répond quand votre agent le sollicite ; il ne vous appelle jamais.

Un vrai répondeur automatique, c’est donc un planificateur plus une interrogation. Vous lancez un tick toutes les N secondes ou minutes, vous demandez les messages non lus, et vous traitez ce qui est nouveau. C’est tout. C’est moins élégant qu’un webhook, mais c’est prévisible, et cela veut dire que *vous* contrôlez la cadence et le rayon d’action.

Choisissez un intervalle d’interrogation qui équilibre votre tolérance à la latence et votre budget de débit. Toutes les 60 secondes convient pour des réponses de type support. Toutes les 5 minutes suffit largement pour la plupart des boîtes et effleure à peine vos limites. N’interrogez pas chaque seconde — vous brûleriez du quota pour rien, et la boîte change rarement aussi vite.

## Ce qu’il vous faut : une clé API avec le scope d’envoi

Un répondeur automatique tourne presque toujours comme un script ou une tâche cron, pas à l’intérieur d’un client de chat. Cela signifie [la voie de la clé API, pas OAuth](/blog/oauth-vs-api-keys-ai-email-access).

Dans le tableau de bord, allez dans **API Keys**, créez une clé, et accordez-lui les scopes dont vous avez réellement besoin :

- \`read:email\` — pour interroger, lister et lire les messages avec \`email_read\`.
- \`send:email\` — pour appeler \`email_compose\` (action \`reply\`).

La clé n’est affichée qu’une seule fois. Copiez-la. Elle ressemble à \`mcpe_live_...\` et vous la transmettez à chaque requête :

\`\`\`
Authorization: Bearer mcpe_live_YOUR_KEY
\`\`\`

Le point de terminaison MCP est une URL unique :

\`\`\`
https://www.mcpemails.com/api/mcp
\`\`\`

N’accordez **que** les scopes utilisés par la tâche. Si une future version de votre répondeur doit transférer ou marquer des e-mails, ajoutez ces capacités à ce moment-là. Une clé capable de lire et de répondre est une clé qui, en cas de fuite, ne peut que lire et répondre. (Pour le tableau complet sur la gestion et la rotation des clés, voir [la documentation](/docs).)

## La boucle

Voici la forme d’un répondeur fonctionnel. Je l’ai écrit en pseudo-code sur les outils MCP afin qu’il soit clair quels appels se produisent et dans quel ordre. Le câblage exact du client MCP dépend de votre stack, mais c’est la séquence qui compte.

\`\`\`python
# Tools used: inbox_list, email_read, email_compose

inbox = inbox_list()[0]              # discover, never hardcode the UUID

while True:
    unread = email_read(
        action="list",
        inbox_id=inbox["inbox_id"],
        unread_only=True,
        limit=20,
    )

    for summary in unread["messages"]:
        if not should_handle(summary):   # allowlist + filters, see below
            continue

        msg = email_read(
            action="read",
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
        )

        draft = generate_reply(msg)      # your LLM call

        if not passes_guardrails(draft, msg):
            queue_for_human(msg, draft)  # don't send; flag it
            continue

        send_with_backoff(
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
            body=draft,
        )

    sleep(60)
\`\`\`

Trois choses à remarquer. D’abord, l’agent appelle \`inbox_list\` pour découvrir l’\`inbox_id\` au lieu de coller un UUID dans le code — c’est le modèle « découverte d’abord », et il garde le script fonctionnel si vous reconnectez une boîte. Ensuite, \`unread_only: true\` est ce qui fait de ceci un répondeur aux *nouveaux e-mails* plutôt qu’une machine à re-répondre à tout le monde. Enfin, chaque message passe par les garde-fous avant tout envoi.

### Marquer les messages comme traités

Si vous voulez qu’un message cesse d’apparaître comme non lu une fois que vous y avez répondu, lisez-le avec \`mark_as_read\` activé, ou appelez explicitement \`mark_read\`. Soyez délibéré ici : si votre boucle répond mais ne marque jamais le message comme lu, le tick suivant répondra de nouveau. Le marquage « traité » est ce qui rend la boucle idempotente.

## Limites de débit, et pourquoi on ne réessaie jamais aveuglément un envoi

Chaque clé API est plafonnée à **100 requêtes par minute, 1 000 par heure et 10 000 par jour**, quel que soit le forfait. Votre espace de travail a aussi un plafond de pointe selon le palier : **60 req/min sur Gratuit, 120 sur Personal, 300 sur Pro, 1 000 sur Team** (voir [tarifs](/pricing)). Une boucle polie d’interrogation et de réponse reste largement en dessous, mais une boucle mal réglée peut le déclencher.

Lorsque vous atteignez une limite de débit, le serveur renvoie une erreur réessayable (code \`-32003\`) portant \`data.retry_after\` en secondes. Respectez-la. Patientez ce temps, puis continuez.

L’allocation mensuelle d’actions de votre formule est une autre limite, et elle n’est pas réessayable. Quand elle est épuisée, l’appel revient sous forme de résultat d’outil normal avec \`isError: true\` et un bloc \`_meta["com.mcpemails/usage_limit"]\` au lieu d’une erreur JSON-RPC, sans \`retry_after\`. Réessayer ne fait que consommer des cycles jusqu’à \`reset_at\` ou un changement de formule : arrêtez la boucle et remontez l’information.

Voici la règle qui compte le plus : **ne réessayez jamais automatiquement et à l’aveugle un envoi ou une réponse \`email_compose\`.** Un envoi n’est pas idempotent. Si un appel d’envoi expire ou renvoie un résultat ambigu, un réessai naïf peut livrer deux fois la même réponse. Réessayez les *lectures* librement ; traitez les *envois* comme uniques et ne les réessayez que sur une erreur explicitement réessayable, avec backoff et un plafond strict.

\`\`\`python
def send_with_backoff(**kwargs):
    delay = 2
    for attempt in range(3):
        try:
            return email_compose(action="reply", **kwargs)
        except RateLimited as e:
            sleep(e.retry_after or delay)
            delay *= 2
        except RetryableError:
            sleep(delay)
            delay *= 2
        # any other error: do NOT retry a send. log it, move on.
        else:
            break
    raise SendFailed(kwargs)
\`\`\`

Remarquez qu’il ne réessaie que sur les erreurs de limite de débit ou explicitement réessayables, qu’il plafonne à trois tentatives, et qu’il ne boucle jamais indéfiniment. Un envoi qui échoue trois fois est le problème d’un humain, pas celui de la boucle.

## Garde-fous : la différence entre un outil et un risque

Un répondeur automatique qui envoie sans supervision n’est qu’à un mauvais prompt d’envoyer à votre PDG une réponse fausse avec aplomb. Construisez les freins avant le moteur.

### Listez en allowlist qui reçoit des réponses automatiques

Ne répondez pas à tout le monde. Commencez par une allowlist étroite — un alias de support, un domaine d’expéditeur précis, des messages correspondant à un motif d’objet. Tout le reste est mis en file pour un humain ou ignoré. Une allowlist est le garde-fou au plus fort effet de levier que vous puissiez ajouter, car il borne l’échec à une population que vous avez choisie.

### Gardez un humain dans la boucle, au moins au début

La version la plus sûre de tout cela n’est pas un répondeur automatique du tout — c’est un *rédacteur* automatique. L’agent lit, rédige et prépare la réponse, mais une personne approuve l’envoi. MCP Emails prend en charge les brouillons, vous pouvez donc faire en sorte que la boucle appelle \`draft\` (action \`create\`) au lieu d’\`email_compose\`, puis envoyer vous-même les bons. Fonctionnez en mode brouillon pendant une semaine. Lisez ce qu’il aurait envoyé. Ensuite seulement, basculez en envoi automatique ceux auxquels vous faites confiance.

### Stoppez les boucles et les auto-réponses à soi-même

Deux modes d’échec classiques :

- **Le ping-pong d’auto-réponses.** Si vous répondez à un message d’absence automatique et qu’il répond à votre réponse, vous avez construit une boucle infinie avec le bot de quelqu’un d’autre. Filtrez les messages qui semblent automatisés (vérifiez les en-têtes \`Auto-Submitted\`, les expéditeurs \`no-reply\`, ou les objets connus de répondeurs automatiques) et ne répondez jamais à votre propre adresse.
- **Re-répondre au même fil.** Marquez les messages comme lus après traitement, et conservez un petit registre des identifiants de messages auxquels vous avez déjà répondu. L’idempotence n’est pas optionnelle quand un envoi est en jeu.

### Contraignez ce que le modèle peut dire

Donnez au modèle de rédaction des instructions serrées et un plafond de longueur. Pour des réponses de support, un gabarit à emplacements vaut mieux qu’une génération libre. Et exécutez une vérification peu coûteuse avant l’envoi : le brouillon contient-il une promesse de remboursement, un prix, un engagement juridique, ou un lien que vous n’attendiez pas ? Si oui, acheminez-le vers un humain. C’est la vérification \`passes_guardrails\` dans la boucle ci-dessus, et c’est là que vous concentrez l’essentiel de votre effort d’ingénierie.

## Une première version réaliste

Si je devais déployer ceci pour une vraie boîte de réception demain, je commencerais petit et ennuyeux :

1. Une clé API avec \`read:email\` et \`send:email\`, limitée à une seule boîte.
2. Interroger \`email_read(action: "list", unread_only: true)\` toutes les deux minutes.
3. Mettre exactement un alias de support en allowlist.
4. Mode brouillon uniquement — créer des brouillons, n’envoyer rien automatiquement.
5. Après une semaine de lecture des brouillons, activer l’envoi automatique pour les cas évidents et continuer à rédiger le reste.

C’est un système auquel vous pouvez réellement faire confiance, et il se généralise. La même boucle avec un prompt différent devient un bot de tri, un routeur de leads ou un notificateur. Pour le menu plus large de ce qu’un agent peut faire une fois branché, voir [7 choses qu’un agent IA peut faire avec un accès à la boîte de réception](/blog/7-things-ai-agent-can-do-with-inbox-access). Si vous hésitez encore à confier à un agent un accès d’envoi, [est-il sûr de donner à un agent IA un accès à l’e-mail](/blog/is-it-safe-to-give-ai-agent-email-access) mérite votre temps avant de déployer.

Prêt à le construire ? Créez une clé API à scope restreint et lisez la référence des outils dans [la documentation](/docs), ou [commencez gratuitement](/signup) : Gratuit connecte une boîte, Personal (5 $/mois) jusqu'à trois, et Pro toutes celles que vous possédez ; ajoutez d’abord les garde-fous avant d’automatiser.`,
};

export default translation;
