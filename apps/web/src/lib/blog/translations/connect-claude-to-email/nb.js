export default {
  title: 'Koble Claude til e-posten din med MCP (Gmail, iCloud og IMAP)',
  description:
    'En praktisk guide til å koble Claude til Gmail, iCloud, Fastmail, Yahoo, Zoho og enhver IMAP-innboks over MCP — uten kode og uten lagring av e-post.',
  coverAlt:
    'Koble Claude til Gmail, iCloud, Fastmail, Yahoo, Zoho og IMAP-e-post med MCP Emails',
  content: `> **Outlook og Microsoft 365 er under utvikling.** De kan ikke kobles til i produksjon ennå. Denne guiden dekker Gmail, iCloud, Fastmail, Yahoo, Zoho og andre IMAP-innbokser som er tilgjengelige i dag.

Claude kan lese, søke i, organisere og sende e-post — men trenger en MCP-server for å nå en ekte innboks. MCP Emails er broen: koble til en innboks én gang, legg ett sikkert endepunkt til i Claude, og Claude får et konsekvent sett med e-postverktøy på tvers av Gmail, iCloud, Fastmail, Yahoo, Zoho og andre IMAP-leverandører.

Du trenger ikke skrive kode, installere en SDK eller bruke en API-nøkkel når du kobler til gjennom Claudes OAuth-flyt. E-post hentes live fra leverandøren din ved hver forespørsel og lagres ikke av MCP Emails.

**Gå til leverandøren din:** [Gmail](#gmail-og-google-workspace) · [iCloud](#icloud-mail) · [Fastmail](#fastmail) · [Yahoo, Zoho, Yandex eller egendefinert IMAP](#yahoo-zoho-yandex-og-egendefinert-imap)

## Dette trenger du

- Et **Claude-abonnement eller en app som støtter egendefinerte connectors**.
- En gratis **MCP Emails**-konto — [opprett en her](/signup).
- En e-postinnboks. Gmail bruker OAuth; iCloud, Fastmail, Yahoo, Zoho og de fleste andre leverandører bruker et appspesifikt passord. Outlook-støtte er under utvikling.

## Steg 1: Koble innboksen til MCP Emails

Åpne **Inboxes → Connect Inbox** i MCP Emails-dashbordet, og velg leverandøren din.

### Gmail og Google Workspace

Velg **Gmail**, logg inn med Google og godkjenn tilgang. Google-passordet ditt deles aldri med MCP Emails. Følg den [egne Gmail-guiden](/blog/connect-gmail-to-claude) hvis en Workspace-administrator styrer apptilgangen.

### iCloud Mail

Opprett et appspesifikt passord i Apple-kontoen din, velg **iCloud**, og bruk dette passordet — ikke det vanlige Apple-passordet. [Guiden for iCloud og IMAP](/blog/connect-icloud-fastmail-imap-to-claude) viser de nøyaktige stegene.

### Fastmail

Opprett et app-passord med Mail-tilgang i Fastmail, velg **Fastmail**, og lim det inn i MCP Emails. Ta vare på passordet til tilkoblingstesten lykkes.

### Yahoo, Zoho, Yandex og egendefinert IMAP

Opprett et app-passord, velg **IMAP**, og skriv inn adresse og passord. Vanlige innstillinger oppdages automatisk; et egendefinert domene kan kreve IMAP/SMTP-vert, port og sikkerhetsmodus fra leverandøren.

Du kan koble til flere enn én innboks. Claude finner dem med \`inbox_list\`, så du trenger ikke lime inn postkasse-ID-er i en prompt.

Trenger du hjelp med hver enkelt leverandør? Se [oppsettet for flere leverandører på to minutter](/blog/connect-email-to-ai-agent-under-2-minutes), den dedikerte [Gmail-guiden](/blog/connect-gmail-to-claude), eller [guiden for iCloud, Fastmail og IMAP](/blog/connect-icloud-fastmail-imap-to-claude).

## Steg 2: Legg MCP Emails til i Claude

I claude.ai eller Claude Desktop:

1. Åpne **Settings → Connectors**.
2. Velg **Add custom connector**.
3. Lim inn denne URL-en:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Velg **Connect**, logg inn på MCP Emails og godkjenn scopene du ønsker: \`read:email\`, \`send:email\` eller begge.

Det er hele oppsettet i Claude. OAuth begrenser tilkoblingen til scopene du godkjenner, og du kan tilbakekalle den fra MCP Emails når som helst. Hvis du bruker en klient uten OAuth-støtte, bruker du en begrenset API-nøkkel i stedet; [OAuth vs. API-nøkler](/blog/oauth-vs-api-keys-ai-email-access) forklarer den veien.

## Steg 3: Gi Claude en trygg første oppgave

Start med en skrivebeskyttet forespørsel:

> Oppsummer mine tre nyeste uleste e-poster og marker alt som trenger et svar i dag.

Claude finner først den tilkoblede innboksen, og lister deretter og leser de relevante meldingene. Når det virker, kan du prøve:

- «Finn fakturaen fra Stripe fra forrige måned og fortell meg beløpet.»
- «Skriv et utkast til svar på den siste meldingen fra Alex, men ikke send det.»
- «Vis meg nyhetsbrev fra denne uken som jeg kan arkivere.»
- «Hva gikk jeg med på i tråden min med Acme?»

For gjentakende rutiner kan du bruke [spilleboken for innbokstriering](/blog/ai-agent-triage-summarize-inbox) eller [måter å la Claude håndtere innboksen din på](/blog/best-ways-to-let-claude-manage-your-inbox).

## Hva Claude kan gjøre etter tilkobling

MCP Emails gir Claude fokuserte e-postverktøy i stedet for et passord eller en rå IMAP-tilkobling:

- **Lese og søke:** \`email_read\` lister meldinger, leser hele meldinger og søker i e-post. Gmail-søk støtter også Gmail-operatorer som \`from:\` og \`is:unread\`.
- **Sende, svare og videresende:** \`email_compose\` sender gjennom din egen leverandør og adresse.
- **Organisere:** \`email_organize\` flytter, merker, flagger og arkiverer meldinger.
- **Jobbe med utkast, mapper, planlegging og kontakter:** \`draft\`, \`folder\`, \`schedule\` og \`contact_search\` dekker resten av en praktisk e-postflyt.

MCP Emails er poll-basert: Claude sjekker ny e-post når du ber den om det, i stedet for å motta et push-varsel i samme øyeblikk som en e-post kommer.

## Feilsøking av tilkobling og Claude-oppsett

- **Leverandøren avviser passordet:** bruk et app-passord generert av leverandøren, ikke passordet du logger inn på nettet med. Generer det på nytt etter at du har aktivert tofaktorautentisering hvis det kreves.
- **En egendefinert IMAP-tilkobling får tidsavbrudd:** bekreft IMAP/SMTP-vert, port og TLS-modus. Port 993 bruker vanligvis implisitt TLS; port 143 bruker vanligvis STARTTLS.
- **Claude kobler til, men ser ingen e-post:** bekreft først at innboksen er aktiv i MCP Emails, koble Claude til igjen med **read:email**, og be Claude kalle **inbox_list**.
- **Claude kan lese, men ikke sende:** koble til igjen med **send:email**, og bekreft at tilkoblingen støtter SMTP eller leverandørens innebygde sending.

Hvis du fortsatt står fast, kan du sjekke [leverandørmatrisen](/docs/providers), åpne [oppsettsguiden](/docs#quickstart), og teste én skrivebeskyttet forespørsel før du aktiverer sending.

## Er det trygt å koble Claude til e-post?

Ja, så lenge du gir tilkoblingen bare den tilgangen den trenger og holder et menneske involvert ved utgående handlinger.

- **E-post lagres ikke.** MCP Emails henter meldingsinnhold live ved hvert kall og forkaster det etter levering. Den krypterte legitimasjonen som trengs for å koble til leverandøren igjen, er de eneste innboksdataene som beholdes.
- **Leverandøren din beholder kontroll over autentisering.** Gmail bruker OAuth, så MCP Emails mottar aldri passordet ditt. For IMAP-leverandører bruker du et tilbakekallbart appspesifikt passord i stedet for det vanlige passordet.
- **Scopes er eksplisitte.** Gi skrivebeskyttet tilgang hvis Claude aldri skal kunne sende. Legg bare til sendetilgang når du trenger det, og tilbakekall tilgangen når som helst.

Behandle hver e-posttekst som upålitelig inndata. Be Claude lage et utkast før den sender, gjennomgå meldinger til eksterne, og ikke la instrukser inne i en e-post overstyre det du faktisk vil. [Sikkerhetsguiden for e-posttilgang](/blog/is-it-safe-to-give-ai-agent-email-access) forklarer trusselmodellen mer detaljert.

## Vanlige spørsmål

**Kan Claude koble til Gmail, Outlook eller iCloud?**  
Gmail kobles til med OAuth, og iCloud med et appspesifikt passord. Outlook-støtte er under utvikling og er ikke tilgjengelig i produksjon ennå. MCP Emails støtter også Fastmail og generisk IMAP, som dekker tjenester som Yahoo og Zoho.

**Trenger jeg en API-nøkkel?**  
Nei, ikke for Claudes OAuth-baserte connector-flyt. Lim inn endepunkt-URL-en og logg inn. API-nøkler er for MCP-klienter uten innebygd OAuth.

**Kan Claude sende e-post?**  
Ja, hvis du gir \`send:email\`. Start med skrivebeskyttet tilgang, eller be Claude lage utkast først hvis du vil ha et gjennomgangssteg.

**Lagrer MCP Emails innboksen min?**  
Nei. Meldinger leses live fra leverandøren din og forkastes. MCP Emails lagrer bare den krypterte tilkoblingslegitimasjonen som kreves for å gjøre disse live-forespørslene.

## Neste steg

[Start gratis](/signup), koble til innboksen, legg \`https://mcpemails.com/api/mcp\` til i Claude, og be den oppsummere ulest e-post. Se [dokumentasjonen](/docs) for full referanse over MCP-verktøyene og leverandørfunksjonene.`,
};
