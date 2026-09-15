const translation = {
  title: 'E-mail et IA pour les agences : un agent sur toutes les boîtes de vos clients',
  description:
    "Comment une agence ou un indépendant donne à un agent IA l'accès à plusieurs boîtes clients sans les mélanger : un espace de travail par client, des clés limitées, la lecture seule d'abord et une validation humaine avant chaque envoi.",
  coverAlt:
    'Un agent IA travaillant sur des boîtes clients séparées avec un accès limité, MCP Emails',
  content: `> **Outlook et Microsoft 365 sont en cours de développement.** Ils ne peuvent pas encore être connectés en production, donc un client sous Microsoft 365 devra patienter. Fonctionnent aujourd'hui : Google Workspace (avec un mot de passe d'application Google en IMAP par défaut, OAuth également disponible), Zoho, Fastmail, Migadu, Titan, Rackspace, IONOS et tout hébergeur IMAP standard.

Si vous gérez le courrier de plusieurs clients, vous vivez avec une règle : rien du client A ne doit apparaître dans un fil du client B. Un agent IA ne change pas la règle, il rend simplement plus facile de l'enfreindre. Un seul agent avec un seul identifiant qui atteint toutes les boîtes que vous gérez est à une consigne maladroite de citer la mauvaise facture à la mauvaise personne.

Trois échecs méritent qu'on s'en protège dès la conception : la **fuite entre clients**, quand un identifiant trop large laisse une recherche tomber sur la mauvaise boîte ; le **prestataire qui s'en va**, dont le portable contient toujours une clé API valide ; et l'**envoi non relu**, quand un agent répond au client de votre client, poliment et à côté. Intégrez la séparation à l'accès lui-même et l'agent ne peut plus franchir une frontière, même si une consigne le lui demande.

**Aller à :** [Un espace de travail par client](#un-espace-de-travail-par-client) · [Des clés API limitées](#des-cls-api-limites-par-mission) · [Le blocage avant envoi](#le-blocage-avant-envoi)

## Un espace de travail par client

L'espace de travail est l'unité de séparation. Les boîtes, les membres, les clés API et l'activité vivent à l'intérieur d'un seul, et la frontière est appliquée dans la base de données par la sécurité au niveau des lignes, pas par un filtrage soigneux dans le code applicatif. Une clé émise dans l'espace Acme ne peut pas lire une boîte de Bolt, quoi que dise la consigne.

Avoir plusieurs espaces de travail est une fonction **Team** (79 $/mois, 756 $/an), qui apporte aussi des membres illimités avec des rôles, le SSO (SAML / OIDC), un journal d'audit et un support prioritaire. L'abonnement est rattaché à votre compte et non à un espace, donc un seul abonnement Team couvre tous les espaces clients que vous créez. Nommez chacun d'après le client, n'y connectez que les boîtes de ce client, et passez de l'un à l'autre depuis la barre latérale du tableau de bord.

En dessous de Team, les formules sont pour une personne dans un seul espace : **Pro** (15 $/mois, 144 $/an) connecte un nombre illimité de boîtes, **Personal** (5 $/mois) trois, **Free** une. C'est moins cher, et toutes les boîtes partagent le même rayon d'impact. Voir les [tarifs](/pricing) et la [matrice des fournisseurs](/docs/providers).

## Membres et rôles

Quatre rôles : **owner** (propriétaire), **admin**, **member** et **viewer**. Seul le propriétaire peut changer les rôles. Les admins peuvent inviter et retirer des membres, mais pas retirer un autre admin. Les viewers sont en lecture seule, et cela est appliqué jusque dans la couche des identifiants : une clé détenue par un viewer ne peut porter que \`read:email\` et \`search:email\`.

Ajouter des personnes est en soi une fonction Team, puisque Free, Personal et Pro sont des formules mono-utilisateur. Le montage qui fonctionne : le responsable d'un client est admin dans l'espace de ce client et membre d'aucun autre, un junior qui fait du tri est viewer dans le seul espace où il travaille, et personne d'autre que vous ne détient un accès qui couvre tout votre portefeuille.

## Des clés API limitées par mission

La clé API est ce qu'utilise votre agent quand l'outil client ne parle pas OAuth. Deux réglages la resserrent. Utilisez les deux.

**Portées.** Une clé porte une liste explicite tirée de ce vocabulaire : \`read:email\`, \`search:email\`, \`send:email\`, \`manage:folders\`, \`delete:email\`, \`manage:drafts\`, \`manage:contacts\`, \`schedule:email\`, \`manage:automations\`. Une clé de tri n'a besoin que de \`read:email\`. Traitez \`manage:automations\` comme la plus puissante du lot : une automatisation continue d'agir quand personne ne regarde.

**Boîtes.** Une clé atteint soit toutes les boîtes de l'espace, y compris celles connectées plus tard, soit uniquement une liste explicite. Pour du travail client, restreignez-la.

Émettez une clé par mission ou par automatisation, nommée d'après la tâche, pour que la révoquer soit une décision sur cette tâche et non sur toute votre installation. La clé en clair n'est affichée qu'une fois, car seul un hachage SHA-256 est conservé.

Si l'outil client parle OAuth, comme Claude et la plupart des clients MCP, passez plutôt par là et ajoutez le point de terminaison :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

L'écran de consentement propose une autorisation en lecture seule, une standard et une complète, plus une option portée par portée. [OAuth ou clés API](/blog/oauth-vs-api-keys-ai-email-access) explique laquelle choisir.

## La lecture seule d'abord, l'envoi ensuite

Commencez chaque mission en lecture seule. Un agent qui sait lire, chercher et résumer couvre déjà le tri, le reporting et le "qu'est-ce qu'on leur a promis en mars", c'est-à-dire l'essentiel de la valeur.

> Résume les messages non lus de la boîte support d'Acme sur les deux derniers jours ouvrés. Range-les en : à répondre aujourd'hui, en attente du client, et bruit. N'envoie, ne déplace et ne supprime rien.

Ajoutez des capacités une portée à la fois, quand une tâche l'exige. Accorder trop peu se rattrape : un appel auquel il manque une portée renvoie une réponse claire de portée insuffisante, si bien que le client peut demander cette portée précise et réessayer.

## Le blocage avant envoi

Pour tout ce qui atteint le client de votre client, activez la relecture des envois. C'est un réglage par boîte, avec trois modes : envoi immédiat, une carte de relecture dans la conversation avec l'IA, ou relecture uniquement dans le tableau de bord.

Dans les deux modes de relecture, l'e-mail est préparé mais pas remis, et la validation n'a lieu qu'à un seul endroit : une session de navigateur connectée, tenue par un propriétaire ou un admin de l'espace. L'assistant n'a pas de session de navigateur, il ne peut donc pas valider son propre envoi. Il peut le refuser, ce qui est le sens sûr. La carte de relecture est un confort, pas une frontière de permissions.

L'écran de relecture affiche l'expéditeur, les destinataires en À et en Cc, un décompte des destinataires en Cci, l'objet, les pièces jointes et le texte, le HTML étant montré en source plutôt que rendu. Une demande en attente expire au bout de 24 heures. Le blocage fonctionne sur toutes les formules, Free comprise. Plus de détails dans [la validation humaine des envois d'un agent IA](/blog/approve-ai-agent-email-sends).

## Les boîtes partagées comme support@ et billing@

Ici, les adresses partagées sont des boîtes ordinaires. Connectez support@ ou billing@ avec un mot de passe d'application du fournisseur, dans l'espace du client à qui elles appartiennent. Le nom d'expéditeur affiché est un réglage par boîte, donc les réponses partent au nom d'"Acme Support" et non au vôtre.

Votre agent trouve les boîtes avec \`inbox_list\` et s'y adresse par leur nom, vous ne collez donc jamais d'identifiant de boîte dans une consigne. Ensuite l'ensemble est réduit : \`email_read\` et \`email_compose\`, \`email_organize\` et \`email_search_and_move\` pour le tri, \`draft\` et \`schedule\` pour tout ce qui doit attendre une personne.

Posez une attente dès le départ : MCP Emails fonctionne par interrogation. L'agent vérifie le courrier quand vous le lui demandez, ou quand une automatisation planifiée s'exécute. "Nous répondons en 60 secondes" n'est donc pas une promesse que cette architecture permet.

## Passation et fin de mission

Répétez-le avant d'en avoir besoin. Chaque point est une action dans le tableau de bord.

- **Révoquer une clé.** Elle cesse de fonctionner immédiatement, partout où elle avait été collée.
- **Retirer un membre.** Cela révoque aussi les clés API que cette personne avait créées dans l'espace, et le même démontage a lieu quand quelqu'un part de lui-même.
- **Rétrograder en viewer.** La rétrogradation révoque ses clés qui portent plus que la lecture, plutôt que d'affaiblir en silence un identifiant sur lequel quelqu'un compte encore.
- **Déconnecter la boîte.** L'identifiant stocké est la seule donnée de boîte jamais conservée, et la déconnexion le supprime.
- **Révoquer aussi chez le fournisseur.** Demandez au client de supprimer le mot de passe d'application ou de retirer l'autorisation Google. Ce chemin ne passe pas par vous, et c'est précisément ce qui rassure.

Il n'existe pas de transfert de propriété : vous ne pouvez donc pas remettre un espace de travail à la fin d'un projet. Un client qui reprend son courrier en interne ouvre son propre compte et connecte ses propres boîtes.

## Ce que vous pouvez et ne pouvez pas promettre à un client

Ce que vous pouvez écrire noir sur blanc :

- Le contenu des messages n'est jamais stocké. Il est récupéré en direct chez le fournisseur du client à chaque requête, puis abandonné.
- La seule donnée de boîte conservée est l'identifiant du fournisseur, chiffré au repos en AES-256-GCM, la clé étant gardée séparément.
- L'activité est journalisée en métadonnées seulement : nom de l'outil, boîte, horodatage et statut, jamais le contenu.
- Aucun fournisseur d'IA n'est sous-traitant. MCP Emails n'envoie pas votre courrier à un modèle de son choix et ne s'en sert pas pour entraîner quoi que ce soit. Les sous-traitants sont Supabase, Vercel et Stripe.
- La seule exception au "jamais stocké" est un message programmé pour plus tard, conservé chiffré jusqu'à son heure d'envoi.

Ne promettez pas que l'injection de consignes est résolue. Elle est contenue, pas résolue, et c'est bien pour cela que les clés en lecture seule, les boîtes restreintes et le blocage avant envoi existent. Ne promettez pas de réaction instantanée, ni des certifications que le produit n'a pas revendiquées. Envoyez celui qui fait la revue de sécurité vers [/security](/security) et rédigez votre contrat pour coller à cette page, pas pour aller au-delà. Le code est public et auto-hébergeable, ce qui répond à un audit mieux que n'importe quelle promesse.

## Questions fréquentes

**Faut-il un compte MCP Emails distinct par client ?**  
Non. Un compte, un abonnement Team, un espace de travail par client. L'abonnement suit votre utilisateur, donc chaque espace hérite de la formule.

**Un client peut-il voir le courrier d'un autre ?**  
Non, si les boîtes de chaque client vivent dans leur propre espace. La séparation est appliquée par la sécurité au niveau des lignes, et une clé émise dans un espace ne peut pas lire les boîtes d'un autre.

**Que se passe-t-il le jour où un prestataire s'en va ?**  
Retirez-le de l'espace de travail, ce qui révoque dans la même action les clés qu'il y avait créées. S'il reste mais ne doit plus écrire, rétrogradez-le en viewer.

**Cela fonctionne-t-il pour un client sous Microsoft 365 ?**  
Pas encore. Le support est en cours de développement et ne peut pas être connecté en production. Google Workspace, Zoho, Fastmail, Titan, IONOS et les hébergeurs IMAP génériques fonctionnent aujourd'hui.

## Étape suivante

[Créez un compte gratuit](/signup), connectez une boîte client en lecture seule et lancez une consigne de tri avant de toucher à quoi que ce soit d'autre. Quand la séparation compte, passez à Team depuis la [page des tarifs](/pricing). La [documentation](/docs) contient la référence complète des outils et des portées, et [/security](/security) est la page à remettre au responsable sécurité du client.`,
};

export default translation;
