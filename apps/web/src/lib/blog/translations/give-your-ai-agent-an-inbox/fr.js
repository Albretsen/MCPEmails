const translation = {
  title: 'Donnez une boîte mail à votre agent IA : guide pratique de l’email via MCP',
  description:
    'Pourquoi connecter l’email à votre agent IA est plus difficile qu’il n’y paraît, et comment le Model Context Protocol fait de Gmail, Outlook et IMAP un point d’accès unique et sécurisé que votre agent peut vraiment utiliser.',
  coverAlt: 'Donnez une boîte mail à votre agent IA — MCPEmails',
  content: `La plupart des démos d’« email géré par l’IA » s’arrêtent à une capture d’écran. L’agent rédige une réponse, tout le monde applaudit, et personne ne pose la question qui dérange : **comment le modèle atteint-il réellement une vraie boîte mail** — de façon sécurisée, tous fournisseurs confondus, sans que vous colliez un mot de passe d’application dans un prompt ?

Cet article explique pourquoi ce dernier kilomètre est trompeusement difficile, et comment le [Model Context Protocol](https://modelcontextprotocol.io) (MCP) transforme Gmail, Outlook, Fastmail et l’IMAP générique en un point d’accès unique que votre agent peut appeler comme n’importe quel autre outil.

## Le problème du « donne-lui juste mon email »

L’email a l’air d’un problème résolu. Il ne l’est pas — du moins pas pour un agent autonome. Trois obstacles se dressent :

1. **L’authentification dépend du fournisseur.** Gmail veut OAuth avec les bons scopes. Outlook veut une identité Microsoft. Fastmail veut un mot de passe d’application. Chacun a son propre cycle de vie de jeton et ses propres modes de défaillance.
2. **Les identifiants sont radioactifs.** Vous ne voulez pas qu’un mot de passe de boîte mail traîne dans une transcription de chat, une ligne de log ou un magasin de vecteurs. Jamais.
3. **La « forme » de l’email est désordonnée.** MIME, threads, HTML contre texte brut, pièces jointes, dossiers qui sont en réalité des libellés. Un agent a besoin d’une interface propre et prévisible — pas de RFC 5322 brut.

La solution naïve — confier au modèle une bibliothèque IMAP et votre mot de passe — échoue sur les trois fronts à la fois.

## Ce que MCP change vraiment

MCP est une façon standard d’exposer des **outils** et des **ressources** à un modèle de langage. Au lieu d’apprendre à chaque agent à parler IMAP, vous exécutez un seul serveur qui présente l’email sous la forme d’un petit ensemble d’outils bien typés :

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose"
  ]
}
\`\`\`

L’agent ne voit jamais de mot de passe. Il voit des verbes. C’est ce simple basculement qui rend l’automatisation de l’email sûre.

> Les meilleures intégrations d’agents sont volontairement ennuyeuses : un verbe stable, une réponse prévisible, et aucun secret dans le prompt.

### La découverte avant l’action

Un bon outil d’email est **sans état du point de vue de l’agent**. L’agent ne devrait pas coder en dur l’UUID d’une boîte mail. Il appelle plutôt \`inbox_list\` en premier, découvre ce qui est disponible, puis agit :

- \`inbox_list\` → renvoie les comptes connectés et leurs capacités
- \`email_read\` (action \`list\`) → paginé, du plus récent au plus ancien, par boîte mail
- \`email_read\` (action \`read\`) → le corps analysé, l’expéditeur et les métadonnées d’un message
- \`email_compose\` (action \`send\`) → rédige et envoie, le fournisseur étant choisi pour vous

Ce modèle « découverte d’abord » fait toute la différence entre une démo et quelque chose à qui vous feriez confiance un mardi après-midi.

## Une démonstration concrète

Imaginez que vous vouliez que Claude trie votre boîte de réception du matin. Avec l’email exposé via MCP, la conversation ressemble à ceci :

1. L’agent appelle \`inbox_list\` et trouve votre Gmail professionnel.
2. Il appelle \`email_read\` (action \`list\`) pour les dernières 24 heures.
3. Pour tout ce qui semble urgent, il appelle \`email_read\` (action \`read\`) afin d’obtenir le corps complet.
4. Il rédige des réponses et appelle \`email_compose\` (action \`reply\`) — ou se contente de résumer et attend votre feu vert.

Aucun mot de passe n’a circulé. Aucun code propre à un fournisseur n’a vécu dans votre prompt. L’agent a raisonné sur des verbes et a fait du vrai travail.

## La sécurité est la fonctionnalité

La raison pour laquelle cela fonctionne, c’est que les parties ennuyeuses sont gérées là où elles doivent l’être — sur le serveur, pas dans le modèle :

- **Les jetons OAuth sont chiffrés au repos** et ne sont jamais renvoyés au client.
- **Les scopes sont minimaux** : lecture et envoi, rien de plus.
- **L’agent s’authentifie auprès du serveur**, le serveur s’authentifie auprès du fournisseur. Deux sauts, un seul coffre à secrets.

Si vous ne retenez qu’une chose de cet article, retenez ceci : *le modèle doit détenir des capacités, jamais des identifiants.*

## Pour aller plus loin

Connecter une boîte mail devrait prendre quelques minutes, pas un après-midi à déboguer OAuth. Si vous voulez essayer le flux « découverte d’abord » ci-dessus, le [guide de démarrage rapide](/docs#quickstart) vous mène de zéro à un point d’accès actif, et la [matrice des fournisseurs](/docs/providers) montre exactement quelles fonctionnalités s’activent pour Gmail, Outlook, Fastmail et compagnie.

Donnez des verbes à votre agent, pas des mots de passe — et laissez-le se mettre au travail.`,
};

export default translation;
