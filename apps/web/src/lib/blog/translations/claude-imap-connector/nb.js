export default {
  title: 'Claude IMAP-kobling: Koble en hvilken som helst IMAP-innboks til Claude',
  description:
    'Sett opp en Claude IMAP-kobling med IMAP/SMTP, app-passord og TLS. Få sikkerhetsråd, forstå begrensninger og løs vanlige tilkoblingsfeil.',
  coverAlt: 'Claude koblet til en IMAP- og SMTP-postkasse gjennom MCPEmails',
  content: `En **Claude IMAP-kobling** lar Claude arbeide med postkasser som ikke har en innebygd Claude-integrasjon: Fastmail, iCloud Mail, Yahoo, Zoho, Yandex, en postkasse på ditt eget domene eller nesten enhver leverandør som tilbyr IMAP og SMTP.

Claude logger ikke inn på e-postserveren eller håndterer postkassepassordet ditt direkte. MCPEmails står mellom dem. Tjenesten kobler seg til leverandøren over IMAP for innkommende e-post og SMTP for utgående e-post, og gir deretter Claude et enhetlig sett med [Model Context Protocol](https://modelcontextprotocol.io)-verktøy. Dette skillet er viktig: IMAP og SMTP håndterer postkassen, mens MCP gir Claude trygge, strukturerte handlinger som å lese, søke, svare og flytte.

Denne veiledningen dekker den generiske koblingen og Claude-delen av oppsettet. Hvis du bruker iCloud eller Fastmail og vil se de nøyaktige skjermbildene for app-passord og servernavnene deres, kan du ha den [leverandørspesifikke veiledningen for iCloud, Fastmail og IMAP](/blog/connect-icloud-fastmail-imap-to-claude) åpen ved siden av.

## Dette gjør Claude IMAP-koblingen i praksis

Tilkoblingen består av tre deler:

1. **E-postleverandøren din** tilbyr IMAP for å lese og organisere meldinger, samt SMTP for å sende.
2. **MCPEmails** oppbevarer e-postlegitimasjonen i kryptert form, kommuniserer med disse serverne og gjør svarene om til forutsigbare e-postverktøy.
3. **Claude** kobler seg til MCP-endepunktet og kaller bare verktøyene som tilgangene du godkjenner, tillater.

Claude trenger derfor aldri et IMAP-bibliotek, en SMTP-konfigurasjon eller et passord i prompten. Når tilkoblingen er på plass, kan den bruke \`inbox_list\` til å finne postkassen, \`email_read\` til å liste, lese, søke eller hente vedlegg, \`email_compose\` til å sende, svare og videresende, og \`email_organize\` til å flytte, kopiere, flagge eller arkivere meldinger. Egne verktøy dekker mapper, utkast, planlegging, kontakter og sletting. Hele listen finner du i [verktøyreferansen](/docs#tools).

## Dette trenger du før oppsettet

Finn disse verdiene på hjelpesiden til e-postleverandøren eller hos administratoren:

- **E-postadresse:** for eksempel \`you@example.com\`. Dette er adressen som vises på den tilkoblede innboksen.
- **Brukernavn for innlogging:** vanligvis hele e-postadressen. Enkelte verter for egendefinerte domener oppgir et annet IMAP-/SMTP-brukernavn.
- **IMAP-vert og -port:** for eksempel \`imap.example.com\` på port \`993\` for IMAP over implisitt TLS. Denne tilkoblingen håndterer lesing, søk, mapper og meldingshandlinger.
- **SMTP-vert og -port:** for eksempel \`smtp.example.com\` på port \`465\` eller \`587\`. Port \`465\` bruker implisitt TLS; \`587\` oppgraderer med STARTTLS. Denne tilkoblingen håndterer sending, svar og videresending.
- **Passord:** helst et tilbakekallbart app-passord opprettet for tilgang fra e-postklienter.

Ikke gjett servernavnene ut fra domenet dersom leverandøren publiserer innstillinger. E-posttjenesten er ofte atskilt fra webhotellet, og en adresse på et egendefinert domene kan bruke en leverandørspesifikk innlogging som er forskjellig fra den synlige adressen.

Bruk et **app-passord** når leverandøren støtter det. Det er atskilt fra hovedpassordet til kontoen og kan tilbakekalles uten å endre passordet du logger inn med. Leverandører krever ofte tofaktorautentisering før du kan opprette et. Noen krever også at du først aktiverer IMAP-tilgang i e-postinnstillingene.

MCPEmails har forhåndsinnstillinger for iCloud, Yahoo, Zoho og Yandex, samt en egen app-passordflyt for Fastmail. Disse valgene fyller inn kjente verter og porter for deg. Velg **Generic IMAP** for en annen leverandør eller din egen e-postserver, og skriv inn verdiene selv.

## Steg 1: Koble til IMAP-/SMTP-postkassen

1. [Opprett eller logg inn på MCPEmails-kontoen din](/signup), og åpne deretter **Dashboard → Inboxes → Connect Inbox**.
2. Velg den navngitte leverandøren hvis den finnes. Ellers velger du **IMAP / SMTP**.
3. Skriv inn e-postadressen og app-passordet. For den generiske koblingen oppgir du også IMAP-vert og -port, SMTP-vert og -port, samt et eget brukernavn hvis verten har gitt deg et.
4. Lagre tilkoblingen. MCPEmails validerer legitimasjonen mot IMAP-serveren før innboksen lagres, slik at en avvist innlogging eller et utilgjengelig TLS-endepunkt feiler her i stedet for å dukke opp senere i Claude.

De vanlige sikre standardene er IMAP \`993\`, deretter SMTP \`465\` eller \`587\`. De kan ikke brukes om hverandre: bruk porten og sikkerhetsmodusen som leverandøren har dokumentert. MCPEmails behandler SMTP-port \`587\` som STARTTLS og andre konfigurerte SMTP-porter som implisitt TLS. Tilkoblinger uten TLS-støtte avvises.

## Steg 2: Legg til MCPEmails som en Claude-kobling

Når postkassen er tilkoblet, peker du Claude mot MCPEmails:

1. Åpne **Customize → Connectors** i claude.ai.
2. Velg **Add connector** og skriv inn \`https://www.mcpemails.com/api/mcp\`.
3. Velg **Connect**, logg inn på MCPEmails og godkjenn bare tillatelsene arbeidsflyten trenger.

En oppsummeringsflyt trenger for eksempel lese- og søketilgang, men ikke sende- eller slettetilgang. En svarflyt trenger sendetilgang. Mappehåndtering og permanent sletting har egne tilganger, slik at du kan holde destruktive handlinger utilgjengelige til de faktisk er nyttige. Se [veiledningen for å koble Claude til e-post](/blog/connect-claude-to-email) for en mer detaljert gjennomgang på klientsiden.

Kjør deretter en liten funksjonstest:

\`\`\`
Use inbox_list to find my IMAP inbox. List my five newest unread messages and summarize them. Do not send, move, or delete anything.
\`\`\`

Når du starter med \`inbox_list\`, kan Claude hente riktig \`inbox_id\` i stedet for å stole på en kopiert UUID.

## Dette kan Claude gjøre over IMAP

Når tilkoblingen fungerer, kan Claude:

- Liste og lese meldinger som hentes direkte fra leverandøren.
- Søke etter avsender, mottaker, emne, brødtekst, lesestatus, flaggstatus og datoer.
- Laste ned eller trekke ut støttede vedlegg innenfor de dokumenterte grensene for størrelse og format.
- Sende nye meldinger gjennom SMTP, eller svare og videresende samtidig som relevant meldingskontekst bevares.
- Flytte, kopiere, flagge, arkivere og organisere e-post i IMAP-mapper.
- Opprette og administrere utkast, planlegge meldinger og søke i kontakter der verktøyet støtter handlingen.
- Flytte e-post til papirkurven eller, med eksplisitt slettetillatelse og \`permanent: true\`, slette den permanent fra IMAP.

Den siste funksjonen krever omtanke. Permanent IMAP-sletting omgår papirkurven og kan være ugjenkallelig. MCPEmails eksponerer sletting som et eget destruktivt verktøy, og MCP-klienten styrer bekreftelsesadferden, men du bør likevel bare gi \`delete:email\` til arbeidsflyter som trenger det.

## Viktige IMAP-begrensninger

En IMAP-kobling har bred støtte, men gjør ikke alle leverandører identiske.

- **Ingen push for innkommende e-post:** MCPEmails er kun basert på forespørsel og svar. Tjenesten sender ikke webhooks eller utløser Claude når en melding kommer inn. En automatisert arbeidsflyt må sjekke etter nye meldinger etter en tidsplan, for eksempel ved å liste ulest e-post.
- **Søk varierer etter transport:** Strukturerte filtre for avsender, emne, tekst og dato fungerer på tvers av leverandører, men generisk IMAP støtter ikke søkefilteret \`has_attachment\`. Leverandørspesifikk søkesyntaks kan ikke flyttes mellom tjenester.
- **Mapper er ikke Gmail-etiketter:** IMAP flytter en melding mellom mapper, mens Gmail kan knytte flere etiketter til én melding. Den praktiske forskjellen forklares i [Gmail-etiketter kontra IMAP-mapper](/blog/gmail-labels-vs-imap-folders-ai-agents).
- **SMTP kreves for sending:** En fungerende IMAP-innlogging beviser at Claude når innkommende e-post, ikke at SMTP-verten, porten eller sendetillatelsen er riktig. Test én ufarlig utgående melding før du stoler på en svarflyt.
- **Leverandørens regler gjelder fortsatt:** Postkassekvoter, sendegrenser, grenser for samtidige tilkoblinger, spamkontroller og administratorbegrensninger gjelder fortsatt.

## Feilsøking av en Claude IMAP-tilkobling

### «Authentication failed» når innboksen kobles til

Bruk et app-passord, ikke passordet du bruker på leverandørens nettsted. Bekreft at tofaktorautentisering og IMAP-tilgang er aktivert dersom leverandøren krever det. Kopier det genererte passordet på nytt uten innledende eller avsluttende mellomrom. Hvis adressen er på et egendefinert domene, kontroller om brukernavnet er hele e-postadressen eller et eget kontonavn.

### Serveren får tidsavbrudd eller TLS feiler

Kontroller stavemåten til verten og bruk leverandørens dokumenterte sikre porter. Start med IMAP \`993\`; for SMTP bruker du den dokumenterte \`465\` eller \`587\`. Et vertsnavn for nettsted, kontrollpanel eller bare domene er ikke nødvendigvis en e-postserver. På en privat server må du også bekrefte at brannmuren godtar tilkoblinger utenfra nettverket ditt, og at TLS-sertifikatet samsvarer med e-postvertsnavnet.

### Claude kan lese, men ikke sende

IMAP-innstillingene fungerer, men SMTP er separat. Kontroller SMTP-vertsnavnet og -porten på nytt, bekreft at legitimasjonen har SMTP- eller «mail»-tilgang, og sjekk at leverandøren tillater autentisert sending fra Fra-adressen. Fastmail-app-passord bør for eksempel opprettes med **Mail (IMAP/SMTP)**-tilgang i stedet for skrivebeskyttet tilgang.

### Claude finner ikke postkassen

Be Claude kalle \`inbox_list\` på nytt. Hvis innboksen ikke vises, sjekk statusen i MCPEmails-dashbordet og koble den til på nytt hvis app-passordet er tilbakekalt eller rotert. Hvis innboksen vises, men en handling avvises, kobler du Claude-koblingen til på nytt eller oppdaterer API-nøkkelen med nødvendig tilgang.

### Søkeresultatene er smalere enn forventet

Start med strukturerte felt som \`from\`, \`subject\`, \`text\`, \`since\` og \`before\`, og angi hvilke mapper som skal gjennomsøkes ved behov. Ikke kopier Gmail-operatorsyntaks inn i et generisk IMAP-søk og forvent identisk oppførsel. Husk at filtrering etter tilstedeværelse av vedlegg ignoreres for generisk IMAP.

## Sikkerhet: Legitimasjonen holdes utenfor Claude

MCPEmails lagrer OAuth-tokenet eller IMAP-app-passordet som trengs for fremtidige kall, kryptert med AES-256-GCM i hvile. Vanlig postkasseinnhold hentes direkte når et verktøy kjører, og lagres ikke mellom kall. Trafikken bruker TLS, og du kan tilbakekalle et app-passord hos leverandøren eller koble fra innboksen i dashbordet.

Det tydelige skillet er hovedgrunnen til å bruke en MCP-bro i stedet for å lime inn e-postlegitimasjon i en chat eller lokal konfigurasjon: Claude får avgrensede e-postfunksjoner, ikke nøklene til postkassen. For detaljer om lagring og trusselmodellen kan du lese [hvorfor «e-post lagres aldri» er viktig](/blog/why-email-never-stored-matters) og [sikkerhetsoversikten](/security).

## Kortversjonen

En Claude IMAP-kobling er en IMAP-/SMTP-postkassetilkobling som presenteres for Claude som MCP-verktøy. Finn de sikre serverinnstillingene, opprett et tilbakekallbart app-passord, koble innboksen til i MCPEmails og legg til \`https://www.mcpemails.com/api/mcp\` i Claude. Test skrivebeskyttet tilgang først, legg til sende- eller destruktive tilganger med omtanke, og bruk feilsøkingssjekklisten ovenfor hvis leverandøren avviser tilkoblingen.

Klar til å prøve? [Koble til en IMAP-innboks](/signup), eller bruk den [leverandørspesifikke oppsettsveiledningen](/blog/connect-icloud-fastmail-imap-to-claude) for detaljer om iCloud og Fastmail.`,
};
