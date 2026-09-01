const translation = {
  title: 'Comment connecter Gmail à Claude (en 2 minutes, sans code)',
  description:
    'Connectez Gmail à Claude via MCP en environ deux minutes : une connexion Google, une URL d\'endpoint, aucune clé API, aucun code. Claude lit, recherche et envoie vos e-mails en direct — et vos e-mails ne sont jamais stockés.',
  coverAlt: 'Comment connecter Gmail à Claude en deux minutes via MCP — une connexion Google, une URL d\'endpoint, aucun e-mail stocké',
  content: `Pour connecter Gmail à Claude, vous faites deux choses : connectez une fois votre boîte Gmail dans le tableau de bord MCP Emails, puis collez une seule URL d'endpoint dans les paramètres de connecteur de Claude et approuvez une connexion. C'est tout le travail — aucun code, aucun SDK, aucune clé API. Cela prend environ deux minutes, et Claude ne stocke jamais vos e-mails : chaque lecture et chaque envoi passe par l'API Gmail en direct et est aussitôt supprimé une fois que Claude l'a reçu.

Voici le guide ciblé, dédié uniquement à Gmail. Si vous gérez plusieurs boîtes mail ou un fournisseur autre que Gmail, le guide [connectez n'importe quel e-mail en moins de deux minutes](/blog/connect-email-to-ai-agent-under-2-minutes) couvre aussi Outlook, iCloud, Fastmail et IMAP.

## Ce dont vous aurez besoin

- Un compte **Gmail ou Google Workspace**.
- Une version de **Claude qui prend en charge les connecteurs personnalisés** — claude.ai avec un forfait payant, ou Claude Desktop. (Les connecteurs sont le moyen par lequel Claude communique avec les serveurs MCP.)
- Un compte **MCP Emails** gratuit. Aucune carte bancaire, une boîte connectée pour toujours. [Commencez gratuitement](/signup) et gardez cet onglet ouvert.

MCP Emails est le pont au milieu : il parle le Model Context Protocol avec Claude d'un côté et l'API Gmail avec Google de l'autre. Si vous voulez comprendre ce que cela signifie, consultez [ce qu'est réellement un serveur e-mail MCP](/blog/what-is-an-mcp-email-server).

## Étape 1 : connectez votre boîte Gmail

Dans le tableau de bord MCP Emails, ouvrez **Boîtes mail → Connecter une boîte mail → Gmail** et cliquez sur **Se connecter avec Google**.

1. Vous êtes redirigé vers la connexion habituelle de Google. Choisissez le compte que vous voulez que Claude utilise.
2. Approuvez l'accès en lecture et en envoi sur l'écran de consentement de Google.
3. Vous revenez au tableau de bord avec la boîte mail connectée. Terminé.

Aucun mot de passe ne change jamais de mains. MCP Emails reçoit un jeton OAuth de Google, le chiffre avec AES-256-GCM, et appelle directement l'API Gmail à chaque requête. Comme il utilise l'API propre de Gmail, les recherches de votre agent peuvent utiliser des opérateurs natifs comme \`from:\`, \`is:unread\` et \`after:\` — Claude peut donc être précis plutôt que de deviner.

> Une note en toute transparence : pendant que MCP Emails finalise l'examen de sécurité de Google, le flux de consentement peut afficher un écran « Google n'a pas validé cette application ». Pour continuer, cliquez sur **Paramètres avancés**, puis sur **Accéder à mcpemails.com**. Cet écran disparaît une fois la validation terminée.

## Étape 2 : ajoutez MCP Emails à Claude

Pointez maintenant Claude vers le même endpoint. Comme Claude est un client OAuth, vous n'avez besoin d'aucune clé API — vous collez une URL et approuvez une connexion.

1. Dans **claude.ai ou Claude Desktop**, ouvrez **Paramètres → Connecteurs**.
2. Cliquez sur **Ajouter un connecteur personnalisé**.
3. Collez ceci comme URL du connecteur, puis cliquez sur **Ajouter** :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Cliquez sur **Se connecter**, identifiez-vous avec votre compte MCP Emails, et approuvez les portées que vous souhaitez — \`read:email\`, \`send:email\`, ou les deux.

Voilà tout ce qu'il faut faire côté client. La connexion est limitée exactement à ce que vous avez approuvé, et vous pouvez la révoquer depuis le tableau de bord en un clic. Si vous préférez comprendre l'approche par clé API (pour les clients sans OAuth intégré, comme Cline ou un script personnalisé), lisez [OAuth ou clés API pour l'accès e-mail par IA](/blog/oauth-vs-api-keys-ai-email-access).

## Étape 3 : posez votre première requête à Claude

Testez avec quelque chose de simple. Demandez à Claude :

> « Résume mes trois e-mails non lus les plus récents. »

En coulisses, Claude appelle \`inbox_list\` pour découvrir votre boîte Gmail connectée, puis \`email_read\` pour lister et lire les messages. S'il répond, votre connexion est active. À partir de là, essayez :

- « Trouve la facture de Stripe du mois dernier et indique-moi le montant. »
- « Rédige une réponse polie au dernier e-mail de mon propriétaire, mais ne l'envoie pas encore. »
- « Archive toutes les newsletters reçues dans ma boîte cette semaine. »
- « À quoi me suis-je engagé dans mon fil d'e-mails avec Acme ? »

Pour un ensemble de méthodes plus approfondies — tri quotidien, résumés automatiques et routines de nettoyage — consultez [les meilleures façons de laisser Claude gérer votre boîte mail](/blog/best-ways-to-let-claude-manage-your-inbox) et le [guide de tri et de résumé](/blog/ai-agent-triage-summarize-inbox).

## Ce que Claude peut faire avec votre Gmail

Une fois connecté, Claude travaille à travers un petit ensemble d'outils consolidés, ce qui lui permet de faire bien plus que lire :

- **Lire et rechercher** — \`email_read\` (lister, lire, recherche en texte intégral avec les opérateurs Gmail).
- **Envoyer et répondre** — \`email_compose\` (envoyer, répondre, transférer) — les messages partent via Gmail comme un e-mail normal depuis votre propre adresse, votre réputation de domaine reste donc la vôtre.
- **Organiser** — \`email_organize\` (déplacer, étiqueter, marquer, archiver).
- **Brouillons, dossiers, planification, contacts** — \`draft\`, \`folder\`, \`schedule\` et \`contact_search\` complètent l'ensemble.

Une chose à anticiper d'emblée : MCP Emails fonctionne par interrogation (polling). Il n'y a pas de webhooks push, Claude réagit donc aux nouveaux e-mails lorsque vous lui demandez de vérifier, et non à l'instant où un message arrive. Pour presque tous les workflows d'assistant, c'est exactement le bon modèle.

## Est-il sûr de connecter Gmail à Claude ?

En bref : oui, et la conception est pensée pour ça.

- **Vos e-mails ne sont jamais stockés.** Les corps de messages, les objets et les pièces jointes sont récupérés en direct à chaque appel, transmis à Claude, puis aussitôt supprimés. La seule chose conservée par boîte mail est votre jeton OAuth chiffré. Voici [pourquoi « les e-mails ne sont jamais stockés » compte vraiment](/blog/why-email-never-stored-matters).
- **Vous contrôlez la portée.** Approuvez la lecture seule et Claude est littéralement incapable d'envoyer. Approuvez les deux et vous pouvez toujours révoquer l'une ou l'autre à tout moment.
- **Aucun partage de mot de passe.** Gmail utilise OAuth, donc MCP Emails ne voit jamais votre mot de passe Google, et vous pouvez aussi vous déconnecter depuis les paramètres de votre compte Google.

Le modèle de menace complet — ce qui est chiffré, ce qu'un attaquant verrait ou non — est détaillé dans [est-il sûr de donner à un agent IA un accès e-mail ?](/blog/is-it-safe-to-give-ai-agent-email-access)

## FAQ

**Ai-je besoin d'une clé API pour connecter Gmail à Claude ?**
Non. Claude prend en charge OAuth, vous collez donc l'URL de l'endpoint et approuvez une connexion. Les clés API ne sont nécessaires que pour les clients sans OAuth intégré.

**Claude stocke-t-il mes messages Gmail ?**
Non. Les e-mails sont récupérés en direct depuis l'API Gmail à chaque requête et supprimés juste après que Claude les a lus. Rien n'est conservé, à l'exception de votre jeton d'accès chiffré.

**Claude peut-il envoyer des e-mails depuis mon Gmail ?**
Oui, si vous accordez la portée \`send:email\`. Les envois passent par l'API Gmail comme des messages normaux depuis votre propre compte. Accordez la lecture seule si vous préférez que Claude n'envoie jamais.

**Est-ce que cela fonctionne avec le forfait Claude gratuit ?**
Les connecteurs personnalisés nécessitent un forfait Claude qui les prend en charge (claude.ai payant ou Claude Desktop). Côté MCP Emails, c'est gratuit et sans carte bancaire.

**MCP Emails verra-t-il mon mot de passe Google ?**
Non. La connexion Gmail utilise Google OAuth, donc votre mot de passe ne quitte jamais Google.

## Pour conclure

C'est tout : une connexion Google, une URL d'endpoint, et Claude peut lire, rechercher et envoyer vos vrais e-mails, sans jamais les stocker. Le niveau Gratuit ne coûte rien, ne nécessite aucune carte et connecte une boîte ; Personal est à 5 $/mois pour trois boîtes, et Pro connecte toutes celles que vous possédez (voir [tarifs](/pricing)).

Prêt ? [Connectez votre Gmail gratuitement](/signup), collez l'endpoint dans Claude, et demandez-lui de résumer vos e-mails non lus.`,
};

export default translation;
