const translation = {
  title: 'Comment connecter Gmail à Claude (en 2 minutes, sans code)',
  description:
    'Connectez Gmail à Claude via MCP en environ deux minutes : un mot de passe d\'application Google (ou la connexion avec Google), une URL d\'endpoint, aucune clé API, aucun code. Claude lit, recherche et envoie vos e-mails en direct, et vos e-mails ne sont jamais stockés.',
  coverAlt: 'Comment connecter Gmail à Claude en deux minutes via MCP : un mot de passe d\'application Google, une URL d\'endpoint, aucun e-mail stocké',
  content: `Pour connecter Gmail à Claude, vous faites deux choses : connectez une fois votre boîte Gmail dans le tableau de bord MCP Emails avec un mot de passe d'application Google, puis collez une seule URL d'endpoint dans les paramètres de connecteur de Claude et approuvez une connexion. C'est tout le travail : aucun code, aucun SDK, aucune clé API. Cela prend environ deux minutes, et Claude ne stocke jamais vos e-mails : chaque lecture et chaque envoi passe par Gmail en direct et est aussitôt supprimé une fois que Claude l'a reçu.

Voici le guide ciblé, dédié uniquement à Gmail. Si vous gérez plusieurs boîtes mail ou un fournisseur autre que Gmail, le guide [connectez n'importe quel e-mail en moins de deux minutes](/blog/connect-email-to-ai-agent-under-2-minutes) couvre aussi Outlook, iCloud, Fastmail et IMAP.

## Ce dont vous aurez besoin

- Un compte **Gmail ou Google Workspace**.
- Une version de **Claude qui prend en charge les connecteurs personnalisés** : claude.ai avec un forfait payant, ou Claude Desktop. (Les connecteurs sont le moyen par lequel Claude communique avec les serveurs MCP.)
- Un compte **MCP Emails** gratuit. Aucune carte bancaire, une boîte connectée pour toujours. [Commencez gratuitement](/signup) et gardez cet onglet ouvert.

MCP Emails est le pont au milieu : il parle le Model Context Protocol avec Claude d'un côté et communique avec Gmail de l'autre, en IMAP par défaut ou via l'API Gmail si vous vous connectez avec Google. Si vous voulez comprendre ce que cela signifie, consultez [ce qu'est réellement un serveur e-mail MCP](/blog/what-is-an-mcp-email-server).

## Étape 1 : connectez votre boîte Gmail

Dans le tableau de bord MCP Emails, ouvrez **Boîtes mail → Connecter une boîte mail** et choisissez **Gmail**. Par défaut, Gmail se connecte avec un mot de passe d'application Google :

1. Activez la validation en deux étapes sur votre compte Google si ce n'est pas déjà fait. Google ne propose les mots de passe d'application que sur les comptes qui l'ont activée.
2. Rendez-vous sur **myaccount.google.com/apppasswords** et créez-en un. Il compte 16 lettres minuscules en quatre groupes, et les espaces n'ont pas d'importance.
3. De retour dans MCP Emails, saisissez votre adresse Gmail complète, collez le mot de passe d'application et cliquez sur **Connecter la boîte**. La connexion est testée auprès de Gmail avant d'être enregistrée. Terminé.

Votre mot de passe Google habituel n'est jamais utilisé. Le mot de passe d'application est un identifiant distinct, MCP Emails le chiffre avec AES-256-GCM, et vous pouvez le révoquer à tout moment depuis la même page Google. En coulisses, la boîte se connecte en IMAP et SMTP (\`imap.gmail.com\`).

### Vous préférez vous connecter avec Google ?

La fenêtre de connexion propose aussi une seconde voie : ouvrez **Vous préférez vous connecter avec Google ?** et cliquez sur **Se connecter avec Google**. Vous choisissez votre compte sur la page de Google et approuvez l'accès en lecture et en envoi. Google affiche d'abord un écran d'avertissement, car Google n'a pas validé l'application. Pour continuer, cliquez sur **Paramètres avancés**, puis sur **Accéder à mcpemails.com**.

### Quelle voie choisir

Les deux voies continuent de fonctionner, et le choix décide de ce que Claude pourra faire ensuite :

- **Mot de passe d'application (IMAP) :** les libellés Gmail apparaissent comme des dossiers, la recherche utilise la recherche texte IMAP, et Claude peut copier des messages et les supprimer définitivement.
- **Connexion avec Google (API Gmail) :** Claude travaille avec de vrais libellés Gmail et peut rechercher avec les opérateurs Gmail comme \`from:\`, \`is:unread\` et \`after:\`. La suppression envoie les e-mails dans la corbeille.

Sur un compte Google Workspace, un administrateur peut désactiver les mots de passe d'application pour tout le domaine, ou bloquer les applications tierces sur la voie de connexion avec Google. Si une voie est bloquée, essayez l'autre, ou demandez à votre administrateur.

## Étape 2 : ajoutez MCP Emails à Claude

Pointez maintenant Claude vers le même endpoint. Comme Claude est un client OAuth, vous n'avez besoin d'aucune clé API : vous collez une URL et approuvez une connexion.

1. Dans **claude.ai ou Claude Desktop**, ouvrez **Paramètres → Connecteurs**.
2. Cliquez sur **Ajouter un connecteur personnalisé**.
3. Collez ceci comme URL du connecteur, puis cliquez sur **Ajouter** :

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Cliquez sur **Se connecter**, identifiez-vous avec votre compte MCP Emails, et approuvez les portées que vous souhaitez : \`read:email\`, \`send:email\`, ou les deux.

Voilà tout ce qu'il faut faire côté client. La connexion est limitée exactement à ce que vous avez approuvé, et vous pouvez la révoquer depuis le tableau de bord en un clic. Si vous préférez comprendre l'approche par clé API (pour les clients sans OAuth intégré, comme Cline ou un script personnalisé), lisez [OAuth ou clés API pour l'accès e-mail par IA](/blog/oauth-vs-api-keys-ai-email-access).

## Étape 3 : posez votre première requête à Claude

Testez avec quelque chose de simple. Demandez à Claude :

> « Résume mes trois e-mails non lus les plus récents. »

En coulisses, Claude appelle \`inbox_list\` pour découvrir votre boîte Gmail connectée, puis \`email_read\` pour lister et lire les messages. S'il répond, votre connexion est active. À partir de là, essayez :

- « Trouve la facture de Stripe du mois dernier et indique-moi le montant. »
- « Rédige une réponse polie au dernier e-mail de mon propriétaire, mais ne l'envoie pas encore. »
- « Archive toutes les newsletters reçues dans ma boîte cette semaine. »
- « À quoi me suis-je engagé dans mon fil d'e-mails avec Acme ? »

Pour un ensemble de méthodes plus approfondies (tri quotidien, résumés automatiques et routines de nettoyage), consultez [les meilleures façons de laisser Claude gérer votre boîte mail](/blog/best-ways-to-let-claude-manage-your-inbox) et le [guide de tri et de résumé](/blog/ai-agent-triage-summarize-inbox).

## Ce que Claude peut faire avec votre Gmail

Une fois connecté, Claude travaille à travers un petit ensemble d'outils consolidés, ce qui lui permet de faire bien plus que lire :

- **Lire et rechercher :** \`email_read\` (lister, lire, recherche en texte intégral, avec les opérateurs Gmail si vous vous êtes connecté avec Google).
- **Envoyer et répondre :** \`email_compose\` (envoyer, répondre, transférer). Les messages partent via Gmail comme un e-mail normal depuis votre propre adresse, votre réputation de domaine reste donc la vôtre.
- **Organiser :** \`email_organize\` (déplacer, marquer, archiver, et les libellés sur la voie de connexion avec Google).
- **Brouillons, dossiers, planification, contacts :** \`draft\`, \`folder\`, \`schedule\` et \`contact_search\` complètent l'ensemble.

Une chose à anticiper d'emblée : MCP Emails fonctionne par interrogation (polling). Il n'y a pas de webhooks push, Claude réagit donc aux nouveaux e-mails lorsque vous lui demandez de vérifier, et non à l'instant où un message arrive. Pour presque tous les workflows d'assistant, c'est exactement le bon modèle.

## Est-il sûr de connecter Gmail à Claude ?

En bref : oui, et la conception est pensée pour ça.

- **Vos e-mails ne sont jamais stockés.** Les corps de messages, les objets et les pièces jointes sont récupérés en direct à chaque appel, transmis à Claude, puis aussitôt supprimés. La seule chose conservée par boîte mail est l'identifiant chiffré : votre mot de passe d'application, ou le jeton OAuth si vous vous êtes connecté avec Google. Voici [pourquoi « les e-mails ne sont jamais stockés » compte vraiment](/blog/why-email-never-stored-matters).
- **Vous contrôlez la portée.** Approuvez la lecture seule et Claude est littéralement incapable d'envoyer. Approuvez les deux et vous pouvez toujours révoquer l'une ou l'autre à tout moment.
- **Aucun partage de mot de passe.** Votre mot de passe Google habituel n'arrive jamais chez MCP Emails. Un mot de passe d'application est un identifiant distinct que vous pouvez révoquer sur myaccount.google.com/apppasswords, la connexion avec Google passe par OAuth, et dans les deux cas vous pouvez déconnecter la boîte depuis le tableau de bord.

Le modèle de menace complet (ce qui est chiffré, ce qu'un attaquant verrait ou non) est détaillé dans [est-il sûr de donner à un agent IA un accès e-mail ?](/blog/is-it-safe-to-give-ai-agent-email-access)

## FAQ

**Ai-je besoin d'une clé API pour connecter Gmail à Claude ?**
Non. Claude prend en charge OAuth, vous collez donc l'URL de l'endpoint et approuvez une connexion. Les clés API ne sont nécessaires que pour les clients sans OAuth intégré.

**Claude stocke-t-il mes messages Gmail ?**
Non. Les e-mails sont récupérés en direct depuis Gmail à chaque requête et supprimés juste après que Claude les a lus. Rien n'est conservé, à l'exception de votre identifiant chiffré (le mot de passe d'application, ou le jeton d'accès si vous vous êtes connecté avec Google).

**Claude peut-il envoyer des e-mails depuis mon Gmail ?**
Oui, si vous accordez la portée \`send:email\`. Les envois partent via Gmail comme des messages normaux depuis votre propre compte. Accordez la lecture seule si vous préférez que Claude n'envoie jamais.

**Est-ce que cela fonctionne avec le forfait Claude gratuit ?**
Les connecteurs personnalisés nécessitent un forfait Claude qui les prend en charge (claude.ai payant ou Claude Desktop). Côté MCP Emails, c'est gratuit et sans carte bancaire.

**MCP Emails verra-t-il mon mot de passe Google ?**
Non. Vous collez un mot de passe d'application, un identifiant distinct généré par Google et révocable, ou vous vous connectez avec Google via OAuth. Votre mot de passe Google habituel n'est jamais saisi nulle part dans MCP Emails.

## Pour conclure

C'est tout : un mot de passe d'application Google, une URL d'endpoint, et Claude peut lire, rechercher et envoyer vos vrais e-mails, sans jamais les stocker. Le niveau Gratuit ne coûte rien, ne nécessite aucune carte et connecte une boîte ; Personal est à 5 $/mois pour trois boîtes, et Pro connecte toutes celles que vous possédez (voir [tarifs](/pricing)).

Prêt ? [Connectez votre Gmail gratuitement](/signup), collez l'endpoint dans Claude, et demandez-lui de résumer vos e-mails non lus.`,
};

export default translation;
