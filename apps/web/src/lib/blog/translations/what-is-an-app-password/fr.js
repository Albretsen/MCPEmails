const translation = {
  title: "Qu'est-ce qu'un mot de passe d'application ? Où le créer chez chaque fournisseur",
  description:
    "Ce qu'est un mot de passe d'application, pourquoi les clients de messagerie et les connecteurs IA en ont besoin, où le créer pour Gmail, iCloud, Yahoo, AOL, Fastmail et Zoho, et comment le révoquer.",
  coverAlt: "Un mot de passe d'application qui relie une boîte mail à un agent IA via MCPEmails",
  content: `Un **mot de passe d'application** est un mot de passe distinct que votre fournisseur de messagerie génère pour une seule application, afin que celle-ci puisse se connecter à votre boîte sans le vrai mot de passe de votre compte. Vous le créez dans les paramètres de sécurité de votre compte, vous le collez une fois dans le client de messagerie ou le connecteur, et vous le supprimez dès que vous voulez couper l'accès à cette application. Votre mot de passe habituel et toutes vos autres applications continuent de fonctionner.

Si vous connectez une boîte à Thunderbird, à Apple Mail ou à un agent IA via un serveur MCP comme MCPEmails, un mot de passe d'application absent ou erroné est la cause la plus fréquente d'un échec de connexion. Ce guide explique ce qu'est un mot de passe d'application, pourquoi les clients IMAP en ont besoin, où chaque grand fournisseur range le générateur, et comment en révoquer un.

**Aller à :** [Où en créer un](#où-créer-un-mot-de-passe-dapplication-chez-chaque-fournisseur) · [Comment en révoquer un](#comment-révoquer-un-mot-de-passe-dapplication) · [Conseils de sécurité](#conseils-de-sécurité) · [FAQ](#faq)

## Qu'est-ce qu'un mot de passe d'application ?

Un mot de passe d'application est un identifiant long, généré aléatoirement, rattaché à votre compte de messagerie mais délivré pour une seule application. Trois choses le distinguent du mot de passe que vous tapez dans le webmail :

- **C'est le fournisseur qui le génère.** Vous ne le choisissez pas. Google produit un code de 16 caractères, Apple en affiche un au format \`abcd-efgh-ijkl-mnop\`, et la plupart des fournisseurs ne le montrent qu'une seule fois.
- **Il remplace votre mot de passe là où un second facteur ne peut pas être demandé.** Les clients de messagerie se connectent en IMAP (lecture) et en SMTP (envoi), et ces protocoles ne savent pas afficher une demande de validation en deux étapes. Le mot de passe d'application est le moyen qu'a trouvé le fournisseur de laisser entrer ces clients sans affaiblir la connexion sur le web.
- **Il se révoque à part.** Supprimez-le et seule l'application qui l'utilisait perd l'accès. Rien d'autre ne change sur le compte.

Google le décrit comme un code secret à 16 chiffres qui autorise une application ou un appareil à accéder à votre compte Google (en pratique, le code compte 16 lettres). Apple parle de **mot de passe pour app**, Zoho de **mot de passe spécifique à l'application**, GMX et WEB.DE d'**App-Passwort**. Le principe est le même partout.

## Pourquoi les clients IMAP et les connecteurs IA en ont besoin

Beaucoup de fournisseurs n'acceptent plus votre mot de passe habituel depuis une application de messagerie tierce, surtout une fois la validation en deux étapes activée. Un client de messagerie sur ordinateur, l'application Mail intégrée d'un téléphone ou un serveur qui lit vos e-mails pour vous utilisent tous IMAP et SMTP, et chez Google, Apple, Yahoo, AOL, Fastmail et Yandex, l'identifiant que ces protocoles acceptent est un mot de passe d'application.

Un connecteur IA est exactement dans la même situation. Quand Claude ou ChatGPT travaille avec votre boîte via [un serveur MCP pour l'e-mail](/blog/what-is-an-mcp-email-server), l'IA ne se connecte pas elle-même à votre boîte. C'est le serveur MCP qui le fait, en IMAP et SMTP, comme le ferait Thunderbird. Pour iCloud, Yahoo, AOL, Fastmail, Gmail et les fournisseurs similaires, le serveur a donc besoin d'un mot de passe d'application, et le client IA ne reçoit qu'un jeton restreint pour le serveur. Le [guide sur OAuth et les clés API pour l'accès à l'e-mail](/blog/oauth-vs-api-keys-ai-email-access) traite de cette seconde couche.

L'erreur classique consiste à coller le mot de passe que vous utilisez sur le site du fournisseur. Dans les journaux de connexion de MCPEmails, 72,9 % des échecs de connexion d'une boîte venaient d'identifiants refusés, et la cause habituelle était un mot de passe de compte saisi à la place d'un mot de passe d'application. Les mots de passe d'application générés ont une forme reconnaissable : le formulaire de connexion de MCPEmails vérifie donc ce que vous collez pour Gmail, iCloud, Yahoo, Yandex et Fastmail, et vous avertit avant que la tentative n'atteigne le fournisseur, qui la compterait sinon comme une connexion échouée. Si vous êtes sûr de la valeur, cliquer à nouveau sur **Connecter** l'envoie quand même.

## Où créer un mot de passe d'application chez chaque fournisseur

Chaque entrée ci-dessous indique où se trouve le générateur et ce qu'il faut activer avant. La page de configuration liée pour chaque fournisseur donne les réglages IMAP et SMTP et toutes les étapes.

- **Gmail et Google Workspace :** activez la **Validation en deux étapes**, puis créez-en un sur \`myaccount.google.com/apppasswords\`. Le code fait 16 lettres affichées en quatre groupes ; les espaces n'ont pas d'importance. Google cite trois cas où l'option n'apparaît pas : certains comptes professionnels, scolaires ou d'autres organisations (sous Workspace, c'est un réglage de votre administrateur), la Protection Avancée, et une validation en deux étapes configurée uniquement avec des clés de sécurité. Configuration : [Gmail](/connect/gmail), [Google Workspace](/connect/google-workspace).
- **iCloud Mail :** l'identification à deux facteurs est obligatoire. Sur \`account.apple.com\`, ouvrez **Connexion et sécurité**, puis **Mots de passe pour app**, et générez-en un. Vous pouvez en avoir jusqu'à 25 actifs en même temps. Configuration : [iCloud Mail](/connect/icloud).
- **Yahoo Mail :** sur la page **Sécurité du compte** de Yahoo, sous **Connexions externes** (External connections), choisissez **Créer un mot de passe d'application** (Create app password), donnez-lui un nom et générez-le. Configuration : [Yahoo Mail](/connect/yahoo).
- **AOL Mail :** sur la page **Account Security** d'AOL, choisissez **Generate app password** (certains comptes affichent **Generate and manage app passwords**), puis **Get Started**, donnez-lui un nom et générez-le. AOL demande de le faire dans un navigateur avec lequel vous vous connectez à AOL Mail depuis plusieurs jours, pas dans une fenêtre de navigation privée. Un mot de passe d'application Yahoo n'ouvre pas une boîte AOL, même si les deux tournent sur la même plateforme. Configuration : [AOL Mail](/connect/aol).
- **verizon.net :** Verizon a arrêté son service de messagerie et les boîtes verizon.net encore actives sont désormais des comptes AOL : vous créez donc un mot de passe d'application **AOL** et vous vous connectez avec votre adresse verizon.net complète. Configuration : [verizon.net](/connect/verizon).
- **Fastmail :** allez dans **Settings**, **Privacy & Security**, **Connected apps & API tokens**, **Manage app passwords and access**, **New app password**. Gardez le niveau d'accès par défaut, **Mail, Contacts & Calendars** ; un mot de passe limité à Files ne peut pas se connecter à la messagerie. Fastmail se connecte uniquement avec un mot de passe d'application, et l'offre Basic de Fastmail ne permet pas d'en créer. Configuration : [Fastmail](/connect/fastmail).
- **Zoho Mail :** activez d'abord l'**Accès IMAP** dans Zoho Mail sous **Paramètres**, **Comptes de messagerie**. Sans authentification à deux facteurs, votre mot de passe Zoho fonctionne ; avec l'authentification à deux facteurs, une connexion fédérée (par exemple via Google) ou SAML, créez un mot de passe spécifique à l'application dans votre compte Zoho et utilisez-le. Configuration : [Zoho Mail](/connect/zoho).
- **Yandex Mail :** activez IMAP sous **Mail clients** dans les paramètres de Yandex Mail, puis, sur la page de sécurité de \`id.yandex.com\`, ouvrez **App passwords** et créez-en un pour un client de messagerie. Yandex ne l'affiche qu'une fois. Configuration : [Yandex Mail](/connect/yandex).
- **GMX :** activez d'abord l'accès **POP3/IMAP** dans les paramètres de messagerie. Sans authentification à deux facteurs, votre mot de passe GMX habituel fonctionne ; avec, créez un App-Passwort sous **Account verwalten**, **Login & Sicherheit**, **App-Passwörter (für externe Apps)**, **Neues App-Passwort erstellen**. GMX ne l'affiche qu'une fois. Configuration : [GMX](/connect/gmx).
- **WEB.DE :** même chose que GMX : activez l'accès **POP3/IMAP**, et créez un App-Passwort au même endroit si l'authentification à deux facteurs est activée. Configuration : [WEB.DE](/connect/web-de).
- **Outlook.com, Hotmail et Live :** pas de mot de passe d'application. Microsoft indique que l'authentification de base, la connexion par mot de passe sur laquelle reposent les mots de passe d'application, n'est plus disponible pour aucun compte Outlook depuis le 16 septembre 2024 : un mot de passe d'application ne peut donc pas ouvrir la boîte. MCPEmails connecte ces comptes avec **Se connecter avec Microsoft** via Microsoft Graph, à la place. Configuration : [Outlook.com](/connect/outlook) ; les comptes professionnels sont traités dans le [guide Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Tout le reste, comme une boîte chez votre hébergeur web ou sur votre propre domaine, suit le même principe : générez un mot de passe d'application si le fournisseur en propose, sinon utilisez le mot de passe de la boîte, et saisissez les réglages du serveur à la main. La [page IMAP générique](/connect/imap) et la [liste complète des fournisseurs](/connect) couvrent ces cas.

## Comment en créer un et connecter votre boîte

Les étapes sont les mêmes partout, seuls les noms des menus changent :

1. Activez la validation en deux étapes sur le compte de messagerie si le fournisseur l'exige.
2. Ouvrez la page des mots de passe d'application indiquée plus haut, nommez le mot de passe d'après l'application (par exemple \`MCPEmails\`) et générez-le.
3. Copiez-le tout de suite. La plupart des fournisseurs ne le réafficheront pas.
4. Dans MCPEmails, ouvrez **Boîtes**, puis **Connecter une boîte**, choisissez votre fournisseur, et collez votre adresse e-mail complète et le mot de passe d'application.
5. Ajoutez \`https://mcpemails.com/api/mcp\` à votre client IA. Le [guide Claude](/blog/connect-claude-to-email) et le [guide ChatGPT](/blog/connect-chatgpt-to-email) détaillent cette partie.

Si la connexion est toujours refusée, le [guide du connecteur IMAP](/blog/claude-imap-connector) liste les autres causes habituelles : IMAP désactivé, mauvais serveur régional, ou un nom d'utilisateur qui n'est pas l'adresse complète.

## Comment révoquer un mot de passe d'application

Révoquer, c'est mettre fin à l'accès d'une application sans toucher au reste. Supprimez le mot de passe là où vous l'avez créé :

- **Google :** \`myaccount.google.com/apppasswords\`, puis supprimez l'entrée concernée. Changer le mot de passe de votre compte Google révoque aussi tous les mots de passe d'application.
- **Apple :** **Connexion et sécurité**, **Mots de passe pour app**, puis supprimez-en un ou utilisez **Tout révoquer**. Changer ou réinitialiser le mot de passe de votre compte Apple les révoque tous automatiquement.
- **Yahoo et AOL :** la page **Sécurité du compte** (**Connexions externes** chez Yahoo, **Generate and manage app passwords** chez AOL), puis supprimez ce mot de passe d'application. Changer votre mot de passe principal ne révoque **pas** les mots de passe d'application ici : supprimer l'entrée est donc le seul moyen de couper un client.
- **Fastmail, Zoho, Yandex, GMX, WEB.DE :** supprimez-le de la liste des mots de passe d'application où vous l'avez créé. Chez Yandex, se déconnecter de tous les appareils réinitialise aussi tous les mots de passe d'application.

Côté MCPEmails, **Déconnecter la boîte** dans le tableau de bord efface le mot de passe d'application enregistré en même temps que la connexion. Faire les deux est la façon propre de retirer une intégration : le fournisseur n'accepte plus le mot de passe, et MCPEmails ne le détient plus.

## Conseils de sécurité

- **Créez-en un par application.** Un mot de passe d'application distinct et nommé pour chaque client vous permet d'en révoquer un sans casser les autres, et la liste de votre compte montre qui a encore accès.
- **Traitez-le comme un mot de passe.** Un mot de passe d'application se connecte sans demander votre second facteur, c'est tout son principe. Ne le collez pas dans une conversation avec une IA, un document partagé ou un ticket d'assistance. Dans MCPEmails, il va uniquement dans le formulaire de connexion.
- **Il donne en général un accès complet à la messagerie.** Chez la plupart des fournisseurs, un mot de passe d'application peut lire, envoyer et supprimer des e-mails, pas seulement une partie de ces actions. Restreignez plutôt ce que votre IA peut faire au niveau du connecteur : MCPEmails vous permet d'approuver \`read:email\` sans \`send:email\`, et le [guide sur la sécurité de l'accès à l'e-mail](/blog/is-it-safe-to-give-ai-agent-email-access) explique comment relire les envois.
- **Sachez où il est stocké.** MCPEmails conserve le mot de passe d'application chiffré en AES-256-GCM, ne le déchiffre que sur le serveur pour joindre votre fournisseur, et ne le transmet jamais au client IA. Vos messages sont récupérés en direct et ne sont pas stockés. [Pourquoi c'est important](/blog/why-email-never-stored-matters).
- **Google recommande « Se connecter avec Google » quand une application le propose.** Google indique que les mots de passe d'application sont déconseillés et inutiles dans la plupart des cas. Ils existent pour les applications qui ne peuvent pas utiliser cette connexion, dont les clients IMAP qui n'acceptent qu'un mot de passe.

## FAQ

**Qu'est-ce qu'un mot de passe d'application ?**
Un mot de passe d'application est un mot de passe généré aléatoirement que votre fournisseur de messagerie délivre pour une application ou un appareil, comme un client de messagerie ou un connecteur e-mail pour IA. Il permet à cette application de se connecter en IMAP et SMTP sans votre mot de passe principal, et vous pouvez le supprimer à tout moment pour révoquer cette application seule.

**Un mot de passe d'application est-il la même chose que mon mot de passe de messagerie ?**
Non. Votre mot de passe de messagerie est celui que vous avez choisi et que vous tapez dans le webmail. Un mot de passe d'application est généré par le fournisseur, utilisé par une seule application, et chez la plupart des fournisseurs votre mot de passe habituel ne fonctionnera pas à sa place.

**Pourquoi faut-il un mot de passe d'application pour connecter sa messagerie à un agent IA ?**
Parce que le serveur MCP qui donne l'accès à l'IA se connecte à votre boîte en IMAP et SMTP, comme n'importe quel client de messagerie, et que la plupart des fournisseurs n'y acceptent qu'un mot de passe d'application. Outlook.com est la principale exception : il se connecte avec Se connecter avec Microsoft.

**Un mot de passe d'application expire-t-il ?**
Il cesse de fonctionner quand vous le supprimez. Google et Apple révoquent aussi tous les mots de passe d'application quand vous changez le mot de passe principal du compte, alors que chez Yahoo et AOL ils restent valides après un changement de mot de passe, jusqu'à ce que vous les supprimiez.

**J'ai perdu mon mot de passe d'application. Puis-je le revoir ?**
Non. La plupart des fournisseurs ne l'affichent qu'une fois. Supprimez l'ancien, générez-en un nouveau et collez-le dans l'application. Dans MCPEmails, ouvrez la boîte et choisissez **Reconnecter**.

## Prochaine étape

[Créez un compte MCPEmails gratuit](/signup), générez un mot de passe d'application chez votre fournisseur et connectez la boîte. La [matrice des fournisseurs](/docs/providers) indique ce que chaque fournisseur prend en charge une fois connecté.`,
};

export default translation;
