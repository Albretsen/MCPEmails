export default {
  title: 'Slik gir du AI-agenten din tilgang til e-post (den komplette 2026-guiden)',
  description:
    'Gi AI-agenten din lese- og sendetilgang til en ekte innboks over MCP — Gmail, Outlook, iCloud, Fastmail eller IMAP. Slik fungerer det: verktøyene, sikkerheten og oppsettet.',
  coverAlt: 'Slik gir du AI-agenten din tilgang til e-post over MCP — MCPEmails',
  content: `For å gi en AI-agent tilgang til e-post kobler du innboksen din til en MCP-server og peker agenten mot én endepunkt-URL. Agenten får da et lite sett med verktøy for å lese, søke og sende e-post. Det vanskelige er ikke agenten — det er å gjøre dette uten å lekke passordet ditt inn i en prompt, en logg eller et vektorlager. Den siste biten er det denne guiden handler om.

Hvis du bare vil ha den raske veien: koble til en innboks i dashbordet, lim MCP-endepunktet inn i [claude.ai](https://claude.ai), Claude Desktop, Cursor eller din egen agent, og kall \`inbox_list\` først. Resten av dette innlegget forklarer hva som faktisk skjer, hvorfor sikkerhetsmodellen er viktig, og hvordan du kobler opp hver støttede leverandør.

## Hva "e-post over MCP" egentlig betyr

[Model Context Protocol](https://modelcontextprotocol.io) er en standard måte å eksponere verktøy for en språkmodell over HTTP. En MCP-e-postserver presenterer innboksen din ikke som rå IMAP, men som en håndfull typede verb agenten kan kalle: list opp meldinger, les én, søk, send, svar. Agenten resonnerer over disse verbene. Den berører aldri den underliggende e-postprotokollen, og den ser aldri legitimasjonen din.

Det er hele ideen bak [MCP Emails](/). Ett endepunkt, ett sett med verktøy, hvilken som helst MCP-kompatibel klient. Vil du ha forklaringen på arkitekturen helt fra bunnen, dekker følgeinnlegget [hva er en MCP-e-postserver](/blog/what-is-an-mcp-email-server) det på klart språk.

## Hvorfor den siste biten er vanskelig

Å koble en modell til e-post ser trivielt ut helt til du prøver det på ordentlig. Tre ting biter:

1. **Autentisering er ulik for hver leverandør.** Gmail vil ha OAuth med bestemte scopes. Outlook vil ha Microsoft-identitet. iCloud og Fastmail vil ha et app-spesifikt passord. Hver har sin egen syklus for token-fornyelse og sine egne feilmoduser.
2. **Legitimasjon er radioaktiv.** Et innbokspassord som ligger i en chat-transkripsjon eller en loggsetning er et brudd som bare venter på å skje. Du kan ikke la modellen holde hemmeligheten.
3. **E-post har et dårlig format for agenter.** MIME, tråd-headere, HTML kontra ren tekst, vedlegg, mapper som egentlig er etiketter. Modellen trenger et rent svar, ikke RFC 5322.

Den naive gjør-det-selv-løsningen — gi modellen et IMAP-bibliotek og passordet ditt — feiler på alle tre samtidig. De fleste "Gmail MCP server"-repoene på GitHub stopper akkurat der.

## Hvordan MCP Emails løser det

Fire designvalg gjør det tunge løftet. De er grunnen til at jeg stoler på dette med min egen innboks.

### E-post hentes live og lagres aldri

Hvert verktøykall treffer leverandøren din i sanntid: Gmail API, Microsoft Graph eller IMAP/SMTP. Meldingstekster, emnefelt og vedlegg overleveres til agenten og forkastes umiddelbart. Ingenting bufres, indekseres eller lagres. Det eneste som beholdes per innboks er legitimasjonen som trengs for å gjøre neste kall. Vil du ha den lange versjonen av hvorfor dette betyr noe, les [hvorfor "e-post lagres aldri" er viktig](/blog/why-email-never-stored-matters).

### Legitimasjon er AES-256-GCM-kryptert i hvile

OAuth-tokenet eller app-passordet for hver innboks krypteres før det skrives til databasen. Dekryptering skjer kun inne i en isolert Edge Function, ved kalltidspunktet, med en nøkkel som lever som en miljøhemmelighet adskilt fra databasen. Så selv en databaselekkasje gir en angriper kryptert tekst, ikke innboksen din.

### Sending går gjennom din egen leverandør

Når agenten sender eller svarer, går e-posten ut gjennom din Gmail, ditt Microsoft 365 eller din SMTP-server. MCP Emails videreformidler aldri fra sitt eget domene. Leveringsdyktigheten og domenets omdømme forblir helt dine egne — ingen spam-mappe-rulett med delt IP.

### Det er standard MCP over HTTP

Serveren snakker Streamable HTTP i henhold til MCP 2025-06-18-spesifikasjonen. Ingen SDK å installere, ingen egendefinert klient. Den faller rett inn i alt som snakker MCP.

## Verktøyene agenten din får

En håndfull konsoliderte, handlingsbaserte verktøy dekker hele flaten: lese, skrive, organisere, pluss flere for mapper, planlegging og kontakter. Agenten starter alltid med \`inbox_list\` for å oppdage hva som er koblet til og hente hver innboks' ID — den hardkoder aldri en UUID.

- \`inbox_list\` — oppdag tilkoblede kontoer og hva de kan
- \`email_read\` (handling \`list\`) — paginert, nyeste først, per innboks
- \`email_read\` (handling \`read\`) — parset ren tekst, valgfri renset HTML, valgfrie vedlegg
- \`email_read\` (handling \`search\`) — leverandørens egen syntaks (Gmail-operatorer, Outlook KQL, IMAP tekstsøk)
- \`email_compose\` (handling \`send\`) — skriv med CC/BCC, HTML og vedlegg på opptil 10 MB totalt
- \`email_compose\` (handling \`reply\`) — det samme, og den setter tråd-headerne (In-Reply-To, References) for deg
- \`email_organize\` — flytt, slett, flagg eller arkiver (én handling per kall)

Én ærlig begrensning verdt å nevne med en gang: dette er **polling, ikke push**. Det finnes ingen webhooks. For å reagere på ny e-post må agenten din polle på en tidsplan, for eksempel \`email_read\` (handling \`list\`) med \`unread_only: true\`. Enhver autosvarer du bygger fungerer på en timer, ikke en umiddelbar utløser. [Bygg-guiden for autosvarer](/blog/build-email-auto-responder-mcp-agent) viser hvordan du gjør dette godt.

En morgentriage-kjøring ser slik ut:

\`\`\`json
{
  "step1": "inbox_list                  → finds your work Gmail",
  "step2": "email_read (action list)    → last 24h, unread_only",
  "step3": "email_read (action read)    → full body for anything urgent",
  "step4": "email_compose (action reply) → draft, or just summarize and wait"
}
\`\`\`

Ingen passord krysset linjen. Agenten holdt kapabiliteter, ikke legitimasjon. For flere ideer, se [7 ting en AI-agent kan gjøre med innbokstilgang](/blog/7-things-ai-agent-can-do-with-inbox-access) og den grundigere [gjennomgangen av triage og oppsummering](/blog/ai-agent-triage-summarize-inbox).

## Støttede leverandører og hvordan hver kobles til

Du kobler til en innboks én gang i **Dashboard → Inboxes → Connect Inbox**. Hvordan du autentiserer avhenger av leverandøren.

### OAuth-leverandører (ett klikk)

- **Gmail** — OAuth 2.0 via Google-innlogging.
- **Outlook / Microsoft 365** — OAuth 2.0 via Microsoft-innlogging. Oppsettsdetaljer i [koble Outlook og Microsoft 365 til en AI-agent](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

### App-passord-leverandører

iCloud, Fastmail, Yahoo, Zoho, Yandex og enhver generisk IMAP-innboks kobles til med et app-spesifikt passord i stedet for OAuth. Du genererer passordet i leverandørens sikkerhetsinnstillinger og limer det inn i MCP Emails. iCloud-passord kommer fra appleid.apple.com; Fastmail er **kun app-passord** (lag ett i Fastmail-innstillingene). De kjører alle på samme IMAP/SMTP-transport og deler et identisk funksjonssett. Den fullstendige gjennomgangen ligger i [koble iCloud, Fastmail eller en hvilken som helst IMAP-innboks til Claude](/blog/connect-icloud-fastmail-imap-to-claude).

## Koble til AI-klienten din

Samme endepunkt, samme verktøy, to veier inn avhengig av om klienten din snakker OAuth.

### OAuth-kompatible klienter (ingen API-nøkkel)

claude.ai, Claude Desktop, Cursor og lignende klienter kobler til med OAuth 2.0 Authorization Code + PKCE og RFC 7591 Dynamic Client Registration. I claude.ai er det **Customize → Connectors → Add connector**, lim inn MCP-endepunkt-URL-en, klikk Connect, logg inn på MCP Emails-kontoen din og godkjenn. Tokens er begrenset til nøyaktig det du godkjenner: \`read:email\`, \`send:email\` eller begge.

### Klienter uten OAuth (API-nøkkel)

Cline, JetBrains, egendefinerte skript og rå cURL bruker en scope-begrenset API-nøkkel. Lag én i **Dashboard → API Keys**, velg dens scopes, og kopier den (den vises bare én gang). Send den som \`Authorization: Bearer <api-key>\`. Fullt oppsett for disse finner du i [e-post for AI-agenter i Cursor, Cline og VS Code](/blog/email-for-ai-agents-cursor-cline-vscode), og avveiningen mellom de to tilnærmingene dekkes i [OAuth kontra API-nøkler for AI-e-posttilgang](/blog/oauth-vs-api-keys-ai-email-access).

Uansett kan du trekke tilbake enhver tilkobling fra dashbordet med ett klikk. Hent den nøyaktige endepunkt-URL-en fra [dokumentasjonen](/docs) — kopier den derfra i stedet for å skrive den for hånd.

## Er dette trygt? Og rate-grensene

Kort svar: ja, og innlegget [er det trygt å gi en AI-agent e-posttilgang](/blog/is-it-safe-to-give-ai-agent-email-access) legger frem hele saken. Modellen holder scope-begrensede kapabiliteter, ikke passordet ditt; legitimasjon er kryptert; ingenting lagres; sending forblir på leverandøren din; tilgang trekkes tilbake med ett klikk.

Når det gjelder rate-grenser, er hver API-nøkkel begrenset til 100 forespørsler/min, 1 000/time og 10 000/dag på alle planer. Det finnes også et burst-tak per arbeidsområde som skalerer med planen din: 60/min på Gratis, 120/min på Personal, 300/min på Pro, 1 000/min på Team. Når du treffer en grense returnerer serveren en feil som kan prøves på nytt, med en \`retry_after\`-verdi i sekunder. Respekter den. Og prøv aldri blindt å sende på nytt automatisk med \`email_compose\`: da sender du duplikater.

## Priser

Planene prises etter antall tilkoblede innbokser. API-nøkler er ubegrenset på alle nivåer, og nivåene skiller seg ellers på burst-grense, analyselagring, teamfunksjoner og støtte.

- **Gratis, $0 for alltid.** Ingen kort. Én tilkoblet innboks, 60 req/min, 7-dagers analyser, fellesskapsstøtte.
- **Personal, $5 per måned** (eller $48 per år, $4 per måned). Opptil tre tilkoblede innbokser, 120 req/min, 30-dagers analyser, e-poststøtte.
- **Pro, $29 per måned** (eller $276 per år, $23 per måned). Ubegrenset antall tilkoblede innbokser, 300 req/min, 90-dagers analyser, e-poststøtte.
- **Team, $79 per måned** (eller $756 per år, $63 per måned). Alt i Pro, pluss medlemmer med roller, et eget arbeidsområde per kunde eller virksomhet, SSO med SAML/OIDC pluss revisjonslogg, 1 000 req/min, 1-års analyser, prioritert støtte.

Full oversikt på [prissiden](/pricing).

## Kom i gang

Koble til en innboks, lim endepunktet inn i agenten din, og kall \`inbox_list\`. Det er hele onboardingen. [Start gratis](/signup) eller skum gjennom [hurtigstarten](/docs#quickstart) — du vil ha en agent som leser ekte e-post på et par minutter.`,
};
