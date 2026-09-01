export default {
  title: 'Serveur MCP Gmail hébergé ou auto-hébergé : avantages, inconvénients et coûts',
  description:
    'Serveur MCP Gmail hébergé ou auto-hébergé, comparés en toute franchise : les dépôts DIY gratuits offrent un contrôle total mais vous gérez OAuth, chiffrement et disponibilité. Un serveur hébergé prend quelques minutes.',
  coverAlt: 'Comparaison entre serveur MCP Gmail hébergé et auto-hébergé — MCP Emails',
  content: `Si vous voulez que votre agent IA lise et envoie des e-mails Gmail, vous avez deux vraies options : faire tourner un serveur MCP Gmail auto-hébergé à partir d'un dépôt open source, ou pointer votre client vers un serveur hébergé. La voie DIY ne coûte pas un centime et vous donne un contrôle total, mais vous gérez vous-même la configuration OAuth, le chiffrement des jetons, l'hébergement, les mises à jour et la sécurité. Un serveur hébergé comme MCP Emails se branche en quelques minutes et garde les identifiants chiffrés, au prix de faire confiance à un prestataire pour la connexion.

Voici le bilan honnête. J'ai construit un serveur hébergé, j'ai donc un parti pris, mais je vais vous dire exactement où l'auto-hébergement l'emporte et quel profil de personne devrait le choisir. Si vous voulez d'abord le modèle au niveau des verbes, le [guide complet pour donner à un agent IA l'accès à l'e-mail](/blog/how-to-give-your-ai-agent-email-access) est l'article pilier à lire en parallèle.

## Ce que « serveur MCP Gmail auto-hébergé » veut vraiment dire

Cherchez « serveur MCP Gmail » et vous trouverez une douzaine de dépôts GitHub. Vous en clonez un, enregistrez un projet Google Cloud, générez des identifiants client OAuth, lancez un flux de consentement OAuth local, et le serveur planque un jeton de rafraîchissement sur le disque ou dans une variable d'environnement. Ensuite, votre client MCP dialogue avec un processus tournant sur \`localhost\` ou sur une machine que vous louez.

C'est tout le principe, et pour un seul compte Gmail sur votre propre ordinateur portable, ça fonctionne. Le coût apparaît plus tard, et il ne se mesure pas en dollars.

## L'argument de l'auto-hébergement : là où il gagne vraiment

Je ne vais pas faire croire que le DIY est une mauvaise idée. Pour la bonne personne, c'est le bon choix.

### Vous obtenez un contrôle total et aucune confiance à accorder à un prestataire

Le code tourne sur votre matériel. Aucun tiers ne se place jamais entre votre agent et Google. Si votre modèle de menace dit « aucun service externe ne touche ma boîte mail, point final », l'auto-hébergement est la seule réponse qui le satisfait. Vous pouvez lire chaque ligne, la forker et la figer pour toujours.

### C'est gratuit en dollars

Pas d'abonnement. L'API Gmail elle-même est gratuite, quel que soit le volume qu'un agent atteindra. Si votre temps vaut peu face à 5 $/mois (ou 15 $/mois dès qu'il vous faut des boîtes illimitées), le calcul penche pour la solution maison.

### Vous pouvez l'adapter à tout

Outils personnalisés, dossiers IMAP bizarres, une taxonomie de libellés privée, un pipeline de logs qui alimente votre SIEM. Quand vous possédez le processus, vous pouvez tout faire. Un produit hébergé vous donne la surface qu'il vous donne.

## L'argument de l'auto-hébergement : là où il vous coûte vraiment

Maintenant, la partie que les READMEs des dépôts passent sous silence.

### Vous gérez la configuration OAuth

Un projet Google Cloud, un écran de consentement OAuth, les bons scopes, et — si vous voulez que quelqu'un d'autre que vous l'utilise — le processus de vérification d'application de Google, qui est un véritable examen avec un véritable délai de traitement. Trompez-vous sur un scope et vous voilà de retour dans la console. C'est l'étape qui engloutit un après-midi la première fois, et une bouchée plus petite chaque fois qu'un jeton expire ou que Google change une règle.

### Vous gérez le stockage et le chiffrement des identifiants

Voilà ce qui m'empêche de dormir. Un jeton de rafraîchissement pour \`read:email\` et \`send:email\` est une clé maîtresse de la boîte mail de quelqu'un. La plupart des montages DIY le déposent dans un fichier en clair ou une variable d'environnement. Si cette machine est compromise, ou si le jeton fuit dans un log ou une sauvegarde, l'attaquant lit et envoie des e-mails en votre nom.

Le faire correctement, c'est chiffrer le jeton au repos, garder la clé de chiffrement séparée du dépôt de jetons, et ne déchiffrer qu'au moment de l'appel dans un contexte isolé. Ce n'est pas difficile à décrire et c'est vraiment pénible à construire et à maintenir. Si vous l'esquivez, vous avez construit un risque. [Pourquoi « l'e-mail n'est jamais stocké » compte](/blog/why-email-never-stored-matters) approfondit le volet architecture de tout cela.

### Vous gérez l'hébergement et la disponibilité

Un serveur localhost meurt quand votre ordinateur portable se met en veille. Si vous voulez que l'agent trie le courrier à 6 h du matin ou tourne sans surveillance, il vous faut un processus toujours actif — un VPS, un conteneur, une politique de redémarrage, du TLS, de la supervision. C'est du travail d'ops, et ça ne cesse jamais d'être du travail d'ops.

### Vous gérez les mises à jour et les correctifs de sécurité

MCP est jeune. La spécification évolue, Google fait tourner ses exigences, et le dépôt que vous avez cloné peut devenir obsolète ou être abandonné. Quand une dépendance livre une CVE, c'est votre bipeur qui sonne. Figez une version et vous prenez du retard ; suivez \`main\` et vous héritez des bugs des autres.

### Le multi-fournisseur, c'est pour votre pomme

Le dépôt que vous avez choisi gère Gmail. Le jour où vous ajoutez un compte Outlook ou une adresse iCloud, vous intégrez Microsoft Graph ou câblez vous-même IMAP et SMTP, avec un deuxième modèle d'authentification et un deuxième lot de cas particuliers. La plupart des serveurs DIY restent Gmail uniquement parce que le deuxième fournisseur est un projet à part entière.

## L'argument de l'hébergé : MCP Emails, en toute franchise

Un serveur MCP hébergé inverse le compromis. Vous renoncez à faire tourner le code ; vous récupérez tout le temps que la liste ci-dessus vous aurait coûté.

### L'installation prend des minutes, pas un après-midi

Vous créez un compte, allez dans **Dashboard → Inboxes → Connect Inbox**, choisissez Gmail et cliquez à travers l'OAuth en un clic de Google. Pas de projet Cloud, pas d'écran de consentement, pas de file d'attente de vérification. Ensuite, vous connectez votre agent. Pour [claude.ai ou Claude Desktop](/blog/connect-email-to-ai-agent-under-2-minutes), vous collez l'URL du point de terminaison MCP, vous vous connectez et approuvez les scopes — aucune clé API. Pour un client sans OAuth, comme [Cursor, Cline ou un script brut](/blog/email-for-ai-agents-cursor-cline-vscode), vous générez une clé API à portée limitée dans **Dashboard → API Keys** et l'envoyez comme jeton bearer.

### Les identifiants sont chiffrés et l'e-mail n'est jamais stocké

Le jeton OAuth est la seule chose conservée par boîte de réception, et il est chiffré avec AES-256-GCM au repos. La clé vit comme un secret d'environnement, séparée de la base de données, et le déchiffrement n'a lieu qu'à l'intérieur d'une Edge Function isolée au moment de l'appel. L'e-mail lui-même n'est jamais stocké : chaque appel \`email_read\` (que ce soit pour lister, lire ou rechercher) interroge Gmail en direct, transmet le résultat à votre agent et le jette. C'est le travail de chiffrement de la section auto-hébergement, fait et maintenu. [Est-il sûr de donner à un agent IA l'accès à l'e-mail](/blog/is-it-safe-to-give-ai-agent-email-access) détaille tout le modèle de sécurité.

### Le multi-fournisseur est offert

Le même point de terminaison et les mêmes outils principaux — \`inbox_list\`, \`email_read\`, \`email_compose\`, \`email_organize\` pour les drapeaux et les dossiers, plus \`folder\`, \`draft\`, \`schedule\` et \`contact_search\` — fonctionnent avec Gmail, Outlook, iCloud, Fastmail et n'importe quelle boîte IMAP. Ajoutez un compte Outlook la semaine prochaine et rien ne change pour votre agent.

### L'envoi reste sur votre fournisseur

MCP Emails ne relaie jamais le courrier depuis son propre domaine. \`email_compose\` (avec l'action \`send\`) part via votre Gmail (ou Microsoft Graph, ou votre propre SMTP), de sorte que la réputation de votre domaine et votre délivrabilité restent les vôtres. C'est la même propriété que vous obtiendriez en auto-hébergeant, sans avoir à la construire.

### Le coût honnête : vous faites confiance à un prestataire

C'est le vrai compromis, et je ne vais pas l'enjoliver. Avec un serveur hébergé, votre jeton chiffré se trouve dans la base de données de quelqu'un d'autre et les appels de votre agent transitent par le code de quelqu'un d'autre. Vous faites confiance au fait que le chiffrement est réel, que l'isolation tient, et que l'entreprise ne fait pas une bêtise. Pour la plupart des gens, cette confiance est bien placée et fait gagner énormément de temps. Si votre modèle de menace l'interdit catégoriquement, auto-hébergez — c'est la raison légitime de le faire.

## Ce que ça coûte en dollars

MCP Emails est gratuit pour démarrer : une boîte connectée, des clés API illimitées, sans carte bancaire. L'offre Gratuit tourne à 60 requêtes/minute avec 7 jours d'analytics et un support communautaire. [Personal est à 5 $/mois](/pricing) (jusqu'à trois boîtes connectées, 120 req/min, 30 jours d'analytics, support par e-mail), Pro est à 15 $/mois (boîtes connectées illimitées, 300 req/min, 90 jours d'analytics), et Team est à 79 $/mois (membres avec rôles, un espace de travail distinct par client, SSO et journaux d'audit). L'auto-hébergement, c'est 0 $ d'abonnement plus le coût de votre VPS et de vos heures. Soyez honnête sur les heures.

## Alors, lequel choisir ?

Choisissez **l'auto-hébergé** si vous êtes un ingénieur qui aime la plomberie, que vous avez besoin d'un contrôle total ou d'une règle interdisant les tiers, que vous êtes à l'aise pour gérer OAuth, le chiffrement et la disponibilité, et que vous ne toucherez jamais qu'un seul compte Gmail. C'est un choix réel et défendable.

Choisissez **l'hébergé** si vous voulez un point de terminaison fonctionnel dès aujourd'hui, que vous préférez ne pas être d'astreinte pour votre propre infrastructure e-mail, que vous ajouterez probablement Outlook, iCloud ou une boîte IMAP à un moment donné, et que vous voulez que le chiffrement des identifiants soit pris en charge par des gens qui le maintiennent à plein temps. C'est le cas de la plupart des gens, y compris la plupart des ingénieurs qui pourraient le construire mais ont mieux à faire.

Si vous hésitez encore sur la manière dont un agent devrait atteindre votre boîte mail, [les meilleures façons de laisser Claude gérer votre boîte de réception](/blog/best-ways-to-let-claude-manage-your-inbox) compare les options plus larges. Quand vous êtes prêt, [commencez gratuitement](/signup) ou parcourez [la documentation](/docs) — connecter une boîte Gmail prend vraiment environ une minute.`,
};
