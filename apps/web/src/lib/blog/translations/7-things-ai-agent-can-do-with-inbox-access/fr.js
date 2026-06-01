export default {
  title: 'Sept choses que votre agent IA peut faire dès qu’il a accès à votre boîte mail',
  description:
    'Sept actions concrètes pour un agent IA avec accès à la boîte mail : trier les non-lus, résumer un fil, rédiger des réponses, retrouver des pièces jointes et relancer.',
  coverAlt: 'Sept choses que votre agent IA peut faire avec un accès à la boîte mail via MCP — MCPEmails',
  content: `Dès que votre agent peut lire et envoyer de vrais e-mails, les démonstrations gadget s’arrêtent et le vrai travail commence. Voici sept choses que vous pouvez lui confier dès aujourd’hui : trier la pile des non-lus, résumer un long fil de discussion, rédiger des réponses dans votre style, retrouver cette pièce jointe précise, relancer les échanges en attente, router le courrier au bon endroit et vous livrer un récapitulatif hebdomadaire.

Chaque exemple ci-dessous correspond à de vrais outils MCP que vous pouvez appeler dès maintenant. Les outils sont les mêmes que vous connectiez Gmail, Outlook, iCloud, Fastmail ou une boîte IMAP générique. Si vous n’avez pas encore relié un agent à votre boîte mail, le [guide complet pour donner à votre agent IA un accès à l’e-mail](/blog/how-to-give-your-ai-agent-email-access) couvre la configuration ; le [tutoriel de connexion en 2 minutes](/blog/connect-email-to-ai-agent-under-2-minutes) est la voie rapide.

Une mise au point honnête d’entrée, car elle façonne la moitié de cette liste : **MCP Emails fonctionne par interrogation, pas par notification push.** Il n’y a ni webhooks, ni événements initiés par le serveur. L’agent n’est pas prévenu quand un message arrive. Il vérifie selon un calendrier. Cela ressemble à une limite, et pour quelques cas d’usage c’en est une, mais cela signifie aussi que rien ne se déclenche sans une horloge que vous contrôlez. Je signalerai les endroits où l’interrogation compte.

## La trousse à outils, d’un seul souffle

Tout ici repose sur six outils essentiels : \`list_inboxes\`, \`list_messages\`, \`read_email\`, \`search_emails\`, \`send_email\` et \`reply_to_email\`. Il y en a quelques autres pour marquer comme lu, gérer les drapeaux, les dossiers, l’envoi programmé et la recherche de contacts. Le premier appel que votre agent devrait toujours faire est \`list_inboxes\`, pour découvrir les comptes connectés et leurs valeurs \`inbox_id\`, afin de ne jamais coder en dur un UUID dans un prompt.

Les prompts ci-dessous sont écrits exactement comme je les taperais à Claude ou Cursor. L’agent détermine lui-même quel outil appeler.

### 1. Trier la pile des non-lus

La boîte mail du matin, c’est surtout du bruit avec trois choses importantes enfouies dedans. Confiez à l’agent le soin de faire le tri avant même que vous ayez fini votre café.

> Vérifie ma boîte de travail pour les messages non lus des dernières 24 heures. Regroupe-les en « réponse nécessaire aujourd’hui », « pour info » et « newsletters/automatisés ». Pour le premier groupe, donne-moi une ligne sur ce qu’ils veulent.

En coulisse, l’agent appelle \`list_messages\` avec \`unread_only: true\` sur la boîte renvoyée par \`list_inboxes\`, lit avec \`read_email\` les quelques messages qui semblent importants et ignore le reste. Il peut marquer comme lu le bruit évident pour qu’il cesse d’encombrer le compteur. Pour une version plus poussée de cela, le [guide de tri et de résumé](/blog/ai-agent-triage-summarize-inbox) procède outil par outil.

### 2. Résumer un long fil de discussion

On vous ajoute à un fil de 40 messages au message 38. Personne ne va tout relire. L’agent, lui, le fera.

> Lis le fil dont l’objet est « Q3 vendor migration » et dis-moi où ça a réellement abouti : ce qui a été décidé, qui est responsable de quoi et toute question ouverte à laquelle je dois répondre.

\`search_emails\` trouve le fil (il utilise la syntaxe de recherche native de votre fournisseur, donc les opérateurs Gmail, le KQL d’Outlook et la recherche textuelle IMAP fonctionnent tous), puis \`read_email\` récupère le texte brut analysé de chaque message. \`read_email\` peut aussi renvoyer du HTML assaini et des pièces jointes si vous le demandez, mais pour un résumé le texte brut est plus rapide et moins coûteux.

### 3. Rédiger des réponses dans votre style

C’est dans la rédaction que les agents font leurs preuves. Le modèle écrit la réponse ennuyeuse, vous la survolez et vous l’envoyez.

> Rédige une réponse au dernier message de Dana qui décline la réunion mais propose deux créneaux la semaine prochaine. Reprends mon ton habituel, court et direct.

L’agent utilise \`reply_to_email\`, qui définit pour vous les en-têtes de fil (In-Reply-To et References), de sorte que la réponse atterrisse dans la bonne conversation au lieu d’en démarrer une nouvelle. Les réponses prennent en charge le CC, le BCC, le HTML et les pièces jointes jusqu’à 10 MB au total. Ma règle : laissez l’agent rédiger librement, mais gardez un humain sur le bouton d’envoi pour tout ce qui sort de la maison. Considérez \`send_email\` et \`reply_to_email\` comme les étapes que vous relisez vraiment.

### 4. Retrouver cette pièce jointe précise

Vous savez que quelqu’un a envoyé le contrat signé en mars. Vous ne savez pas dans lequel des 200 fils il se trouve. La recherche bat le défilement.

> Trouve l’e-mail le plus récent avec une pièce jointe PDF venant de n’importe qui chez acme.com au sujet du renouvellement, et extrais la pièce jointe.

\`search_emails\` resserre la recherche avec une requête native du fournisseur, puis \`read_email\` avec \`include_attachments\` renvoie le fichier. Comme l’e-mail est récupéré en direct puis abandonné après l’appel, cette pièce jointe ne traîne pas dans un cache par la suite. L’[architecture sans stockage](/blog/why-email-never-stored-matters) est la raison pour laquelle il est sûr d’y pointer un agent.

### 5. Rappels de relance (celui-ci relève de l’interrogation)

« Le client a-t-il fini par répondre ? » est une question que vous oubliez de poser jusqu’à ce qu’il soit trop tard. Un agent peut garder le fil pour vous, mais c’est ici que la réalité « interrogation, pas push » se fait sentir.

> Chaque jour ouvré à 16h, vérifie si quelqu’un a répondu aux propositions que j’ai envoyées cette semaine. Liste celles encore en attente avec leur date d’envoi initiale.

Aucun événement ne réveille l’agent quand une réponse arrive. À la place, vous l’exécutez selon un calendrier — une tâche cron, la fonction de tâches programmées de votre client, ce qui vous convient — et chaque exécution fait le travail : \`search_emails\` pour les propositions envoyées, puis \`list_messages\` pour voir ce qui est revenu. Si vous voulez qu’un fil resté sans suite se rappelle de lui-même, l’agent peut même rédiger et mettre en file d’attente une relance. La [création d’un répondeur automatique](/blog/build-email-auto-responder-mcp-agent) détaille la boucle d’interrogation, y compris la façon de respecter la valeur \`retry_after\` quand vous atteignez une limite de débit, pour ne pas marteler le serveur.

### 6. Router ou transférer au bon endroit

Tous les e-mails ne sont pas pour vous. Certains relèvent d’une boîte partagée, d’une adresse de tickets ou d’un coéquipier.

> Transfère tout ce qui ressemble à une facture à accounting@, et marque les reçus que je devrais garder pour les impôts.

L’outil de transfert envoie via votre propre fournisseur, de sorte que le message conserve la réputation de votre domaine au lieu d’être relayé par un tiers. Les drapeaux et les dossiers permettent à l’agent de classer les choses sans les supprimer. C’est le genre de règle permanente qui s’associe naturellement à la passe de tri des non-lus du point n° 1 : une exécution, deux résultats.

### 7. Un récapitulatif hebdomadaire

Terminez la semaine avec un résumé écrit plutôt qu’avec un coup d’œil coupable à une boîte que vous n’avez jamais vidée.

> Vendredi à 17h : résume tout ce que j’ai reçu cette semaine et auquel je n’ai pas répondu, regroupé par expéditeur, avec l’unique action la plus importante parmi l’ensemble. Envoie-le-moi par e-mail.

Cela combine les autres : \`search_emails\` et \`list_messages\` pour rassembler la semaine, \`read_email\` pour ceux qui demandent du détail, puis \`send_email\` pour vous livrer le récapitulatif à vous-même. Comme la relance, c’est une exécution programmée, pas une réaction. C’est vous qui décidez de la cadence.

## Ce que ça coûte et où se situent les limites

Les sept fonctionnent sur le [plan Free](/pricing), qui est à 0 $ avec un nombre illimité de boîtes mail et d’appels d’outils. Les plans diffèrent sur le débit en pointe, pas sur ce que les outils peuvent faire. Free autorise 60 requêtes par minute, Solo (12 $/mois) passe à 300, et Team (49 $/mois) monte à 1 000 avec des rôles d’équipe et le SSO. Un récapitulatif hebdomadaire effleure à peine ces plafonds ; une boucle de tri agressive toutes les minutes sur de nombreuses boîtes, c’est là que vous sentiriez la limite de Free et voudriez Solo.

Quand vous atteignez bel et bien une limite, le serveur renvoie une erreur réessayable avec \`data.retry_after\` en secondes. Respectez-la. Et ne réessayez jamais aveuglément un appel \`send_email\`, car réessayer après un délai d’attente peut faire atterrir deux copies du même message dans la boîte de quelqu’un.

## Commencez par une seule

N’essayez pas de construire les sept dès le premier jour. Choisissez la passe de tri ou le récapitulatif hebdomadaire, rendez-la banale et fiable, puis ajoutez la suivante. [Connectez une boîte mail](/signup) et faites de \`list_inboxes\` le premier geste de votre agent. La [référence des outils dans la documentation](/docs) donne les paramètres exacts de chacun des appels ci-dessus.`,
};
