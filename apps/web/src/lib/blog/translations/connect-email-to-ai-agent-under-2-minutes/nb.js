export default {
  title: 'Slik kobler du e-posten til en AI-agent på under 2 minutter (Gmail, Outlook, iCloud, Fastmail og IMAP)',
  description: 'Koble e-posten til en AI-agent på under 2 minutter. Steg-for-steg-oppsett for Gmail, Outlook, iCloud, Fastmail og hvilken som helst IMAP-innboks over MCP — uten at e-post lagres.',
  coverAlt: 'Koble e-posten til en AI-agent på under 2 minutter — Gmail, Outlook, iCloud, Fastmail og IMAP over MCP',
  content: `Du kobler e-posten til en AI-agent i to grep: koble til innboksen i MCP Emails-dashbordet, og pek så agenten mot én endepunkt-URL. Med en OAuth-kompatibel klient som claude.ai er det alt. Ingen kode, ingen SDK, og e-posten din lagres aldri noe sted — hver lesing og hver sending går live mot leverandøren din og forkastes i det øyeblikket agenten har den.

Dette er den raske guiden. Velg leverandøren din nedenfor, følg de fire eller fem stegene, så har du Claude (eller Cursor, eller et eget skript) som leser og sender ekte e-post på omtrent den tiden det tar å lese dette avsnittet to ganger. For den dypere "hva er dette, og er det trygt"-versjonen, start med [den komplette guiden til å gi AI-agenten din e-posttilgang](/blog/how-to-give-your-ai-agent-email-access).

## Det ene steget alle leverandører deler: koble til klienten din

Før du tar fatt på en leverandør, bestem deg for hvordan AI-agenten din skal snakke med MCP Emails. Det finnes to veier, og begge bruker samme endepunkt og samme verktøy.

**Vei A — OAuth-klient (claude.ai, Claude Desktop, Cursor).** Ingen API-nøkkel. Du limer inn en URL og godkjenner en innlogging:

1. I claude.ai, gå til **Customize → Connectors → Add connector**.
2. Lim inn endepunktet: \`https://www.mcpemails.com/api/mcp\`
3. Klikk **Connect**, logg inn på MCP Emails-kontoen din, og godkjenn de scopene du vil ha (\`read:email\`, \`send:email\`, eller begge).

Det er hele klientsiden. Tokens er begrenset til nøyaktig det du godkjente, og du kan tilbakekalle koblingen fra dashbordet med ett klikk. Vil du ha avveiningene forklart, se [OAuth kontra API-nøkler for AI-e-posttilgang](/blog/oauth-vs-api-keys-ai-email-access).

**Vei B — API-nøkkelklient (Cline, JetBrains, cURL, egne agenter).** For alt uten innebygd OAuth:

1. Gå til **Dashboard → API Keys** og opprett en nøkkel.
2. Velg scopene dens (\`read:email\`, \`send:email\`).
3. Kopier den én gang (den vises bare én gang) og send den som en header: \`Authorization: Bearer <your-api-key>\`, igjen mot \`https://www.mcpemails.com/api/mcp\`.

Hvis du lever i en editor, dekker [e-postoppsettet for Cursor, Cline og VS Code](/blog/email-for-ai-agents-cursor-cline-vscode) den veien fra ende til ende.

Så til innboksen. Hver leverandør nedenfor starter likt: **Dashboard → Inboxes → Connect Inbox**, og velg så leverandøren din.

## Koble til hver leverandør

### Gmail (OAuth)

Den raskeste av dem alle, fordi Google gjør jobben.

1. **Dashboard → Inboxes → Connect Inbox → Gmail.**
2. Du sendes til Googles innlogging. Velg kontoen.
3. Godkjenn lese- og sendetilgang på samtykkeskjermen.
4. Du lander tilbake i dashbordet med innboksen tilkoblet. Ferdig.

Ingen passord skifter eier. MCP Emails holder et kryptert OAuth-token og kaller Gmail-APIet direkte. Søk bruker Gmails egne operatorer (\`from:\`, \`is:unread\`, \`after:\`), så agenten din kan være presis.

### Outlook / Microsoft 365 (OAuth)

Samme form som Gmail, annen identitetsleverandør.

1. **Dashboard → Inboxes → Connect Inbox → Outlook / Microsoft 365.**
2. Logg inn med Microsoft-kontoen din på Microsofts side.
3. Godkjenn tillatelsene.
4. Innboksen dukker opp som tilkoblet. Sending går ut via Microsoft Graph, så det er en helt vanlig melding fra din egen konto.

Hvis tenanten din har betinget tilgang eller regler for administratorsamtykke, går [oppsettsguiden for Outlook og Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) gjennom fallgruvene på administratorsiden.

### iCloud (app-spesifikt passord)

iCloud gir ikke tredjeparter OAuth, så du genererer et app-spesifikt passord. Det tar ett ekstra minutt.

1. Gå til [appleid.apple.com](https://appleid.apple.com), logg inn, og åpne **Sign-In and Security**-seksjonen.
2. Under **App-Specific Passwords**, opprett et nytt og merk det med "MCP Emails."
3. Kopier passordet som genereres (det ser ut som \`xxxx-xxxx-xxxx-xxxx\`).
4. I **Dashboard → Inboxes → Connect Inbox → iCloud**, skriv inn iCloud-adressen din og lim inn det app-passordet.

iCloud kjører over IMAP/SMTP under panseret, så du får samme verktøysett som alle andre.

### Fastmail (app-spesifikt passord — ikke OAuth)

En rask korrigering hvis du har lest eldre dokumentasjon: **Fastmail kobles til med et app-passord, ikke OAuth.** Ikke let etter en "Sign in with Fastmail"-knapp — den finnes ikke her.

1. I Fastmail, åpne **Settings → Privacy & Security → Integrations** (eller **App Passwords**).
2. Opprett et nytt app-passord. Gi det tilgang til e-post (IMAP/SMTP) og kall det "MCP Emails."
3. Kopier passordet Fastmail genererer.
4. I **Dashboard → Inboxes → Connect Inbox → Fastmail**, skriv inn Fastmail-adressen din og lim det inn.

Det er alt — fra agentens side oppfører Fastmail seg nøyaktig som de andre IMAP-leverandørene.

### Generisk IMAP (Yahoo, Zoho, Yandex og resten)

Alt som snakker IMAP/SMTP fungerer gjennom én kobling. Mønsteret er identisk med iCloud og Fastmail: lag et app-passord hos leverandøren din, og lim det så inn.

1. I leverandørens sikkerhetsinnstillinger oppretter du et **app-passord** (Yahoo, Zoho og Yandex gjemmer alle dette under kontosikkerhet). Bruk et ekte app-passord, ikke innloggingspassordet ditt — de fleste leverandører blokkerer uansett IMAP med vanlig passord nå.
2. **Dashboard → Inboxes → Connect Inbox → IMAP.**
3. Skriv inn e-postadressen din og app-passordet. MCP Emails oppdager vanlige servere automatisk; hvis din er uvanlig, fyll inn IMAP- og SMTP-verten/porten leverandøren din oppgir.
4. Lagre. Innboksen kobles til og er klar.

For leverandørspesifikke særegenheter på tvers av iCloud, Fastmail og den lange halen av IMAP-verter er [dypdykket i iCloud, Fastmail og IMAP](/blog/connect-icloud-fastmail-imap-to-claude) referansen for feilsøking.

## Første kall: oppdag, og handle deretter

Uansett hvilken leverandør du valgte, er agentens første trekk alltid det samme. Få den til å kalle \`inbox_list\` for å oppdage hva som er tilkoblet og hente hver innboks' \`inbox_id\` — agenten kopierer aldri en UUID manuelt. Derfra jobber den gjennom et lite sett konsoliderte verktøy: \`email_read\` (med en \`action\` på \`list\`, \`read\` eller \`search\`), \`email_compose\` (\`send\`, \`reply\` eller \`forward\`) og \`email_organize\` for å flytte, flagge og arkivere, pluss \`folder\`, \`draft\`, \`schedule\` og \`contact_search\`:

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose",
    "email_organize"
  ]
}
\`\`\`

En god røyktest: be agenten din om å "oppsummere mine tre nyeste uleste e-poster." Den kjører \`inbox_list\`, deretter \`email_read\` med \`action: "list"\` og \`unread_only: true\`, og så \`email_read\` med \`action: "read"\` på hver av dem. Hvis det fungerer, er koblingen din i drift.

Ett ærlig forbehold det er verdt å avklare med en gang: MCP Emails er pollebasert. Det finnes ingen webhooks eller push-hendelser, så en agent reagerer på ny e-post ved å sjekke etter en tidsplan i stedet for å bli varslet. Det er riktig modell for de fleste arbeidsflyter, og det er slik mønstrene for [innbokstriagering og oppsummering](/blog/ai-agent-triage-summarize-inbox) fungerer.

## Hvorfor dette er trygt å gjøre raskt

Farten her kommer ikke av å ta snarveier på sikkerhet. E-post hentes live ved hvert kall og lagres aldri — brødtekst, emner og vedlegg overleveres til agenten og forkastes umiddelbart. Det eneste som lagres per innboks er OAuth-tokenet ditt eller app-passordet, kryptert med AES-256-GCM og dekryptert kun inne i en isolert funksjon når kallet skjer. Sending går alltid gjennom din egen leverandør, så domeneomdømmet ditt forblir ditt. Vil du ha arkitekturen i detalj, les [hvorfor "e-post lagres aldri" faktisk betyr noe](/blog/why-email-never-stored-matters).

## Oppsummering

Det er hele greia: én innbokskobling, ett endepunkt, en håndfull verktøy. Gratisnivået kobler til én innboks, koster ingenting og krever ikke kort; Personal koster $5 per måned for opptil tre innbokser, og Pro kobler til alle postkassene du eier. Se [priser](/pricing). Klar til å prøve? [Start gratis](/signup), koble til innboksen din, og lim endepunktet inn i agenten din.`,
};
