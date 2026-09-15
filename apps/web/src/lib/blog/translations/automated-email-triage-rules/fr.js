const translation = {
  title: 'Des règles de tri automatique du courrier qui tournent sans modèle dans la boucle',
  description:
    'Comment fonctionnent les automatisations de MCP Emails : une recherche enregistrée plus une action fixe, selon une cadence, sans aucun modèle qui interprète vos e-mails. Prévisualiser, créer, activer, lire le journal des exécutions.',
  coverAlt:
    'Règles de tri du courrier sans supervision dans MCP Emails : une recherche enregistrée plus une action fixe selon un calendrier',
  content: `> **Outlook et Microsoft 365 sont en cours de développement.** Ils ne peuvent pas encore être connectés en production.

Chaque matin, vous demandez à votre agent de dégager le bruit : classer les notifications de build, marquer les reçus comme lus, transférer les factures à votre comptable. Cela fonctionne. Cela coûte aussi un appel au modèle à chaque fois, et le mardi le résultat diffère légèrement de celui du lundi.

MCP Emails propose une seconde surface pour exactement ce courrier. Une **automatisation** est une recherche enregistrée plus une action fixe, évaluée selon une cadence, sans aucun modèle dans la boucle. Le courrier est mis en correspondance, jamais interprété.

**Aller à :** [Ce qu'est une règle](#ce-quune-automatisation-est-vraiment) · [En créer une](#en-crer-une-prvisualiser-crer-activer) · [Ce qu'elle peut faire](#ce-quune-rgle-peut-et-ne-peut-pas-faire) · [Quand s'en passer](#quand-ne-pas-crire-de-rgle)

## Ce qu'une automatisation est vraiment

Trois éléments, et rien d'autre.

- **Un filtre.** Les mêmes critères structurés qu'accepte une recherche : \`from\`, \`to\`, \`cc\`, \`subject\`, \`body\`, \`text\`, \`unread\`, \`has_attachment\`, \`flagged\`, \`since\`, \`before\`. Au moins un critère est obligatoire. Un filtre vide est refusé net : sur une cadence rapide, il traiterait toute votre boîte, ce qui relève bien plus souvent de la faute de frappe que de l'intention.
- **Une action.** Exactement une, prise dans un ensemble fermé, fixée à la création de la règle.
- **Une cadence.** \`interval_minutes\`, tirée d'une échelle fixe : 15, 30, 60, 180, 360, 720 ou 1440 minutes. Une échelle plutôt qu'un entier libre, parce qu'une règle à la minute n'obtient rien d'autre qu'une limitation de débit.

Définissez aussi \`max_messages_per_run\` (25 par défaut, 200 au maximum) : c'est le rayon d'action par exécution, qui plafonne la quantité de courrier qu'un mauvais filtre peut toucher avant qu'un humain ne consulte le journal des exécutions. Une règle s'exécute avec les identifiants qui l'ont créée, et l'autorité est redérivée à chaque exécution : révoquer la clé arrête donc la règle dès son exécution suivante.

## Pourquoi une règle vaut mieux que demander à un agent chaque matin

- **Coût.** Une règle ne consomme aucun token. La conversation du matin en consomme tous les jours, pour du courrier dont vous avez décidé le traitement il y a des mois.
- **Reproductibilité.** Le même filtre produit la même action. Il n'y a pas de « aujourd'hui il a décidé autrement », parce qu'il n'y a aucune décision.
- **Aucun geste halluciné.** Une règle ne peut pas inventer un dossier, improviser un destinataire ni agir sur une instruction trouvée dans le corps d'un e-mail.
- **Elle tourne pendant que vous dormez.** MCP Emails fonctionne par ailleurs par sondage : l'agent regarde s'il y a du courrier quand vous le lui demandez. La règle est la partie qui ne demande rien.

## Le tri par agent et les règles automatiques ne font pas le même travail

Les règles traitent le courrier identifiable depuis son enveloppe : un expéditeur connu, un préfixe d'objet stable, un indicateur non lu, une pièce jointe. La conversation traite le courrier qui demande du jugement. N'exprimez pas du jugement sous forme de filtre : une règle qui devine une intention à partir d'une ligne d'objet se trompera sans surveillance, à grande échelle, pendant des semaines. Si la décision suppose de comprendre le corps du message, gardez-la dans une conversation et suivez le [guide de tri et de résumé](/blog/ai-agent-triage-summarize-inbox).

## En créer une : prévisualiser, créer, activer

Trois étapes dans cet ordre. L'ordre est la propriété de sécurité.

### Étape 1 : tester le filtre à blanc

\`automation_read\` avec l'action \`preview\` est un test à blanc. Il indique ce que le filtre trouve à l'instant, n'applique rien, n'envoie rien et ne réserve aucun message dans le registre de déduplication : il ne consomme donc jamais du courrier qu'une vraie exécution ultérieure devrait voir. Prévisualisez un \`filter\` non enregistré, ou une règle enregistrée via \`automation_id\`.

> Prévisualise un filtre d'automatisation sur ma boîte professionnelle : le courrier non lu venant de notifications@github.com. Montre-moi ce qu'il trouverait maintenant. Ne crée et ne modifie rien.

Lisez les correspondances. Si un seul élément de cette liste ne devrait pas être déplacé, le filtre est faux : resserrez-le et prévisualisez de nouveau.

### Étape 2 : créer la règle

\`automation\` avec l'action \`create\` demande quatre choses : \`name\`, \`filter\`, \`rule_action\` et \`interval_minutes\`. Notez bien les deux clés, car on les confond facilement. Sur l'outil, \`action\` choisit l'opération (create, update, enable, disable, delete). \`rule_action\` est ce que la **règle** fait au courrier correspondant.

> Crée une automatisation nommée « GitHub notifications » sur ma boîte professionnelle. Filtre : expéditeur notifications@github.com. Action de la règle : déplacer vers le dossier Notifications. Intervalle : 60 minutes.

La règle est créée **désactivée**, et ce n'est pas un indicateur que vous pouvez basculer dans le même appel. L'activation est toujours un acte distinct et explicite, pour qu'aucun travail non surveillé sur la boîte ne démarre comme effet de bord de la création d'une règle.

### Étape 3 : l'activer

\`automation\` avec l'action \`enable\`. La règle devient immédiatement due, s'exécute, puis suit sa cadence. C'est le moment où le serveur commence à toucher votre boîte sans que personne ne regarde, et c'est pourquoi cela mérite une étape à part. \`delete\` supprime une règle mais conserve son historique d'exécutions.

## Ce qu'une règle peut et ne peut pas faire

Les cinq actions de règle :

- **move** vers un dossier que vous nommez.
- **label**, appliquée comme libellé Gmail, catégorie Outlook ou mot-clé IMAP. En IMAP, un libellé est un atome : les espaces deviennent donc des tirets bas.
- **mark_read**.
- **forward** vers dix destinataires au maximum, avec une courte note facultative. Un transfert est **toujours** retenu pour [approbation humaine](/blog/approve-ai-agent-email-sends), quel que soit le réglage d'approbation de la boîte : ce réglage signifie « un humain surveille les envois de cette boîte », et un exécutant non surveillé est précisément ce qui casse cette hypothèse.
- **draft_reply**, qui n'écrit jamais qu'un brouillon et n'envoie jamais. Son modèle substitue \`{{sender_name}}\`, \`{{sender_email}}\`, \`{{subject}}\` et \`{{date}}\`, et rien d'autre. Le corps des messages n'est jamais interpolé.

Ce qu'une règle ne peut pas faire :

- **Supprimer du courrier.** La suppression n'est pas offerte à une automatisation. Déplacer vers la Corbeille, les Indésirables ou le Spam est refusé aussi : tous les fournisseurs vident ces dossiers sur minuterie, donc y classer un message revient à le supprimer à retardement. Classez dans un dossier à vous et supprimez vous-même une fois le journal des exécutions lu.
- **Interpréter quoi que ce soit.** Pas de résumé, pas de « si cela a l'air urgent ».
- **Enchaîner deux actions.** Étiqueter et marquer comme lu, cela fait deux règles sur le même filtre.

## Suivre l'historique des exécutions

\`automation_read\` avec l'action \`runs\` liste les exécutions récentes et leurs compteurs : correspondances, traités, réussis, échoués, ignorés. L'action \`list\` donne toutes les règles de l'espace de travail avec leur planification, leur action et leur santé ; \`get\` en lit une intégralement, filtre et état d'échec compris.

Le compteur qu'il faut comprendre est celui des ignorés (**skipped**). Un nombre élevé d'ignorés face à un faible nombre de traités n'est pas un problème : cela signifie qu'une exécution qui se chevauchait a bien été dédupliquée. Chaque règle réserve un message avant d'agir dessus, si bien qu'une exécution relancée ne peut pas déplacer deux fois le même courrier. Les règles s'arrêtent aussi d'elles-mêmes après cinq exécutions en échec consécutives, plutôt que de s'acharner éternellement contre un nom de dossier cassé.

## Quand ne pas écrire de règle

- La décision suppose de lire et de comprendre le corps du message. Gardez-la en conversation.
- L'expéditeur n'est pas stable. Un filtre posé sur une cible mouvante vieillit mal.
- C'est un nettoyage ponctuel. Demandez à l'agent d'exécuter \`email_search_and_move\` une fois, et regardez-le faire.
- Vous ne l'avez pas prévisualisée. Une règle sans test à blanc est une supposition programmée.

## Une boîte réaliste : quelques règles et une conversation

Quatre règles qui évacuent tout le mécanique, plus une conversation matinale sur ce qui reste :

1. Les notifications de déploiement d'un expéditeur connu, déplacées vers un dossier, toutes les 60 minutes.
2. Les reçus et confirmations de commande, étiquetés, toutes les 180 minutes.
3. Les factures venant d'une adresse de facturation connue, transférées à votre comptable et retenues pour votre approbation, toutes les 720 minutes.
4. Un expéditeur de newsletter que vous gardez mais ne lisez jamais, marqué comme lu, toutes les 1440 minutes.

Ensuite vous interrogez votre agent sur les trente messages restants au lieu des cent quatre-vingts qui sont arrivés. Les règles n'essaient pas d'être malignes. Elles retirent tout ce qui n'a jamais eu besoin d'intelligence.

## Les règles comptent dans les actions de votre forfait

Chaque action appliquée par une règle est décomptée exactement comme une action interactive, parce que l'effet sur la boîte est le même. Sur le forfait **Free**, cela représente 150 actions e-mail facturables par mois calendaire UTC, les 7 premiers jours n'étant pas comptés. Ce plafond mensuel s'applique aux espaces de travail créés le 2026-09-13 ou après ; les espaces créés avant en sont exemptés. Quand un espace de travail atteint son quota, la règle se **met en pause** au lieu d'échouer : elle reste activée, et sa prochaine exécution est reportée au moment où la période de quota se termine. **Personal**, à $5 par mois, supprime le plafond mensuel d'actions et autorise 3 boîtes connectées. Voir les [tarifs](/pricing).

## FAQ

**Une automatisation utilise-t-elle un LLM ?**  
Non. Une règle est une recherche enregistrée plus une action fixe. Le courrier est mis en correspondance, jamais interprété, et le corps des messages n'est jamais copié dans quoi que ce soit que produit une règle.

**Une règle peut-elle supprimer mes e-mails ?**  
Non. La suppression n'est pas offerte aux automatisations, et déplacer du courrier vers la Corbeille, les Indésirables ou le Spam est refusé pour la même raison.

**Quelle autorisation faut-il ?**  
Toute action d'automatisation exige \`manage:automations\`, une autorisation distincte de la lecture ou de l'envoi, parce que la détenir signifie qu'un client peut créer des règles permanentes qui touchent votre boîte sans surveillance.

**Une règle de transfert enverra-t-elle du courrier toute seule ?**  
Jamais. Un transfert est toujours retenu pour approbation humaine, quel que soit le réglage d'approbation de votre boîte, et une règle \`draft_reply\` n'écrit jamais qu'un brouillon.

## Prochaine étape

[Créez un compte gratuit](/signup), connectez une boîte et demandez à votre agent de prévisualiser un filtre avant d'enregistrer quoi que ce soit. Quand les correspondances vous conviennent, créez la règle, activez-la, et lisez le journal des exécutions demain. La [documentation](/docs) contient la référence complète des outils.`,
};

export default translation;
