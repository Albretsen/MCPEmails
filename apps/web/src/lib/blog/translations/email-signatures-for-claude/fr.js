const translation = {
  title: 'Signatures e-mail : Claude signe chaque envoi automatiquement',
  description:
    'Définissez votre signature une fois par boîte et Claude l\'ajoute automatiquement à chaque e-mail envoyé, sur Gmail, Outlook, Fastmail, iCloud et tout compte IMAP.',
  coverAlt:
    'Signatures e-mail pour Claude : définissez une signature par boîte une seule fois et Claude signe chaque message qu\'il envoie, sur tous les fournisseurs',
  content: `Quand Claude envoie un e-mail à votre place, il devrait avoir l'air d'avoir été envoyé par vous. Cela inclut la formule de fin : votre nom, votre fonction, la ligne de votre entreprise, ce lien vers votre page de réservation. Jusqu'à présent, soit vous tapiez votre signature dans chaque prompt, soit vous acceptiez des e-mails qui se terminaient un peu abruptement. Aujourd'hui, cela change : **MCP Emails applique désormais votre signature automatiquement à chaque message que Claude envoie.**

Les signatures sont **par boîte de réception**. Chaque boîte connectée conserve la sienne, ainsi la casquette de fondateur va sur votre adresse professionnelle et un simple "— Sam" va sur la personnelle. Une fois définie, vous n'y pensez plus.

## Ce qui est signé

Définissez-la une fois et la signature est ajoutée automatiquement à tout ce que Claude envoie depuis cette boîte :

- **Nouveaux e-mails** — \`email_compose\` (action \`send\`).
- **Réponses et transferts** — \`email_compose\` (actions \`reply\` et \`forward\`).
- **Brouillons** — \`draft\`, donc ce que vous relisez porte déjà votre formule de fin à sa place.
- **Envois programmés** — \`schedule\`, donc un message mis en file pour lundi matin part signé.

Rien de plus à préciser dans votre prompt. "Réponds à Dana et dis-lui que le deck est en pièce jointe" produit un e-mail complet et signé.

## Les réponses et transferts la placent correctement

La partie délicate des signatures, c'est le placement, et c'est là que la plupart des outils échouent. Dans une réponse ou un transfert, MCP Emails place votre signature **après votre nouveau texte et avant le fil cité**, exactement là où une personne la mettrait, au lieu de l'abandonner tout en bas sous des pages d'historique.

Il est aussi malin quant aux échanges. Il existe un **mode réponse** pour que la signature ne se répète pas chaque fois que Claude répond au sein du même fil. La première réponse est signée ; les relances rapides de cette conversation ne sont pas empilées avec des formules de fin en double. Vous obtenez des fils propres, pas un mur de noms répétés.

## Fonctionne sur tous les fournisseurs

Ce n'est pas une commodité réservée à Gmail. Les signatures s'appliquent sur **tous** les fournisseurs connectés : Gmail, Outlook, Fastmail, iCloud et tout autre compte IMAP. Comme MCP Emails compose lui-même le message sortant, le comportement est identique quel que soit l'emplacement de la boîte. Connectez une nouvelle boîte de n'importe quel type et les signatures fonctionnent tout simplement.

## Deux façons de la configurer

**1. L'éditeur de signature dans le tableau de bord.** Ouvrez une boîte dans le tableau de bord de MCP Emails et modifiez sa signature en ligne. Chaque boîte a la sienne, vous pouvez donc donner à chaque adresse le ton approprié.

**2. Demandez-le simplement à Claude.** Il existe un nouvel outil \`signature\`, vous pouvez donc définir ou modifier votre signature en langage naturel sans quitter la conversation :

> "Définis la signature de ma boîte professionnelle comme : Sam Rivera, Fondateur, Acme — calendly.com/sam"

Claude l'écrit pour cette boîte, et à partir de là chaque envoi est signé. Demandez-lui de mettre à jour la signature plus tard et il fait de même.

## Quand vous voulez un message dépouillé

Parfois une signature, c'est du bruit : un "Merci !" d'un seul mot n'a pas besoin de trois lignes de coordonnées en dessous. Pour ces cas ponctuels, il y a l'**option \`include_signature\`** : dites à Claude d'ignorer la signature pour un seul message et il envoie la version concise. Votre signature enregistrée reste en place pour tout le reste.

> "Réponds 'J'arrive' au dernier message du bureau — sans signature."

## Comment cela s'intègre au reste du flux de travail

Les signatures s'intègrent aux outils que vous utilisez déjà. Si Claude exécute votre tri matinal et envoie des réponses, chacune porte désormais votre formule de fin sans que vous la mentionniez. Il en va de même pour les [modèles de réponse automatique](/blog/build-email-auto-responder-mcp-agent) et le [guide de tri et de résumé](/blog/ai-agent-triage-summarize-inbox) : tout ce qui se termine par un envoi se termine maintenant signé.

Et le modèle de confidentialité reste inchangé : votre e-mail n'est toujours [jamais stocké](/blog/why-email-never-stored-matters). La signature est un petit élément de configuration par boîte ; vos messages sont toujours récupérés en direct et supprimés dès que Claude les a.

## Questions fréquentes

**Les signatures sont-elles par boîte ou par compte ?**
Par boîte. Chaque boîte connectée a sa propre signature, vous pouvez donc signer différemment vos adresses professionnelle et personnelle.

**Les réponses et transferts placent-ils la signature au bon endroit ?**
Oui. Elle est placée après votre nouveau texte et avant le fil cité, et le mode réponse l'empêche de se répéter au fil d'un échange dans le même fil.

**Quels fournisseurs prennent en charge les signatures ?**
Tous : Gmail, Outlook, Fastmail, iCloud et tout autre compte IMAP. MCP Emails compose le message sortant, donc le comportement est le même partout.

**Puis-je envoyer un message sans ma signature ?**
Oui. Utilisez l'option \`include_signature\` (dites simplement à Claude d'ignorer la signature) pour un message concis ponctuel. Votre signature enregistrée reste en place pour tout le reste.

**Comment définir ma signature ?**
De deux façons : modifiez-la par boîte dans le tableau de bord, ou demandez-le à Claude — par exemple, "définis ma signature comme …" via le nouvel outil \`signature\`.

## Conclusion

Définissez votre signature une fois, par boîte, et chaque e-mail que Claude envoie depuis cette boîte (nouveau, réponse, transfert, brouillon ou programmé) part signé comme si vous l'aviez écrit. Cela fonctionne sur tous les fournisseurs, se place correctement dans les fils et s'efface avec \`include_signature\` quand vous voulez une réponse dépouillée.

[Ouvrez votre tableau de bord](/dashboard) pour définir une signature, ou dites simplement à Claude ce que devrait être la vôtre. Pas encore connecté ? [Commencez gratuitement](/signup) et connectez une boîte en environ deux minutes.`,
};

export default translation;
