const translation = {
  title: 'Programmer l\'envoi d\'un e-mail avec Claude ou ChatGPT (envoi différé)',
  description:
    'Programmez depuis Claude ou ChatGPT un e-mail qui partira plus tard de votre propre boîte Gmail, Outlook, iCloud ou IMAP : configuration, fuseaux horaires, annulation et limites.',
  coverAlt:
    'Claude et ChatGPT programment l\'envoi différé d\'un e-mail depuis une boîte connectée avec MCPEmails',
  content: `Pour programmer l'envoi d'un e-mail avec Claude ou ChatGPT, l'assistant a besoin d'un outil de messagerie capable de garder un message et de l'envoyer plus tard. MCPEmails en propose un. Connectez votre boîte, ajoutez MCPEmails comme connecteur, puis indiquez le moment : « Envoie ceci à Dana lundi à 9 h, heure d'Oslo. » Le message attend dans une file sur le serveur MCPEmails et part de votre propre adresse à l'heure prévue, que la conversation, l'application ou votre ordinateur soient encore ouverts ou non.

Cela fonctionne de la même façon dans Claude, dans ChatGPT et dans d'autres clients MCP, et avec Gmail et Google Workspace, Outlook et Microsoft 365, iCloud, Fastmail, Yahoo, Zoho et toute boîte compatible IMAP et SMTP.

**Aller à :** [Connecteurs intégrés](#ce-que-font-les-connecteurs-de-messagerie-intégrés) · [Configuration](#programmer-un-e-mail-avec-claude-ou-chatgpt) · [Fuseaux horaires](#fuseaux-horaires) · [Annuler ou modifier](#vérifier-annuler-ou-modifier-un-e-mail-programmé) · [FAQ](#faq)

## Ce que font les connecteurs de messagerie intégrés

Les deux assistants proposent leurs propres connecteurs de messagerie. Voici où ils en étaient le 20 octobre 2026 :

- **Claude.** L'article d'aide d'Anthropic sur le connecteur Gmail mentionne la recherche, la lecture, la rédaction de brouillons, l'envoi, la réponse et le transfert. La programmation d'un message pour plus tard n'y figure pas.
- **ChatGPT.** La page d'aide d'OpenAI sur son application Outlook Email couvre la recherche et la lecture de messages, les actions sur les personnes et les contacts, et l'envoi d'e-mails en texte brut depuis des boîtes partagées ou déléguées. Sa FAQ sur l'application Google porte sur l'utilisation des données et sur les tâches déclenchées par Gmail. Aucune des deux ne décrit d'envoi programmé.

ChatGPT propose bien des **tâches planifiées**, qui exécutent un prompt au moment que vous choisissez. Ce n'est pas la même chose qu'un e-mail mis en file d'attente. Le message est rédigé au moment où la tâche s'exécute, pas au moment où vous validez le texte, et OpenAI précise que les actions qui nécessitent votre approbation peuvent mettre la tâche en pause.

Un envoi programmé via MCPEmails est un message finalisé : vous lisez le texte exact maintenant, et c'est ce texte-là qui part à l'heure prévue.

## Programmer un e-mail avec Claude ou ChatGPT

1. **Connectez votre boîte à MCPEmails.** Dans le tableau de bord, ouvrez **Boîtes**, puis **Connecter la boîte**, et choisissez votre fournisseur. Chaque fournisseur a sa propre page dans la rubrique [connect](/connect).
2. **Ajoutez MCPEmails à votre assistant.** Dans Claude, ouvrez **Personnaliser** (Customize), puis **Connecteurs** (Connectors), cliquez sur **+ Ajouter** (+ Add), choisissez **Ajouter un connecteur personnalisé** (Add custom connector) et collez \`https://mcpemails.com/api/mcp\`. Le [guide Claude](/blog/connect-claude-to-email) détaille chaque étape. Dans ChatGPT, MCPEmails s'ajoute comme connecteur MCP personnalisé ; les offres qui le permettent et l'emplacement du menu ont changé plus d'une fois cette année, alors suivez les étapes à jour du [guide de configuration ChatGPT](/docs/chatgpt).
3. **Accordez la programmation au moment de l'autorisation.** L'écran de consentement de MCPEmails propose plusieurs niveaux d'accès. Choisissez **Accès complet**, ou **Personnalisé** avec la programmation cochée. **Standard** n'inclut pas la programmation : une demande d'envoi programmé est alors refusée.
4. **Demandez l'e-mail et l'heure.** Indiquez les destinataires, le contenu, la date et l'heure, et votre fuseau horaire.

En coulisses, l'assistant appelle l'outil \`schedule\` avec l'action \`create\`, en transmettant les destinataires, l'objet, le corps et l'heure d'envoi. MCPEmails vérifie tout de suite les adresses, l'objet et le corps : une adresse mal formée ou un corps vide est refusé immédiatement, au lieu d'échouer le lundi matin. En revanche, il ne peut pas savoir si une adresse valide est bien celle que vous vouliez : c'est pourquoi les prompts ci-dessous demandent à voir le destinataire d'abord. Le résultat indique l'heure programmée et un identifiant que l'assistant pourra utiliser plus tard pour annuler.

À l'heure d'envoi, un répartiteur sur le serveur MCPEmails, qui consulte la file chaque minute, envoie le message via le propre fournisseur de la boîte : Gmail, Microsoft ou le serveur SMTP de la boîte. Il part de votre adresse, avec votre [signature](/blog/email-signatures-for-claude) ajoutée à ce moment-là. Comptez environ une minute d'écart par rapport à l'heure fixée : l'outil n'est pas conçu pour une précision à la seconde.

Si le serveur de messagerie refuse le message avant d'en accepter la moindre partie, le répartiteur réessaie chaque minute pendant 15 minutes au plus après l'heure d'envoi. Si la boîte a été déconnectée entre-temps, le message n'est pas envoyé du tout.

## Des prompts qui programment sans accroc

> Rédige un court message de remerciement à dana@example.com pour l'appel d'aujourd'hui et programme-le pour lundi à 09:00, Europe/Oslo. Montre-moi le texte et l'heure d'envoi avant de le programmer.

> Programme le rappel de paiement ci-dessous depuis compta@ vers les trois adresses qu'il contient, pour le 1er du mois prochain à 08:30, heure de New York.

> Quels e-mails ai-je programmés ? Donne le destinataire, l'objet et l'heure d'envoi dans mon fuseau horaire.

> Annule l'e-mail programmé pour Dana.

Demander à voir le texte et l'heure d'abord coûte un message de plus et évite les deux erreurs les plus fréquentes : le mauvais destinataire et la mauvaise heure. Si vous gérez plusieurs boîtes, nommez celle d'où envoyer (« depuis compta@ ») ; [plusieurs comptes e-mail dans Claude et ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explique comment l'assistant les distingue.

## Fuseaux horaires

L'outil \`schedule\` attend l'heure d'envoi sous forme d'horodatage avec décalage horaire, par exemple \`2026-11-02T09:00:00+01:00\`. L'assistant convertit « lundi à 9 h » dans ce format, il doit donc connaître votre fuseau. Nommez une ville ou un fuseau dans le prompt (« heure d'Oslo », « Europe/Oslo », « heure de l'Est américain ») ; sinon, le modèle doit deviner.

C'est avec l'heure d'été que les suppositions se trompent. Oslo est à +02:00 jusqu'au dernier dimanche d'octobre et à +01:00 ensuite : 09:00 heure d'Oslo le 2 novembre 2026 correspond donc à \`+01:00\`. Nommer la ville permet à l'assistant de choisir le bon décalage pour cette date.

La confirmation donne l'heure en UTC. Demandez à l'assistant de vous la relire dans votre heure locale avant de vous y fier. Une heure déjà passée est refusée.

## Vérifier, annuler ou modifier un e-mail programmé

- **Voir ce qui est en attente.** \`schedule_list\` renvoie les messages en attente, du plus proche au plus lointain, avec les destinataires, l'objet, l'heure d'envoi et le statut. Demandez-les pour toutes les boîtes ou pour une seule.
- **Annuler.** L'outil \`schedule\` avec l'action \`cancel\` arrête un message tant qu'il est encore en attente. Une fois que le répartiteur a commencé à l'envoyer, il ne peut plus être annulé.
- **Modifier.** Un message programmé ne peut pas être modifié. Demandez à l'assistant d'annuler le message et de programmer la version corrigée ; il peut faire les deux dans le même échange.
- **Les changements de signature sont pris en compte.** La signature est ajoutée au moment de l'envoi : si vous la modifiez après avoir programmé le message, c'est la nouvelle qui part.

## Ce que la programmation ne fait pas

- **Répondre dans un fil.** Un e-mail programmé est un nouveau message avec son propre objet : il ne s'insère pas dans le fil comme une réponse. Pour une réponse qui doit rester dans la conversation, demandez à l'assistant d'enregistrer un brouillon de réponse (\`draft\` avec l'action \`reply\`) et envoyez-le vous-même le moment venu.
- **Reprendre une pièce jointe d'un autre e-mail.** Le fichier doit être inclus dans la demande elle-même, 10 Mo au total. Un envoi immédiat peut joindre un fichier directement depuis un message de votre boîte ; un envoi programmé ne le peut pas.
- **Se répéter.** Chaque e-mail programmé part une seule fois. Pour un rappel hebdomadaire, il faut programmer chaque envoi.
- **Tomber à la seconde près.** La file est consultée une fois par minute.

Une demande de programmation peut comporter une clé d'idempotence. Si l'assistant la renvoie avec la même clé après une coupure de connexion, MCPEmails met le message en file une seule fois, pas deux. [Éviter les envois en double par un agent IA](/blog/prevent-duplicate-ai-agent-email-sends) explique comment.

## Où le message attend

L'essentiel de ce que fait MCPEmails se passe en direct : le courrier est lu chez votre fournisseur à chaque requête et n'est pas conservé. Un e-mail programmé ne peut pas fonctionner ainsi, puisqu'il doit exister quelque part jusqu'à son heure d'envoi. MCPEmails le stocke chiffré (AES-256-GCM) dans sa base de données à Stockholm, et ne le déchiffre que pour l'envoyer ou pour afficher ses destinataires et son objet quand vous listez vos envois programmés. Un message annulé n'est jamais envoyé. La [page sécurité](/security) donne le détail.

## FAQ

**Claude peut-il programmer l'envoi d'un e-mail ?**
Oui, via un serveur MCP doté d'un outil d'envoi programmé. Connectez votre boîte à MCPEmails, ajoutez-le à Claude comme connecteur personnalisé, accordez la programmation et demandez à Claude d'envoyer le message à une date, une heure et dans un fuseau horaire précis. Le connecteur Gmail d'Anthropic ne mentionne pas la programmation.

**ChatGPT peut-il programmer un e-mail ?**
Oui, de la même façon : ajoutez MCPEmails comme connecteur MCP personnalisé ([configuration](/docs/chatgpt)) et demandez-le. Les tâches planifiées de ChatGPT exécutent un prompt plus tard, ce qui n'est pas la même chose que mettre en file d'attente un message finalisé.

**Claude ou ChatGPT doit-il rester ouvert jusqu'à l'envoi ?**
Non. Le message est mis en file sur le serveur MCPEmails et envoyé depuis celui-ci. Vous pouvez fermer la conversation, l'application et votre ordinateur.

**Quels fournisseurs de messagerie permettent la programmation ?**
Toutes les boîtes depuis lesquelles MCPEmails peut envoyer : Gmail et Google Workspace, Outlook et Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex et les autres boîtes IMAP et SMTP. Le message est envoyé via le propre fournisseur de la boîte.

**Comment annuler un e-mail programmé ?**
Demandez à l'assistant de l'annuler. Il retrouve le message avec \`schedule_list\` et l'annule par son identifiant, ce qui fonctionne jusqu'au moment où l'envoi commence.

## Étape suivante

[Commencez gratuitement](/signup), connectez votre boîte et demandez à Claude ou ChatGPT de vous programmer un e-mail de test dans cinq minutes. Le [guide Claude](/blog/connect-claude-to-email) et le [guide ChatGPT](/blog/connect-chatgpt-to-email) couvrent la connexion, et la [référence des outils](/docs#tools) liste tous les arguments de programmation.`,
};

export default translation;
