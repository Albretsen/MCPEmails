export default {
  title: 'Connecter Outlook et Microsoft 365 à votre agent IA via MCP',
  description:
    'Connectez Outlook ou Microsoft 365 à votre agent IA via MCP en quelques minutes. OAuth de connexion Microsoft, Graph en coulisses, lire/chercher/envoyer/répondre — sans serveur sur mesure.',
  coverAlt: 'Connecter Outlook et Microsoft 365 à un agent IA via MCP',
  content: `> **Bientôt disponible.** La prise en charge d'Outlook et de Microsoft 365 est développée mais pas encore disponible pour tous. Vous ne pouvez pas connecter une boîte Outlook en production aujourd'hui — ce guide présente le fonctionnement à venir une fois le connecteur lancé. Pour les boîtes que vous pouvez connecter dès maintenant, voir [Gmail et IMAP](/docs/providers).

Pour connecter une boîte Outlook ou Microsoft 365 à votre agent IA, vous vous connectez à MCP Emails, ajoutez la boîte avec l'OAuth Microsoft et pointez votre agent vers un seul endpoint MCP. Aucune inscription d'application, aucun portail Azure, aucun serveur Graph sur mesure. L'ensemble prend environ deux minutes, et votre agent obtient la lecture, la recherche, l'envoi, la réponse, les indicateurs et les dossiers sur la boîte en temps réel.

La plupart des guides « l'IA pour l'e-mail » supposent Gmail et s'arrêtent là. Outlook a droit à un haussement d'épaules et à un lien vers un dépôt GitHub à moitié maintenu. Si vous vivez dans Microsoft 365 au travail, c'est prendre le problème par le mauvais bout. Cet article est la version Outlook d'abord : ce qui fonctionne vraiment, comment se déroule la connexion Microsoft, ce qui tourne en dessous et où se situent les limites entre comptes personnels et professionnels.

## Pourquoi Outlook est plus difficile qu'il n'y paraît (et pourquoi ce n'est pas votre problème ici)

L'e-mail Microsoft, ce n'est pas une seule chose. Il y a l'Outlook.com / Hotmail / Live grand public, et il y a les comptes professionnels et scolaires Microsoft 365 hébergés dans Entra ID (le service d'identité autrefois appelé Azure AD). Ils s'authentifient différemment, et un tenant professionnel peut empiler par-dessus des stratégies d'accès conditionnel, des exigences de consentement administrateur et des règles MFA.

La voie du « fait maison » implique d'enregistrer une application dans le portail Azure / Entra, de choisir les bons types de comptes pris en charge, de demander des scopes Microsoft Graph comme \`Mail.Read\` et \`Mail.Send\`, de câbler une URI de redirection, de gérer le renouvellement des jetons, puis d'écrire les appels Graph pour lister, lire et envoyer des e-mails. Les gens y brûlent un après-midi et finissent par maintenir un petit serveur pour toujours. Je l'ai vu arriver.

MCP Emails se charge de cet enregistrement et de cette plomberie de jetons une seule fois, de façon centralisée, pour que vous n'ayez pas à le faire. Vous cliquez sur « se connecter avec Microsoft », vous approuvez, et vous êtes connecté. Si vous voulez le contexte conceptuel sur la raison d'être de cette couche, le [guide complet pour donner à votre agent IA un accès à l'e-mail](/blog/how-to-give-your-ai-agent-email-access) est le pilier par lequel commencer.

## Connectez votre boîte Outlook / Microsoft 365

Deux parties : connecter la boîte, puis connecter l'agent. Elles sont séparées à dessein — la connexion de la boîte autorise MCP Emails à atteindre votre fournisseur, et la connexion de l'agent autorise votre client à atteindre MCP Emails.

### Étape 1 — Ajouter la boîte

1. [Commencez gratuitement](/signup) et ouvrez le tableau de bord.
2. Allez dans **Inboxes → Connect Inbox**.
3. Choisissez **Outlook / Microsoft 365**.
4. Vous êtes redirigé vers la page de connexion de Microsoft. Saisissez votre compte Microsoft professionnel ou personnel, effectuez la MFA si votre tenant l'exige, et examinez l'écran de consentement.
5. Approuvez. Microsoft renvoie un jeton OAuth, MCP Emails le chiffre (AES-256-GCM) et ne stocke que ce jeton. Rien d'autre concernant votre boîte n'est conservé.

C'est OAuth 2.0 — le même modèle que Gmail utilise. Vous ne collez jamais de mot de passe Outlook dans MCP Emails, et il n'y a pas de mot de passe d'application à générer. C'est la différence essentielle avec les fournisseurs IMAP ; si vous connectez [iCloud, Fastmail ou une boîte IMAP générique](/blog/connect-icloud-fastmail-imap-to-claude), ceux-ci utilisent à la place un mot de passe spécifique à l'application, car ils n'offrent pas d'OAuth pour les clients tiers.

### Étape 2 — Connectez votre agent

Vous connectez un client une fois, et la même configuration fonctionne pour chaque boîte de votre compte. Pour les clients compatibles OAuth (claude.ai, Claude Desktop, Cursor), dans claude.ai cela donne :

**Customize → Connectors → Add connector → collez l'URL → Connect → connectez-vous et approuvez.**

L'endpoint est :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Quand vous cliquez sur Connect, vous vous connectez à votre compte MCP Emails et approuvez les scopes — \`read:email\`, \`send:email\`, ou les deux. Aucune clé d'API ne change de mains ; cela utilise OAuth 2.0 Authorization Code avec PKCE et l'enregistrement dynamique de client en coulisses.

Pour les clients qui ne parlent pas OAuth (Cline, plugins JetBrains, vos propres scripts, du cURL brut), générez une clé à portée limitée dans **Dashboard → API Keys**, choisissez les scopes, et envoyez-la sous la forme \`Authorization: Bearer <api-key>\`. Le tutoriel complet pour ces clients se trouve dans [l'e-mail pour les agents IA dans Cursor, Cline et VS Code](/blog/email-for-ai-agents-cursor-cline-vscode). Si vous hésitez entre les deux approches, [OAuth vs clés d'API pour l'accès à l'e-mail par l'IA](/blog/oauth-vs-api-keys-ai-email-access) expose les compromis.

## Microsoft Graph, en coulisses

Une fois connecté, chaque appel d'outil que fait votre agent part vers Microsoft Graph en temps réel. Lisez un message, et MCP Emails appelle Graph, transmet le résultat analysé à votre agent, puis le supprime. Envoyez un message, et il passe par Graph en votre nom — depuis votre véritable adresse, à travers l'infrastructure de Microsoft, pour que la délivrabilité et la réputation de votre domaine restent les vôtres. MCP Emails ne relaie jamais d'e-mail depuis son propre domaine.

La conséquence pratique : l'e-mail que votre agent envoie ressemble exactement à un e-mail que vous avez envoyé, parce que c'en est un. Il atterrit dans vos Éléments envoyés. Les réponses s'enchaînent correctement dans le fil parce que l'outil de réponse définit pour vous les en-têtes In-Reply-To et References.

## Comptes personnels vs professionnels/scolaires

Les deux fonctionnent. Un compte Outlook.com grand public et un compte professionnel/scolaire Microsoft 365 se connectent tous deux via la même connexion Microsoft, et tous deux exposent les mêmes outils à votre agent.

Le seul endroit où la réalité s'impose, c'est l'écran de consentement sur les comptes professionnels/scolaires. Si votre administrateur informatique a verrouillé le consentement aux applications tierces dans votre tenant — ce que font bon nombre de grandes organisations — vous pourriez voir « approbation requise » au lieu d'une invite de consentement normale, et la connexion attend l'aval d'un administrateur. Ce n'est pas une limitation de MCP Emails ; c'est la stratégie de votre tenant, et elle bloquerait n'importe quel client tiers de la même façon. Pour un compte personnel, ou un tenant qui autorise le consentement utilisateur, vous l'approuvez vous-même et c'est terminé.

## Ce qui fonctionne une fois connecté

Votre agent obtient les six outils principaux, plus les extras qu'Outlook prend en charge :

- \`list_inboxes\` — appelez toujours celui-ci en premier. Il renvoie vos boîtes connectées et leurs UUID \`inbox_id\`, pour que l'agent ne devine jamais un identifiant.
- \`list_messages\` — du plus récent au plus ancien, paginé, avec des filtres comme \`unread_only\`.
- \`read_email\` — texte brut analysé, HTML assaini en option, pièces jointes en option.
- \`search_emails\` — voir la note sur la recherche ci-dessous.
- \`send_email\` — composez avec CC/BCC, HTML et pièces jointes jusqu'à 10 MB au total.
- \`reply_to_email\` — répond dans le fil avec les bons en-têtes de threading.

Au-delà des six, Outlook prend en charge le marquage lu/non lu, les indicateurs (le « flag » d'Outlook correspond à la notion d'étoilé/marqué), le transfert et le déplacement entre dossiers. Consultez les [docs](/docs) en ligne pour la liste des capacités actuelles avant de bâtir quoi que ce soit autour d'un outil précis.

### La recherche utilise le \`$search\` de Microsoft

La recherche Outlook n'est pas la recherche Gmail. Là où Gmail accepte des opérateurs comme \`from:\` et \`is:unread\`, \`search_emails\` sur une boîte Outlook transmet votre requête au \`$search\` de Microsoft Graph, qui effectue une correspondance plein texte classée par pertinence dans toute la boîte et accepte aussi le KQL. Ainsi une requête comme \`facture de la comptabilité la semaine dernière\` fonctionne en langage naturel, et vous pouvez être plus précis avec du KQL comme \`from:finance@acme.com AND subject:invoice\`. Si vous écrivez des prompts qui codent en dur des opérateurs Gmail, ils ne se comporteront pas de la même manière sur Outlook — dites à votre agent de chercher en langage clair et laissez Graph classer.

## Un workflow qui vaut la peine d'être mis en place

Voici une boucle de tri que je fais tourner sur une boîte Microsoft 365. Une ou deux fois par heure, l'agent :

1. Appelle \`list_messages\` avec \`unread_only: true\`.
2. Lit tout ce qui semble sensible au temps avec \`read_email\`.
3. Résume le lot et rédige des brouillons de réponse pour ceux auxquels je répondrais à l'évidence.
4. Laisse tout en non lu jusqu'à ce que je confirme.

Une réserve honnête : MCP Emails fonctionne par interrogation (polling). Il n'y a pas de webhooks ni de push serveur, l'agent vérifie donc selon un calendrier plutôt que d'être averti à l'instant où le courrier arrive. Pour le tri, c'est parfait — c'est vous qui réglez la cadence. Si vous construisez quelque chose de plus réactif, lisez [comment trier et résumer une boîte de réception](/blog/ai-agent-triage-summarize-inbox) pour les schémas d'interrogation qui tiennent la route.

## Comparé à la création de votre propre serveur M365

Les serveurs MCP Outlook auto-hébergés qui circulent sur GitHub se heurtent tous au même mur : l'enregistrement d'application Entra et le cycle de vie des jetons Graph sont le vrai travail, et vous en êtes propriétaire pour toujours. Vous gérez les jetons de renouvellement, les changements de scopes quand Microsoft ajuste Graph, et la sécurité de l'endroit où ces jetons résident. Avec l'approche hébergée, le jeton est chiffré au repos, déchiffré uniquement à l'intérieur d'une fonction isolée au moment de l'appel, et révocable depuis le tableau de bord en un clic. Si vous voulez la comparaison complète, [hébergé vs auto-hébergé](/blog/hosted-vs-self-hosted-gmail-mcp-server) approfondit les compromis.

Connecter Outlook ne coûte rien à essayer — le [plan Free](/pricing) offre des boîtes et des appels d'outils illimités à 60 requêtes par minute, sans carte requise. Ajoutez votre boîte Microsoft 365, pointez Claude vers l'endpoint, et donnez-lui quelque chose à lire.`,
};
