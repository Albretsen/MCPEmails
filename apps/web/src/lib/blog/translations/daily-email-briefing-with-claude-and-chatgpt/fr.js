const translation = {
  title: 'Résumé quotidien de vos e-mails avec Claude et ChatGPT : un point sur votre boîte chaque jour',
  description:
    "Trois façons d'obtenir chaque jour un résumé de votre boîte : une tâche programmée dans Claude, une tâche programmée dans ChatGPT, ou un brief du matin que MCPEmails dépose dans votre boîte sans aucune conversation ouverte. Configuration, prompts et limites.",
  coverAlt:
    'Un résumé quotidien des e-mails par Claude et ChatGPT, qui récapitule les nouveaux messages de plusieurs boîtes connectées',
  content: `**Pour recevoir chaque jour un résumé de vos e-mails par Claude ou ChatGPT, il suffit de donner deux choses à l'assistant : l'accès à votre boîte et un horaire.** Les deux assistants exécutent désormais des tâches programmées. Celles de Claude lancent un prompt toutes les heures, chaque jour, chaque semaine ou en semaine, et celles de ChatGPT s'exécutent à l'heure choisie, sur toutes les formules. Reliez la tâche à votre boîte par un connecteur, et le résumé vous attend chaque matin.

Une troisième méthode se passe complètement de conversation : MCPEmails peut déposer un brief du matin directement dans votre boîte, à l'heure de votre choix. Ce guide présente les trois, avec les prompts à utiliser et ce que chacune ne sait pas faire.

**Aller à :** [Claude](#un-résumé-quotidien-de-vos-e-mails-avec-claude) · [ChatGPT](#un-résumé-programmé-de-votre-boîte-dans-chatgpt) · [Brief du matin](#le-brief-du-matin-sans-aucune-conversation) · [Lequel choisir](#lequel-choisir) · [Prompts](#des-prompts-pour-un-résumé-utile) · [FAQ](#faq)

## D'abord, donnez votre boîte à l'assistant

Une tâche programmée ne peut résumer que les e-mails auxquels elle a accès. Le connecteur Gmail de Claude atteint un seul compte Google, et son connecteur Microsoft 365 atteint les comptes professionnels une fois qu'un administrateur l'a approuvé. ChatGPT a sa propre application Gmail. Pour tout le reste, ou pour réunir plusieurs boîtes dans un même résumé, connectez-les via un serveur MCP.

MCPEmails est un serveur MCP hébergé. Vous connectez chaque boîte une seule fois, puis vous ajoutez une seule URL de connecteur dans Claude ou ChatGPT :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Il fonctionne avec Gmail et Google Workspace, Outlook et Microsoft 365, iCloud, Yahoo, Fastmail, Zoho et toute boîte compatible IMAP et SMTP. Chaque boîte connectée apparaît dans l'assistant sous son nom : un même résumé peut donc couvrir votre propre adresse, info@ et un Gmail personnel. [Plusieurs comptes e-mail dans Claude et ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explique cette configuration.

Un résumé ne fait que lire : choisissez donc l'accès **Lecture seule** quand l'écran de consentement vous le demande. Une tâche qui s'exécute en votre absence ne peut alors rien envoyer, déplacer ni supprimer, quoi que disent les e-mails qu'elle lit. La page [accès en lecture seule](/docs/read-only-access) liste précisément ce que permet cette connexion.

## Un résumé quotidien de vos e-mails avec Claude

Les tâches programmées de Claude font partie de Cowork dans l'application Claude, sur toutes les formules payantes (Pro, Max, Team et Enterprise). D'après [l'article d'aide d'Anthropic](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork), une tâche peut s'exécuter toutes les heures, chaque jour, chaque semaine, en semaine ou seulement quand vous la lancez, et elle utilise les mêmes connecteurs que vos autres tâches. Les tâches s'exécutent à distance : elles respectent donc leur horaire même quand votre ordinateur est en veille ou l'application fermée, sauf si la tâche a besoin de fichiers ou d'applications locales.

1. **Ajoutez MCPEmails à Claude.** Ouvrez **Customize → Connectors**, cliquez sur **+ Add**, puis sur **Add custom connector**. Nommez-le MCPEmails, saisissez \`https://mcpemails.com/api/mcp\`, cliquez sur **Continue**, gardez les paramètres de connexion détectés et cliquez sur **Add**. Connectez-vous à MCPEmails et choisissez **Lecture seule**. Le [guide de configuration de Claude](/blog/connect-claude-to-email) montre chaque écran.
2. **Créez la tâche.** Cliquez sur **Scheduled** dans la barre latérale, puis sur **New task**, et choisissez **Create with Claude** ou **Set up manually**. Vous pouvez aussi décrire la tâche dans une conversation (« chaque jour de semaine à 7 h, résume ma boîte ») : Claude vous propose alors un nom, un horaire et des instructions, que vous confirmez avec **Schedule**.
3. **Collez le prompt de résumé** de la [section des prompts](#des-prompts-pour-un-résumé-utile) et choisissez **Weekdays** ou **Daily**.
4. **Lancez-la une fois à la main** pour vérifier le résultat avant la première exécution programmée.

Dans Claude, chaque outil de connecteur peut être réglé sur **Always allow**, **Needs approval** ou **Blocked**. Pour un résumé, bloquez les outils d'envoi et de rangement de MCPEmails, ou gardez la connexion en Lecture seule, pour que la tâche reste un simple résumé.

## Un résumé programmé de votre boîte dans ChatGPT

[L'article d'aide d'OpenAI sur les tâches](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt) indique que les tâches programmées sont disponibles sur toutes les formules, y compris Free et Go. Avec Free, une tâche s'exécute au plus une fois par jour, dans une plage approximative comme « le matin ». Les formules payantes peuvent exécuter des tâches jusqu'à toutes les heures, à une heure précise. Chaque formule limite le nombre de tâches actives, de 3 sur Free à 15 sur Pro et Enterprise. Vous créez une tâche depuis la page **Scheduled** ou en le demandant dans une conversation, et ChatGPT peut vous prévenir par notification push ou par e-mail quand elle est terminée.

Les tâches peuvent utiliser les applications prises en charge, et OpenAI cite Gmail, Slack et GitHub. Si vos e-mails sont dans un seul compte Gmail, l'application Gmail de ChatGPT est la source la plus simple pour la tâche.

L'article d'OpenAI ne précise pas si un serveur MCP que vous avez ajouté vous-même est disponible dans une tâche. Pour utiliser MCPEmails, ajoutez-le comme décrit dans le [guide de configuration ChatGPT](/docs/chatgpt), programmez la tâche quelques minutes plus tard et vérifiez que la première exécution lit bien vos e-mails avant de compter dessus. OpenAI précise aussi qu'une action qui envoie un message ou modifie des données peut nécessiter votre approbation et met alors la tâche en pause : une raison de plus de garder un résumé en lecture seule.

## Le brief du matin, sans aucune conversation

Les formules Pro et Business de MCPEmails incluent un **brief du matin** : un résumé quotidien que MCPEmails prépare sur ses propres serveurs et dépose directement dans l'une de vos boîtes, à l'heure que vous avez fixée. Aucun assistant, aucune conversation ni aucune application ouverte n'intervient : il arrive donc même les jours où vous n'ouvrez ni Claude ni ChatGPT.

Chaque brief couvre votre journée, à l'heure locale :

- **Les expéditeurs VIP en premier.** Les nouveaux e-mails des adresses ou domaines que vous avez listés, dans toutes vos boîtes.
- **Les nouveaux e-mails par boîte** depuis le dernier brief : combien de messages, et les expéditeurs et objets les plus récents.
- **Les relances à faire.** Les rappels que votre IA a créés pour des e-mails restés sans réponse.
- **Les e-mails mis en attente** qui reviennent plus tard dans la journée.
- **Les envois programmés** qui partent plus tard dans la journée.

Il couvre jusqu'à 10 boîtes connectées. Les jours sans nouveauté sont sautés plutôt qu'envoyés vides. Le brief est ajouté directement dans la boîte : rien n'est envoyé et rien ne quitte votre boîte. Il est construit à partir de règles, sans qu'aucun modèle d'IA ne lise vos e-mails.

Pour l'activer, ouvrez **Paramètres** dans le tableau de bord, trouvez **Brief du matin** dans les paramètres de l'espace de travail, cochez **Déposer un brief du matin dans ma boîte de réception chaque jour**, puis choisissez l'heure, votre fuseau horaire, la boîte qui le reçoit et vos éventuels expéditeurs VIP. Seuls les propriétaires et les administrateurs de l'espace de travail peuvent modifier ce réglage.

Les relances et les mises en attente du brief viennent de votre IA, et elles font partie des mêmes formules. Demandez à Claude ou ChatGPT « rappelle-moi si Dana n'a pas répondu d'ici vendredi » ou « mets ce message en attente jusqu'à lundi matin », et MCPEmails s'en charge sur ses serveurs, même une fois la conversation fermée.

## Lequel choisir

- **Vous voulez un résumé rédigé en langage courant, qui fait le tri entre ce qui compte et le reste :** une tâche programmée dans Claude ou ChatGPT. Le modèle lit les e-mails et décide de ce qu'il faut signaler.
- **Vous le voulez chaque jour, sans dépendre d'une application de chat ni de ses limites de tâches :** le brief du matin. Il arrive dans votre boîte à l'heure fixée, et il n'improvise jamais.
- **Vous voulez les deux :** ils se complètent. Le brief donne chaque matin la liste fixe, et vous interrogez l'assistant sur ce qu'elle contient.

Si vous préférez que vos e-mails soient triés plutôt que résumés, des [règles de tri automatique des e-mails](/blog/automated-email-triage-rules) déplacent, étiquettent et marquent les nouveaux messages selon un horaire, sans modèle.

## Des prompts pour un résumé utile

Demandez un format court et fixe. Un résumé qui se lit en une minute est un résumé que vous continuez à lire.

> Avec MCPEmails, fais-moi mon brief du matin pour toutes les boîtes connectées : ce qui est arrivé depuis hier à la même heure, ce qui attend une réponse de ma part aujourd'hui, et tout ce qui a une échéance cette semaine. Regroupe par boîte, 10 lignes au plus. N'envoie, ne déplace et ne modifie rien.

> Avec MCPEmails, liste les e-mails non lus des dernières 24 heures dans sales@ et info@ qui viennent d'un client ou d'un prospect. Pour chacun : l'expéditeur, un résumé en une ligne, et s'il faut répondre aujourd'hui. Ignore les newsletters et les notifications. Lecture seule.

> Avec MCPEmails, cherche dans ma boîte les factures, les contrats et tout ce qui mentionne un paiement ou une date d'échéance arrivé au cours de la semaine passée. Une ligne pour chacun, avec le montant et la date s'ils sont indiqués. Lecture seule.

Écrire « lecture seule » dans le prompt est une bonne habitude, mais la vraie protection est la connexion elle-même : une connexion en Lecture seule ne peut pas envoyer, même si un message demande au modèle de le faire. Les e-mails sont écrits par d'autres personnes, et certains sont rédigés pour manipuler les assistants d'IA. [Est-il sûr de donner à un agent IA l'accès à vos e-mails ?](/blog/is-it-safe-to-give-ai-agent-email-access) explique pourquoi.

Pour d'autres prompts de tri, consultez [le tri et les résumés de boîte par un agent IA](/blog/ai-agent-triage-summarize-inbox). Pour écrire une réponse à heure fixe plutôt que lire, [programmer un e-mail avec Claude ou ChatGPT](/blog/schedule-email-with-claude-and-chatgpt) présente les envois différés.

## FAQ

**Claude peut-il résumer mes e-mails chaque jour ?**
Oui. Créez dans Claude (Pro, Max, Team ou Enterprise) une tâche programmée qui s'exécute chaque jour ou en semaine, avec un connecteur vers votre boîte. Le connecteur Gmail de Claude couvre un seul compte Google ; MCPEmails couvre n'importe quel fournisseur et plusieurs boîtes à la fois.

**ChatGPT peut-il résumer ma boîte selon un horaire ?**
Oui. Les tâches programmées de ChatGPT peuvent utiliser son application Gmail sur toutes les formules, avec une limite d'une fois par jour sur Free. OpenAI ne précise pas si un serveur MCP personnalisé fonctionne dans une tâche : testez une exécution avant de compter dessus.

**La tâche s'exécute-t-elle quand mon ordinateur est éteint ?**
Les tâches programmées de Claude s'exécutent à distance, sauf si elles ont besoin de fichiers ou d'applications locales. Les tâches de ChatGPT s'exécutent chez OpenAI. Le brief du matin de MCPEmails s'exécute sur nos serveurs et arrive dans votre boîte dans tous les cas.

**Mes e-mails sont-ils stockés pour le résumé ?**
Pas par MCPEmails. Les e-mails sont récupérés en direct chez votre fournisseur à chaque requête, puis supprimés une fois la réponse envoyée. Le brief du matin est écrit dans votre propre boîte, pas conservé chez nous. Consultez la page [sécurité](/security).

**Quelle formule inclut le brief du matin ?**
Pro et Business. Une tâche programmée dans Claude ou ChatGPT peut lire via MCPEmails avec n'importe quelle formule MCPEmails, y compris Free avec une boîte. Les formules actuelles sont sur la [page des tarifs](/pricing).

## Prochaine étape

[Commencez gratuitement](/signup), connectez votre boîte la plus chargée en Lecture seule, ajoutez MCPEmails à Claude ou ChatGPT et lancez une fois le prompt de résumé à la main. Quand le résultat vous convient, programmez-le.`,
};

export default translation;
