const translation = {
  title: "Pourquoi le « courriel jamais stocké » compte quand vous connectez l’IA à votre boîte mail",
  description:
    'Jamais stocké : MCP Emails récupère vos messages en direct puis les jette, ne gardant qu’un jeton chiffré. Voyez pourquoi c’est mieux qu’un outil qui copie toute votre boîte.',
  coverAlt: 'Un courriel récupéré en direct puis jeté, face à une seconde copie stockée dans la base de données d’un fournisseur',
  content: `Quand vous connectez un agent IA à votre boîte mail, la question la plus importante de toutes est de savoir où finissent vos courriels. Avec MCP Emails, la réponse est : nulle part. Chaque appel d’outil récupère vos messages en direct depuis Gmail, Microsoft Graph ou votre serveur IMAP, les transmet à l’agent, puis les jette. La seule chose que nous conservons, c’est un jeton chiffré pour que l’appel suivant puisse avoir lieu.

Cela ressemble à un petit détail d’implémentation. Ça n’en est pas un. C’est la différence entre confier à un agent *une clé de votre maison* et lui confier *une photocopie de tout ce qu’elle contient*, gardée à jamais dans le classeur de quelqu’un d’autre. Beaucoup d’outils « IA pour courriel » font discrètement la seconde chose. Cet article explique pourquoi ça compte et en quoi l’architecture diffère vraiment.

## Deux manières de donner vos courriels à un agent

Il n’existe en réalité que deux approches de conception, et la plupart des produits relèvent nettement de l’une d’elles.

**Tout copier (synchroniser-et-stocker).** L’outil se connecte une fois à votre boîte, puis aspire vos messages dans sa propre base de données — souvent en continu. Votre boîte est répliquée dans leur infrastructure pour être indexée, intégrée dans un magasin de vecteurs, fournie à un modèle ou renvoyée rapidement. L’agent lit depuis *leur* copie, pas depuis votre fournisseur.

**Récupération en direct (jamais stocké).** L’outil ne détient qu’un identifiant. Quand l’agent a besoin d’un message, le serveur appelle votre fournisseur en temps réel, renvoie le résultat et jette le corps du message. Rien du contenu n’est conservé. C’est ainsi que fonctionne MCP Emails.

Le modèle tout-copier est populaire parce qu’il est facile à construire et donne l’impression d’une recherche instantanée. Mais il change ce à quoi vous consentez réellement quand vous cliquez sur « Connect ». Vous n’accordez pas un accès. Vous autorisez un double.

## Ce qu’une boîte « synchronisée » accumule vraiment

Une fois qu’un outil a copié vos courriels, quatre choses en découlent, que le fournisseur les annonce ou non.

### Une seconde copie de vos courriels que vous ne maîtrisez pas

Votre vraie boîte mail réside chez Google, Microsoft ou Fastmail, derrière leurs équipes de sécurité et leur historique de fuites. Un outil de synchronisation crée une seconde copie complète, fidèle à l’original, ailleurs — l’instance Postgres d’une startup, un bucket S3, un index de recherche. Chaque lien de réinitialisation de mot de passe, fil juridique, résultat médical et code de secours à deux facteurs que vous avez jamais reçu existe désormais dans un endroit que vous n’avez pas examiné et que vous ne pouvez pas auditer.

### Une surface de violation plus grande

C’est la partie que les gens sous-estiment. Si la base de données du fournisseur fuit, l’attaquant n’obtient pas vos *identifiants* — il obtient vos *courriels*, déjà déchiffrés et indexés, prêts à être lus. Pas besoin de se connecter à votre compte. La partie la plus dommageable d’une fuite de courriel, c’est le courriel lui-même, et un outil tout-copier l’a obligeamment rassemblé au même endroit. Vous héritez de leur posture de sécurité en plus de celle de votre fournisseur.

### Une rétention à laquelle vous devez penser

Où part la copie quand vous vous déconnectez ? Dans un outil de synchronisation bien géré, la suppression est une tâche de fond qui *devrait* s’exécuter. Dans un outil bâclé, vos messages restent dans les sauvegardes et les embeddings longtemps après votre départ. Avec une conception à récupération en direct, il n’y a rien à supprimer, parce que rien n’a été conservé. Révoquer l’accès dans le tableau de bord, c’est toute l’histoire.

### Le risque d’entraînement et d’« amélioration du produit »

Un corpus stocké de courriels réels est irrésistible. Il est tentant de s’en servir pour améliorer le classement de recherche, affiner un modèle ou entraîner un classifieur. Même avec de bonnes intentions, dès que vos courriels se trouvent dans une base de données, la question « cela pourrait-il être utilisé à des fins auxquelles je n’ai pas souscrit ? » reste ouverte en permanence. Si les données n’ont jamais été stockées, la question ne se pose jamais.

## Comment fonctionne réellement la récupération en direct

Voici le chemin parcouru par un seul appel \`email_read\` (action \`read\`) à travers MCP Emails :

\`\`\`
agent  →  serveur MCP  →  Edge Function isolée
                              ↓ déchiffrer le jeton (en mémoire)
                         votre fournisseur (Gmail / Graph / IMAP)
                              ↓ corps du message
agent  ←  résultat analysé  ←  Edge Function
                         (corps jeté, rien écrit)
\`\`\`

L’identifiant est la seule chose au repos, et il est chiffré avec **AES-256-GCM**. Le déchiffrement n’a lieu qu’à l’intérieur d’une Edge Function isolée, au moment de l’appel, et la clé de chiffrement est un secret d’environnement stocké séparément de la base de données — de sorte qu’un vidage de base seul est inutile. Le message lui-même ne touche jamais de stockage durable. Il est analysé, renvoyé à votre agent, et disparaît.

L’envoi fonctionne de la même manière et ajoute une garantie de plus : le courrier sortant passe par *votre* fournisseur — l’API Gmail, Microsoft Graph, ou votre propre SMTP. Nous ne relayons jamais depuis notre propre domaine, donc votre délivrabilité et votre réputation de domaine restent entièrement les vôtres. Il n’y a pas de pool d’envoi partagé pour vous faire atterrir dans la réputation de spam de quelqu’un d’autre.

Si vous voulez les rouages plus profonds du modèle d’identifiants — jetons OAuth contre mots de passe d’application, et pourquoi les deux restent chiffrés — j’ai détaillé tout ça dans [OAuth contre clés API pour l’accès de l’IA au courriel](/blog/oauth-vs-api-keys-ai-email-access).

## Le compromis, en toute honnêteté

Le « jamais stocké » n’est pas gratuit. Il y a un coût réel, et je préfère le nommer plutôt que faire comme s’il n’existait pas.

Comme nous ne tenons pas d’index local, la recherche s’exécute contre la recherche de votre fournisseur à chaque fois. Vous obtenez une [recherche native du fournisseur](/docs) — opérateurs Gmail, KQL Outlook, recherche texte IMAP — qui est puissante, mais c’est leur latence et leur sémantique de requête, pas un index sur mesure réglé par nous. Et il n’y a pas de push : nous ne pouvons pas notifier votre agent à l’instant où un courriel arrive, parce que nous ne surveillons pas une copie synchronisée. Pour réagir aux nouveaux messages, votre agent interroge régulièrement (par exemple, \`email_read\` avec l’action \`list\` et \`unread_only: true\` à intervalles réguliers).

Pour la plupart des gens, c’est un compromis facile. Une recherche légèrement plus lente et une boucle d’interrogation, en échange de ne jamais créer une seconde copie de vos données les plus sensibles. Je prends.

## Ce qu’il faut demander à tout outil d’IA pour courriel

Avant de connecter quoi que ce soit à votre boîte mail, posez au fournisseur quatre questions directes. Les réponses vous disent dans quel camp il se trouve.

- **Stockez-vous le contenu de mes courriels, ou le récupérez-vous en direct à chaque requête ?** « Récupération en direct, suppression immédiate » est la réponse que vous voulez.
- **Qu’est-ce qui est exactement conservé ?** Ce devrait être un seul identifiant chiffré, rien concernant le contenu des messages.
- **L’identifiant est-il chiffré au repos, et où réside la clé ?** Séparée de la base de données, voilà la bonne réponse.
- **L’envoi passe-t-il par mon fournisseur ou le vôtre ?** Le vôtre protège votre réputation de domaine ; le leur la mêle à celle d’inconnus.

Si un outil ne peut pas répondre clairement à ces questions, c’est aussi une information. C’est le même prisme que j’appliquerais à la question plus large de la sécurité dans [Est-il sûr de donner à un agent IA l’accès à votre courriel ?](/blog/is-it-safe-to-give-ai-agent-email-access) — c’est l’architecture sous le marketing qui détermine réellement votre risque.

## Où cela s’inscrit

Le modèle « jamais stocké » est une pièce d’une décision plus large : comment relier un agent à une vraie boîte mail sans faire quelque chose que vous regretterez. Le [guide complet 2026 pour donner à votre agent IA l’accès au courriel](/blog/how-to-give-your-ai-agent-email-access) couvre le tableau d’ensemble, et si vous pesez l’idée d’héberger votre propre serveur, [Gmail MCP hébergé contre auto-hébergé](/blog/hosted-vs-self-hosted-gmail-mcp-server) aborde qui détient la clé de chiffrement dans chaque cas.

Vous n’avez pas à choisir entre donner à votre agent un accès utile à la boîte mail et garder vos courriels hors de la base de données d’un tiers. Avec la récupération en direct, vous obtenez les deux. [Connectez une boîte mail](/signup) et vous pourrez la révoquer en un clic — et il ne reste rien derrière quand vous le faites.`,
};

export default translation;
