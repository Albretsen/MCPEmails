const translation = {
  title: 'Gérer plusieurs comptes e-mail avec un seul agent IA',
  description:
    'Faites passer vos boîtes professionnelle, personnelle et secondaire par un seul agent IA : comment il découvre les boîtes, comment cadrer une demande, des noms d\'expéditeur toujours justes et la validation des envois boîte par boîte.',
  coverAlt:
    'Un agent IA connecté aux comptes e-mail professionnel, personnel et secondaire avec MCP Emails',
  content: `Presque personne n'a une seule boîte aux lettres. Vous avez une adresse professionnelle, une adresse personnelle et au moins une autre pour une activité secondaire ou pour un domaine que vous possédez toujours. Chaque question qui traverse deux comptes devient une recherche manuelle à deux endroits.

Un seul agent IA sur l'ensemble supprime ces allers-retours, mais seulement si l'agent sait quelle boîte est laquelle et si les réponses partent de la bonne adresse.

**Aller à :** [Découverte](#votre-agent-trouve-les-botes-aux-lettres-tout-seul) · [Cadrer une demande](#limiter-une-demande-une-seule-bote) · [Limites des forfaits](#ce-que-limitent-les-forfaits)

## Pourquoi un seul agent vaut mieux que changer de client mail

Un client mail vous montre des comptes. Il ne répond pas aux questions. « Dans lequel de mes comptes le reçu Stripe est-il arrivé ? » suppose une recherche dans trois boîtes, plus un jugement. Un agent qui a accès à toutes les boîtes fait cela en une seule demande, et vous cessez de servir de routeur. Le deuxième gain : un seul jeu d'habitudes, puisque les mêmes outils se trouvent derrière chaque compte.

## Votre agent trouve les boîtes aux lettres tout seul

Vous ne collez jamais un identifiant de boîte dans un prompt. L'agent appelle \`inbox_list\`, qui renvoie toutes les boîtes que votre clé peut utiliser, chacune avec son UUID, son adresse e-mail, son nom affiché, son fournisseur, une marque de service facultative et un objet de capacités. Tous les autres outils prennent soit \`inbox_id\` (un UUID, ou une adresse), soit \`inbox\` (une adresse), renseigné à partir de ce résultat.

Deux détails à connaître :

- **La découverte est gratuite.** \`inbox_list\` est le seul outil qui ne compte pas dans le quota mensuel d'actions du forfait Free, donc un agent peut se réorienter sans aucun coût.
- **Des sélecteurs contradictoires sont refusés, pas devinés.** Un appel qui porte un \`inbox_id\` pour une boîte et une adresse \`inbox\` pour une autre est refusé, et l'erreur nomme les deux. La cause habituelle est un identifiant périmé repris plus tôt dans la conversation. Demandez à l'agent de réessayer avec la seule adresse.

## Limiter une demande à une seule boîte

Nommez le compte. Les adresses fonctionnent partout où un identifiant fonctionne, donc un langage simple suffit :

> Uniquement dans jane@acme.com, liste tout ce qui est non lu depuis deux jours et dis-moi ce qui demande une réponse aujourd'hui. Ne touche pas à mes autres comptes.

Vous pouvez aussi imposer ce cadrage en dehors du prompt. Dans le tableau de bord, chaque clé API possède un réglage **Accès aux boîtes** (Inbox access) : toutes les boîtes, ou une liste explicite. Une clé limitée à la boîte de votre activité secondaire ne peut pas lire les deux autres, quoi que dise un prompt.

## Le fan-out, c'est l'agent qui appelle une fois par boîte

C'est le point que l'on comprend souvent de travers : **un appel atteint une seule boîte.** Lister, lire, rechercher, déplacer et supprimer sont toujours limités à une seule boîte, et il n'y a pas de fan-out automatique. Donc « cherche dans tous mes comptes » revient à ce que l'agent lance la recherche une fois par boîte et fusionne lui-même les résultats. Cela fonctionne bien, avec trois conséquences :

- Laissez-le appeler \`inbox_list\` d'abord, ou indiquez combien de comptes vous avez. S'il suppose qu'il y en a un, il rendra un rapport très assuré sur une seule boîte.
- Demandez une réponse fusionnée (« une seule liste combinée, étiquetée avec le compte d'origine »), sinon vous recevrez trois rapports séparés.
- Le volume augmente avec le nombre de boîtes. Un tri sur trois boîtes représente au moins trois actions facturables, pas une.

## Noms et identité d'expéditeur

Un seul champ remplit trois rôles. Chaque boîte a un nom affiché : c'est le **Libellé** (Label) dans la liste de votre tableau de bord, le \`display_name\` que l'agent lit dans \`inbox_list\`, et le nom que les destinataires voient dans l'en-tête From, devant l'adresse.

« work2 » est donc un mauvais nom à double titre : l'agent ne peut pas deviner à quoi sert la boîte, et un client mail finira par afficher « work2 » à côté de votre adresse. Utilisez quelque chose qu'un inconnu peut lire, par exemple « Jane Doe (Acme) » ou « Northside Studio ». Définissez-le dans le tableau de bord sous le **Nom d'expéditeur** (Sender name) de la boîte, ou avec \`signature_set\`, et relisez-le avec \`signature_get\`. Les noms sont limités à 100 caractères.

Envoyer depuis un alias est plus restreint qu'on ne le croit :

- Votre propre adresse connectée fonctionne toujours comme valeur de From, chez tous les fournisseurs.
- Une adresse **différente** doit être une identité Gmail Send As vérifiée, listée sous \`sender_identities\` dans l'entrée \`inbox_list\` de cette boîte.
- Chez un fournisseur autre que Gmail, une adresse From qui n'est pas celle de la boîte est refusée plutôt que réécrite en silence.

Les signatures sont elles aussi propres à chaque boîte : une signature formelle sur l'adresse professionnelle, rien sur l'adresse personnelle. Voir [les signatures e-mail pour Claude](/blog/email-signatures-for-claude).

## Validation des envois, boîte par boîte

La validation se configure boîte par boîte. Chaque boîte a un réglage **Vérifier avant d'envoyer** (Review before sending) avec trois options : envoyer immédiatement, afficher une carte de validation dans la conversation avec l'IA, ou valider uniquement dans le tableau de bord.

C'est ce qui rend un montage mixte confortable : laissez la boîte de votre activité secondaire en envoi immédiat, et retenez chaque envoi professionnel pour validation. Dans les deux modes de validation, l'e-mail est préparé mais pas remis, et l'approbation n'a lieu que dans une session de navigateur connectée détenue par un propriétaire ou un administrateur. La carte affichée dans la conversation est un confort, pas une frontière de permissions. [La validation humaine des envois par un agent IA](/blog/approve-ai-agent-email-sends) entre davantage dans le détail.

## Trois routines multi-boîtes à reprendre

**Un tri matinal sur tout.** Demandez une liste unique et classée, pas un résumé par compte :

> Vérifie toutes mes boîtes connectées. Donne-moi une seule liste combinée de ce qui demande une réponse aujourd'hui, de la plus récente à la plus ancienne, étiquetée avec le compte dans lequel le message est arrivé. Ne déplace, n'envoie et ne supprime rien.

Le [guide de tri de boîte de réception](/blog/ai-agent-triage-summarize-inbox) propose des grilles à coller dans ce prompt.

**Retrouver un fil quand vous avez oublié le compte.**

> Trouve la facture de Hetzner du mois d'août. Cherche dans toutes les boîtes connectées, et dis-moi dans quel compte elle se trouve et quel est le montant.

**Faire passer une conversation d'un rôle à un autre.** Quand un contact personnel devient un client, transférez le fil vers la boîte professionnelle et faites rédiger la réponse depuis l'adresse professionnelle. Demandez d'abord à l'agent de confirmer depuis quelle boîte il envoie.

## Ce qui change quand vous mélangez Gmail, Outlook et IMAP

Les configurations mixtes sont le cas normal, et les fournisseurs ne s'accordent pas sur ce qu'est un dossier.

- **Gmail a des libellés.** Un déplacement ajoute un libellé et retire le message de la boîte de réception. Les autres libellés restent attachés, donc un message peut se trouver à plusieurs endroits.
- **IMAP a des dossiers.** Un déplacement est un déplacement : le message quitte un dossier et arrive dans un autre.
- **Outlook a des dossiers imbriqués.** Un déplacement est un déplacement, comme en IMAP, et les dossiers peuvent se trouver dans d'autres dossiers. Outlook n'a pas de libellés : l'action de libellé d'une automatisation applique donc une catégorie Outlook.
- **Les noms de dossiers diffèrent.** Archive, All Mail, Spam, Junk et les noms localisés varient selon le fournisseur. Faites appeler \`folder_list\` par l'agent sur la boîte qu'il s'apprête à toucher.
- **Le cadrage par dossiers vaut pour une boîte.** Restreindre une recherche à un ensemble de dossiers s'applique à l'intérieur d'une seule boîte, donc une recherche par dossiers sur plusieurs comptes reste un appel par compte.

[Libellés Gmail et dossiers IMAP](/blog/gmail-labels-vs-imap-folders-ai-agents) explique ce que « archiver » signifie vraiment de chaque côté.

## Ce que limitent les forfaits

Les boîtes connectées sont ce sur quoi les forfaits sont tarifés :

- **Free, $0.** Une boîte connectée. 150 actions e-mail facturables par mois calendaire UTC, les 7 premiers jours n'étant pas comptés. Ce plafond mensuel s'applique aux espaces de travail créés le 2026-09-13 ou après ; les espaces de travail créés avant en sont exemptés.
- **Personal, $5 par mois ou $48 par an.** Trois boîtes connectées, pas de plafond mensuel d'actions, limite de débit en rafale 2x, support par e-mail.
- **Pro, $15 par mois ou $144 par an.** Boîtes connectées illimitées, limite de débit en rafale 5x, historique analytique plus long.
- **Team, $79 par mois ou $756 par an.** Membres illimités avec rôles, un espace de travail distinct par client ou par activité, SSO (SAML/OIDC) et journal d'audit, support prioritaire.

Une routine multi-boîtes coûte une action par boîte, donc votre nombre de boîtes détermine le volume autant que vos habitudes. Détails sur la page [tarifs](/pricing).

## FAQ

**Comment l'agent sait-il de quelle boîte je parle ?**
Par \`inbox_list\`, qui renvoie l'adresse et le nom affiché de chaque boîte qu'il peut utiliser. Nommez l'adresse dans votre demande. Un identifiant de boîte et une adresse qui se contredisent sont refusés, pas devinés.

**Les réponses partiront-elles de la bonne adresse ?**
Oui, quand vous envoyez depuis la boîte propriétaire de l'adresse : chaque boîte envoie via son propre fournisseur, son nom affiché et sa signature. Une adresse From différente exige une identité Gmail Send As vérifiée, et elle est refusée chez les autres fournisseurs.

**Puis-je laisser l'agent envoyer librement depuis une boîte et en retenir une autre ?**
Oui. La vérification avant envoi est un réglage par boîte, donc une boîte peut envoyer immédiatement pendant qu'une autre attend votre approbation dans un navigateur connecté.

**Mon courrier de tous ces comptes est-il stocké quelque part ?**
Non. Le contenu des messages est récupéré en direct chez votre fournisseur à chaque demande, puis écarté. Seule la référence de connexion chiffrée du fournisseur est conservée. Voir [sécurité](/security).

## Prochaine étape

[Commencez gratuitement](/signup), connectez votre boîte la plus active et demandez à votre agent ce qui demande une réponse aujourd'hui. Ajoutez le deuxième et le troisième compte quand vous voudrez une réponse unique au lieu de trois. La [documentation](/docs) contient la référence complète des outils, et les [détails par fournisseur](/docs/providers) couvrent ce que chaque type de boîte prend en charge.`,
};

export default translation;
