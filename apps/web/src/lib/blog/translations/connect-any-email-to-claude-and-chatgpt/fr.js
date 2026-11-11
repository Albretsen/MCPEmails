const translation = {
  title: "Comment connecter n'importe quel compte e-mail à Claude ou ChatGPT (Yahoo, IMAP, domaine personnalisé, plusieurs boîtes)",
  description:
    "Toutes les façons de donner une vraie boîte mail à Claude ou ChatGPT en novembre 2026 : ce que couvrent les connecteurs intégrés Gmail, Outlook et iCloud, où ils s'arrêtent, et comment connecter Yahoo, un domaine personnalisé, GMX ou plusieurs boîtes avec un serveur MCP, une application de bureau ou un outil d'automatisation.",
  coverAlt: 'Yahoo, IMAP, domaine personnalisé et plusieurs autres boîtes connectées à Claude et ChatGPT',
  content: `Claude et ChatGPT ont tous deux des connecteurs e-mail intégrés, et tous deux s'arrêtent aux grands fournisseurs. Si votre messagerie est chez Yahoo, AOL, GMX, sur un domaine d'entreprise hébergé chez IONOS, OVH ou un hébergeur cPanel, ou répartie sur plusieurs comptes, il vous faut autre chose. Ce guide recense toutes les options en novembre 2026 : les connecteurs intégrés et l'endroit exact où ils s'arrêtent, les services MCP hébergés qui comblent le vide (MCPEmails en fait partie, et nous nommons les autres), les voies locales et auto-hébergées, et les plateformes d'automatisation. Chaque affirmation sur un autre produit a été lue sur sa propre page le 11 novembre 2026 ; les sources sont à la fin.

**Aller à :** [Connecteurs intégrés](#ce-que-couvrent-les-connecteurs-intégrés) · [Ce qui reste de côté](#ce-que-les-connecteurs-intégrés-laissent-de-côté) · [Services MCP hébergés](#services-mcp-hébergés) · [Bureau et auto-hébergement](#applications-de-bureau-et-serveurs-auto-hébergés) · [Outils d'automatisation](#plateformes-dautomatisation) · [Tableau comparatif](#les-options-côte-à-côte) · [Mise en place avec MCPEmails](#comment-faire-avec-mcpemails) · [FAQ](#faq)

## Ce que couvrent les connecteurs intégrés

Commencez ici, car si votre seule boîte est Gmail, un compte Microsoft 365 professionnel ou iCloud, vous n'avez peut-être besoin de rien d'autre.

**Claude : Gmail.** Le connecteur Gmail du répertoire de Claude est fait par Google. Il lit et recherche le courrier, rédige, envoie, répond, transfère, gère les libellés et met des messages à la corbeille, et par défaut Claude demande votre accord avant chacune de ces actions. Le centre d'aide d'Anthropic le décrit comme atteignant "the Google account you've connected" : un compte Google par connexion. Les pièces jointes n'arrivent que sous forme de métadonnées. Il est disponible pour tous les utilisateurs de Claude ; sur Team et Enterprise, un propriétaire l'active d'abord.

**Claude : Microsoft 365 et Outlook.com personnel.** Deux cas. Un compte professionnel ou scolaire a besoin d'un tenant Microsoft Entra, d'un consentement unique d'un Global Administrator, et reste en lecture seule tant que l'organisation n'active pas les outils d'écriture. Un compte Microsoft personnel (Outlook.com, Hotmail, Live ou MSN) se connecte sur les forfaits Free, Pro, Max et Ultra sans administrateur, avec les outils d'écriture inclus, donc Claude peut rédiger, envoyer et ranger le courrier et demande avant de le faire ; cette option n'apparaît pas sur Team et Enterprise, et les outils d'écriture ne gèrent pas les pièces jointes.

**Claude : Spark.** Le connecteur de Spark Mail figure dans le répertoire de Claude et c'est la seule voie intégrée vers Yahoo ou IMAP dans Claude, avec une réserve : il lit les comptes que vous avez ajoutés à l'application de bureau Spark, et les outils n'existent que pendant que Spark Desktop tourne sur votre Mac ou PC. La suite sous [applications de bureau](#applications-de-bureau-et-serveurs-auto-hébergés).

**ChatGPT : Gmail et Outlook.** Les deux sont des apps sous **Settings**, puis **Plugins**. Depuis juin 2026, ChatGPT peut rédiger et envoyer depuis un compte Gmail ou Outlook connecté, sur le web, pour Plus, Pro, Business et Enterprise. Depuis août 2026, le plugin Gmail peut contenir plusieurs comptes Google, et OpenAI a ensuite étendu les comptes multiples aux autres plugins sur tous les forfaits. L'app Outlook Email est documentée pour les comptes Microsoft professionnels : ce qu'elle peut faire dépend du consentement Microsoft Entra et des réglages de l'espace de travail, et elle peut lire, déplacer et envoyer du texte brut depuis une boîte partagée ou déléguée à laquelle vous avez déjà accès. La page d'OpenAI ne décrit pas les comptes Outlook.com personnels ; [Connecter ChatGPT à Outlook.com et Hotmail](/blog/connect-chatgpt-to-outlook-com-hotmail) couvre ce que les gens rencontrent.

**ChatGPT : iCloud Mail.** Ajouté le 27 octobre 2026 et en déploiement sur tous les forfaits ChatGPT, sur le web, l'application de bureau et iOS. Il se connecte avec un mot de passe pour application Apple et accepte une adresse se terminant par @icloud.com, @me.com ou @mac.com, donc un compte Gmail ou Yahoo qui voisine avec iCloud dans Apple Mail n'en fait pas partie. La recherche de contacts est en lecture seule. Détails dans [le plugin iCloud Mail de ChatGPT](/blog/chatgpt-icloud-mail-plugin).

**Le serveur MCP de votre propre fournisseur.** Fastmail en fait tourner un sur \`api.fastmail.com/mcp\`, avec des accès lecture, écriture et envoi séparés, pas d'accès aux pièces jointes, et un compte Fastmail par connexion dans Claude. Zoho Mail en a un aussi, gratuit sur les forfaits Zoho gratuits et payants, avec envoi, réponse, libellés, drapeaux et dossiers, et il peut porter les outils d'autres services Zoho. Chacun sert les boîtes que ce fournisseur héberge, et chacun s'ajoute à Claude ou ChatGPT comme connecteur personnalisé.

## Ce que les connecteurs intégrés laissent de côté

Mettez la liste ci-dessus bout à bout, et voici les boîtes sans voie intégrée dans aucun des deux assistants :

- **Yahoo Mail et AOL.** Pas de connecteur dans Claude, pas de plugin dans ChatGPT.
- **Un domaine personnalisé chez un hébergeur web ou mail.** cPanel et hébergement mutualisé, IONOS, OVH, Namecheap, GoDaddy, Hostinger, STRATO, one.com, Migadu et les autres. Ce sont des boîtes IMAP et SMTP, et aucun des assistants ne parle IMAP.
- **Les fournisseurs régionaux.** GMX, web.de, T-Online, Orange, Libero, Seznam, Yandex, mail.ru et consorts.
- **Plusieurs boîtes dans une seule connexion.** Le plugin Gmail de ChatGPT peut contenir plusieurs comptes Google, et ChatGPT vous laisse connecter plusieurs apps côte à côte. Aucun des assistants n'a de moyen intégré d'atteindre un Gmail, un Yahoo et une boîte IMAP d'entreprise à travers une connexion qui sait laquelle est laquelle.
- **Outlook.com personnel dans ChatGPT.** Documenté pour Claude sur les forfaits personnels ; non décrit sur la page Outlook d'OpenAI.
- **Les clients autres que Claude et ChatGPT.** Cursor, Codex, Gemini CLI, VS Code, Zed et les autres clients MCP n'ont pas de connecteur e-mail propre. Tout ce qui est un serveur MCP standard fonctionne chez eux ; un connecteur qui vit à l'intérieur d'un assistant, non.

Le reste de ce guide consiste à couvrir cette liste.

## Services MCP hébergés

Un serveur MCP e-mail hébergé se connecte à votre boîte pour vous, en IMAP et SMTP ou via l'API du fournisseur, et expose la boîte à n'importe quel client MCP par une seule URL. Vous ajoutez cette URL à Claude comme connecteur personnalisé et à ChatGPT comme serveur MCP personnalisé. Ceux ci-dessous font tous cela ; ils diffèrent par les fournisseurs, l'hébergement et le prix. Notre comparatif classé et daté, avec les faiblesses de chacun, est [les meilleurs serveurs MCP e-mail](/best-email-mcp-servers).

- **MCPEmails** (ce site). Gmail et Google Workspace avec un mot de passe d'application Google, Outlook.com et Microsoft 365 avec Se connecter avec Microsoft, iCloud, Fastmail, Yahoo, AOL, Zoho, Yandex et tout hébergeur IMAP et SMTP avec un mot de passe d'application ou le mot de passe de la boîte. Plusieurs boîtes de n'importe quel mélange derrière une URL, chacune envoyant depuis sa propre adresse. Fonctionne dans Claude, ChatGPT, Cursor, Codex et les autres [clients pris en charge](/docs/clients). Une mise en attente par boîte peut faire patienter chaque envoi jusqu'à votre validation. Le courrier est lu en direct et n'est pas stocké.
- **Mailbox MCP** (mailbox-mcp.com). Microsoft 365 et Outlook.com via une connexion Microsoft, Gmail avec un mot de passe d'application, iCloud et tout hébergeur IMAP, avec des guides pour Yahoo et GMX/WEB.DE. Fonctionne dans Claude, ChatGPT, Grok, Cursor, VS Code, Zed, Windsurf, Cline et d'autres. Niveaux d'accès par connexion, de la lecture seule à l'envoi et la suppression. Plusieurs boîtes, chacune sur son propre forfait. Ajoute des outils d'agenda et de carnet d'adresses.
- **MailMCP** (mailmcp.io). Tout fournisseur qui prend en charge IMAP et SMTP, avec les réglages serveur détectés pour les plus courants. Fonctionne dans Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n et LibreChat. Envoie, et peut programmer un envoi. Plusieurs comptes depuis un même tableau de bord, chacun avec ses propres identifiants. Données hébergées en France.
- **Mailopoly** (mailopoly.com). Une application de messagerie à boîte unifiée pour Gmail, Outlook, iCloud, Yahoo et IMAP, dont le serveur MCP est fourni avec l'application. Présent dans les répertoires de Claude et de ChatGPT, et tout client de serveurs MCP distants fonctionne. L'envoi est derrière une permission et marqué confirmer d'abord. Une connexion couvre tous les comptes que vous possédez.

Les quatre placent un tiers entre l'assistant et votre boîte, donc lisez comment chacun traite les identifiants et le contenu des messages avant de choisir. [Est-il sûr de donner à un agent IA l'accès à ses e-mails ?](/blog/is-it-safe-to-give-ai-agent-email-access) est notre avis sur ce qu'il faut regarder.

## Applications de bureau et serveurs auto-hébergés

Si vous préférez garder le courrier sur votre propre machine, trois voies existent.

- **Une application mail de bureau avec connecteur MCP.** Le connecteur de Spark pour Claude (Spark Mail Limited, Anthropic verified) expose "any Spark email account, including Gmail, Outlook, Exchange, iCloud, Yahoo, and IMAP", avec un niveau par compte (lecture seule, tri ou envoi) réglé dans **Spark Desktop, Settings, AI Agents**. Il peut répondre, transférer et programmer. La contrainte tient à sa conception : les outils n'apparaissent que pendant que Spark Desktop tourne, donc il convient à Claude sur l'ordinateur où vous travaillez, pas à une tâche planifiée ni à un téléphone. C'est un connecteur Claude, pas un serveur que d'autres clients peuvent utiliser.
- **Un serveur IMAP open source que vous faites tourner.** Wh1isper/mcp-email-server est un serveur IMAP et SMTP multi-comptes, sous licence BSD-3-Clause, lancé avec \`uvx\` ou un conteneur et configuré via une interface locale. Vos identifiants et votre courrier ne quittent jamais la machine. Claude Desktop et la plupart des outils de développement peuvent lancer un serveur local ; Claude sur le web et ChatGPT ne se connectent qu'à des serveurs distants, donc cette voie est pour le bureau.
- **MCPEmails auto-hébergé.** Le serveur qui fait tourner mcpemails.com est open source sous AGPL-3.0. [Faites-le tourner vous-même](/self-hosting) sur votre propre base de données et votre propre clé de chiffrement, avec des clés API à portée limitée par client. Claude et ChatGPT ne l'atteignent que s'il a une adresse HTTPS publique.

## Plateformes d'automatisation

Zapier et Make exposent désormais leurs catalogues d'applications aux clients MCP, ce qui donne à Claude ou ChatGPT un moyen d'agir sur une boîte via un flux de travail plutôt que par une connexion à la boîte.

- **Zapier MCP** fonctionne avec Claude, ChatGPT, Cursor "and any other AI client", sur plus de 9 000 applications. Gmail en fait partie, et l'application Microsoft Outlook liste Send Email, Find Emails et Create Draft Email comme outils MCP. C'est inclus dans tous les forfaits Zapier, et chaque appel d'outil consomme deux tâches de votre quota. La page que nous avons lue liste les applications par nom et ne décrit pas de boîte IMAP générique.
- **Make MCP** fonctionne avec ChatGPT, Claude, Cursor et tout agent MCP. Vous construisez un scénario dans Make (une recherche Gmail ou Outlook, un envoi) et le scénario devient un outil que l'assistant peut appeler. C'est inclus dans tous les forfaits Make, le gratuit aussi, et vous payez les opérations que les scénarios consomment.

Ces outils conviennent quand l'e-mail est une étape d'une automatisation plus large que vous faites déjà tourner dans Zapier ou Make. Pour une conversation sur votre boîte (« qu'est-ce qui attend une réponse aujourd'hui ? »), une connexion à la boîte est le meilleur outil, car l'assistant peut chercher, lire et relancer sans un scénario par question.

## Les options côte à côte

| Option | Quelles boîtes | Quelles apps IA | Envoie | Plusieurs boîtes |
| --- | --- | --- | --- | --- |
| Connecteur Gmail de Claude | Un compte Google | Claude | Oui, demande d'abord | Non |
| Connecteur Microsoft 365 de Claude | Comptes professionnels Entra ; Outlook.com, Hotmail, Live, MSN personnels sur Free, Pro, Max, Ultra | Claude | Pro : quand l'administrateur active les outils d'écriture. Personnel : oui | Non |
| Apps Gmail et Outlook de ChatGPT | Comptes Google ; comptes Microsoft professionnels, boîtes partagées et déléguées | ChatGPT | Oui, sur le web, à partir de Plus | Gmail : plusieurs comptes Google |
| Plugin iCloud Mail de ChatGPT | iCloud (@icloud.com, @me.com, @mac.com) | ChatGPT | Oui | Non précisé |
| Serveur MCP de Fastmail ou Zoho | Les boîtes de ce fournisseur | Tout client MCP | Oui | Fastmail dans Claude : un compte. Zoho : si le client autorise plusieurs connexions |
| Connecteur Spark | Tout compte dans Spark Desktop, Yahoo et IMAP compris, pendant que l'app tourne | Claude | Oui, niveau par compte | Oui |
| MCPEmails | Gmail, Outlook et Microsoft 365, iCloud, Fastmail, Yahoo, AOL, Zoho, Yandex, tout IMAP | Claude, ChatGPT, Cursor, Codex, tout client MCP | Oui, mise en attente facultative pour validation | Oui, une URL |
| Mailbox MCP | Microsoft 365 et Outlook.com, Gmail, iCloud, tout IMAP | Claude, ChatGPT, Grok, Cursor, VS Code, Zed, Windsurf, Cline | Oui, niveau par connexion | Oui, par boîte |
| MailMCP | Tout fournisseur IMAP et SMTP | Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n, LibreChat | Oui, y compris programmé | Oui |
| Mailopoly | Gmail, Outlook, iCloud, Yahoo, IMAP | Claude, ChatGPT, tout client MCP distant | Oui, derrière une permission | Oui |
| Wh1isper/mcp-email-server (auto-hébergé) | Tout fournisseur IMAP et SMTP | Clients MCP locaux | Oui | Oui |
| Zapier MCP, Make MCP | Les applications de leurs catalogues, Gmail et Outlook comprises | Claude, ChatGPT, Cursor, tout client MCP | Oui, via une action ou un scénario | Par connexion d'application |

« Non précisé » signifie que la page que nous avons lue ne se prononçait pas. Les forfaits et les prix sont laissés de côté volontairement : ils changent, et la page tarifaire de chaque éditeur est l'endroit où les lire.

## Comment faire avec MCPEmails

Trois étapes, environ cinq minutes, et le résultat fonctionne dans Claude et ChatGPT en même temps.

1. **Connectez la boîte.** [Créez un compte gratuit](/signup), ouvrez **Boîtes**, cliquez sur **Connecter une boîte** et choisissez le fournisseur. [Yahoo Mail](/connect/yahoo) et [AOL](/connect/aol) prennent un mot de passe d'application depuis la page Account Security. Une adresse d'entreprise chez un hébergeur entre comme [IMAP](/connect/imap) : saisissez l'adresse et les réglages serveur se remplissent pour la plupart des hébergeurs, avec une page dédiée pour [cPanel](/connect/cpanel), [IONOS](/connect/ionos), [OVH](/connect/ovh), [Namecheap](/connect/namecheap) et [GoDaddy](/connect/godaddy). Les lecteurs allemands ont [GMX](/connect/gmx), [web.de](/connect/web-de) et [T-Online](/connect/t-online). Chaque page sous [connect](/connect) liste les hébergeurs que nous connaissons. Répétez pour chaque boîte ; le forfait décide combien y tiennent.
2. **Ajoutez le connecteur à votre app IA.** Dans Claude, ouvrez **Customize**, puis **Connectors**, cliquez sur **+ Add**, choisissez **Add custom connector** et collez \`https://mcpemails.com/api/mcp\`. Dans ChatGPT, sur chatgpt.com dans un navigateur avec un forfait payant, ouvrez **Plugins**, cliquez sur le bouton plus, choisissez **Add custom MCP server**, collez la même URL et choisissez OAuth ; la page d'aide d'OpenAI donne les règles de forfait en vigueur. Les pages par client ([Claude](/docs/claude), [ChatGPT](/docs/chatgpt), [Cursor](/docs/cursor), [Codex](/docs/codex) et [les autres](/docs/clients)) ont des captures d'écran et les erreurs courantes.
3. **Demandez.** « Liste mes mails Yahoo non lus d'aujourd'hui » ou « cherche dans ventes@ et info@ tout ce qui date de cette semaine et que personne n'a traité ». L'assistant appelle d'abord \`inbox_list\`, donc il sait quelle boîte est laquelle, et chaque réponse part de la boîte à laquelle elle appartient.

Activez **Vérifier avant d'envoyer** (Review before sending) sur n'importe quelle boîte et chaque envoi depuis celle-ci attend votre validation dans le tableau de bord. C'est inclus dans tous les forfaits.

## FAQ

### Puis-je connecter Yahoo Mail à Claude ou ChatGPT ?

Pas avec leurs connecteurs intégrés : en novembre 2026, les connecteurs e-mail de Claude couvrent Gmail et les comptes Microsoft, et les plugins de ChatGPT couvrent Gmail, Outlook et iCloud Mail. Yahoo se connecte via un serveur MCP comme MCPEmails, avec un mot de passe d'application Yahoo, ou via le connecteur Spark dans Claude pendant que Spark Desktop tourne. [Yahoo Mail dans ChatGPT et Claude](/blog/connect-yahoo-mail-to-chatgpt-and-claude) donne les étapes.

### Comment connecter à Claude une boîte sur domaine personnalisé chez cPanel, IONOS ou OVH ?

Par IMAP. Ni Claude ni ChatGPT ne parlent IMAP eux-mêmes, donc vous connectez la boîte à un serveur MCP qui le fait (MCPEmails, Mailbox MCP, MailMCP ou un serveur que vous faites tourner) et vous ajoutez ce serveur à Claude comme connecteur personnalisé. Avec MCPEmails, vous saisissez l'adresse, les réglages de l'hébergeur se remplissent, et les pages [cPanel](/connect/cpanel), [IONOS](/connect/ionos) et [OVH](/connect/ovh) couvrent ce que chaque hébergeur exige.

### Claude ou ChatGPT peuvent-ils lire plusieurs comptes e-mail à la fois ?

Le plugin Gmail de ChatGPT peut contenir plusieurs comptes Google. Pour un mélange de fournisseurs, ou pour Claude, il vous faut un serveur MCP qui tient toutes les boîtes : MCPEmails, Mailbox MCP, MailMCP, Mailopoly et les serveurs auto-hébergés le font tous, et l'assistant nomme la boîte à chaque appel. [Plusieurs comptes e-mail dans Claude et ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) montre comment l'assistant les distingue.

### Claude fonctionne-t-il avec un compte Outlook.com ou Hotmail personnel ?

Oui, en novembre 2026. Le centre d'aide d'Anthropic indique qu'un compte Microsoft personnel (Outlook.com, Hotmail, Live ou MSN) se connecte sur les forfaits Free, Pro, Max et Ultra sans administrateur, avec les outils d'écriture inclus. L'option n'apparaît pas sur Team et Enterprise. Un serveur MCP comme MCPEmails connecte aussi Outlook.com avec Se connecter avec Microsoft, et la même boîte fonctionne alors aussi dans ChatGPT et les autres clients.

### Ai-je besoin de mon mot de passe e-mail ?

Généralement pas du principal. Yahoo, AOL, iCloud, Gmail, Fastmail et Zoho délivrent un mot de passe d'application pour les autres applications, et une boîte chez un hébergeur utilise le mot de passe propre à la boîte. L'app IA ne le voit jamais : le serveur MCP le conserve chiffré et votre app IA se connecte au serveur avec OAuth. [Qu'est-ce qu'un mot de passe d'application ?](/blog/what-is-an-app-password) explique où chaque fournisseur le cache.

### Puis-je utiliser la même boîte dans Cursor, Codex ou un autre client MCP ?

Oui, si la boîte est derrière un serveur MCP standard. Une URL de MCPEmails, Mailbox MCP ou MailMCP fonctionne dans Claude, ChatGPT, Cursor, Codex, VS Code et les autres. Un connecteur qui vit à l'intérieur d'un assistant, comme le connecteur Gmail de Claude ou le plugin iCloud de ChatGPT, reste dans cet assistant.

### Mon courrier est-il stocké par le serveur MCP ?

Cela dépend du service, donc lisez la page de confidentialité de chacun. MCPEmails lit chaque message en direct chez votre fournisseur quand l'assistant le demande et ne le stocke pas ; seul l'identifiant chiffré est conservé, plus un message que vous programmez ou mettez en attente de validation jusqu'à son envoi. Mailopoly est une application de messagerie, donc vos comptes s'y synchronisent. Les options auto-hébergées gardent tout sur votre machine.

## Sources

Lues le 11 novembre 2026 : les articles d'aide d'Anthropic sur [les connecteurs Google Workspace](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors), [le connecteur Microsoft 365 pour les organisations](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) et [la connexion à Microsoft 365](https://support.claude.com/en/articles/15183774-connect-to-microsoft-365) ; les fiches [Gmail](https://claude.com/connectors/gmail) et [Spark](https://claude.com/connectors/spark) du répertoire de Claude ; les pages d'OpenAI sur [les apps connectées](https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt), [les apps Outlook Email et Calendar](https://help.openai.com/en/articles/12512241-outlook-email-and-calendar-apps-in-chatgpt), [les serveurs MCP personnalisés](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) et les [notes de version](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) ; [l'article MCP de Fastmail](https://www.fastmail.help/hc/en-us/articles/15869557281295) ; [Zoho Mail MCP](https://www.zoho.com/mail/help/mcp/getting-started.html) ; [Mailbox MCP](https://mailbox-mcp.com/), [MailMCP](https://mailmcp.io/en/features) et [Mailopoly](https://www.mailopoly.com/mcp/) ; [Wh1isper/mcp-email-server](https://github.com/Wh1isper/mcp-email-server) ; [Zapier MCP](https://zapier.com/mcp) et son [app Outlook](https://zapier.com/apps/mcp-client-by-zapier/integrations/microsoft-outlook) ; [Make MCP](https://www.make.com/en/mcp). Si l'un de ces éléments a changé depuis, [dites-le-nous](/help) et nous mettrons la page à jour.

## Étape suivante

[Commencez gratuitement](/signup), connectez la boîte que les connecteurs intégrés refusaient et collez une URL dans Claude ou ChatGPT. Le comparatif [connecteurs intégrés et serveurs MCP](/native-connectors-vs-mcp) approfondit l'arbitrage.`,
};

export default translation;
