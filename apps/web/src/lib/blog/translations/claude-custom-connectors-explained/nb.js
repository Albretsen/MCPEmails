const translation = {
  title: 'Claude custom connectors forklart: abonnementer, oppsett, OAuth og sikkerhet',
  description:
    'Hva egendefinerte koblinger i Claude er, hvilke abonnementer og apper som støtter dem, hvordan du legger til en ekstern MCP-server med URL, innlogging, administratorkontroll og sikkerhetsråd.',
  coverAlt: 'Claude custom connectors forklart: en ekstern MCP-server lagt til i Claude med URL',
  content: `**Claude custom connectors**, eller egendefinerte koblinger, lar deg legge til en hvilken som helst ekstern [Model Context Protocol](https://modelcontextprotocol.io)-server i Claude ved å lime inn URL-en til serveren. Når koblingen er lagt til, kan Claude kalle verktøyene til serveren i samtalene dine: lese en database, opprette en sak, eller, som i eksempelet på slutten av denne guiden, lese og sende e-posten din.

Detaljene om abonnementer og menyer nedenfor er hentet fra Anthropics egne hjelpesider, kontrollert 20. oktober 2026. Claude-grensesnittet endres ofte, så hvis en etikett ser annerledes ut, er det Anthropics [veiledning for egendefinerte koblinger](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) som gjelder.

## Hva er en egendefinert kobling i Claude?

En egendefinert kobling i Claude er en ekstern MCP-server som du legger til med URL i stedet for å velge den fra Connectors Directory. Serveren kjører på internett, tilbyr et sett med verktøy og ber deg som regel logge inn med OAuth. Claude kaller deretter verktøyene på dine vegne, innenfor tilgangene du har godkjent.

Tre ting er greit å vite før du starter:

- **Anthropic verifiserer ikke egendefinerte koblinger.** Oppføringer i katalogen er merket Verified eller Community. En kobling du legger til med URL, kobler Claude til en tjeneste Anthropic ikke har gjennomgått, så du stoler på den som drifter serveren.
- **Tilkoblingen går fra Anthropics sky, ikke fra datamaskinen din.** Ifølge Anthropic gjelder dette i alle Claude-klienter, også claude.ai, Claude Desktop, Cowork og mobilappene. Serveren må være tilgjengelig fra det offentlige internettet. En server på et privat nettverk eller bak en VPN får ikke kontakt med mindre brannmuren slipper inn Anthropics IP-områder, eller den nås gjennom det Anthropic kaller en MCP-tunnel.
- **Du legger den til én gang per konto, ikke én gang per enhet.**

Er MCP nytt for deg, forklarer artikkelen [hva en MCP-e-postserver er](/blog/what-is-an-mcp-email-server) protokollen med e-post som eksempel.

## Slik skiller egendefinerte koblinger seg fra katalogkoblinger og skrivebordsutvidelser

Claude har tre måter å nå et eksternt verktøy på:

- **Katalogkoblinger** er oppført i Claudes Connectors Directory. Du blar gjennom dem under **Customize → Connectors** og klikker **Connect**. Claudes koblinger for Gmail og Microsoft 365 hører til her.
- **Egendefinerte koblinger** er eksterne MCP-servere du legger til med URL. Det er dem denne guiden handler om.
- **Skrivebordsutvidelser** er lokale MCP-servere pakket som \`.mcpb\`-filer og installert under **Settings → Extensions** i Claude-skrivebordsappen. De kjører på din egen datamaskin. Lokale servere satt opp i \`claude_desktop_config.json\` er en egen mekanisme igjen, og de er ikke tilgjengelige i claude.ai eller Cowork.

Claude Code legger til samme type ekstern server fra terminalen; [oppsettsiden for Claude Code](/docs/claude-code) viser kommandoen for MCPEmails. Hvordan en generell MCP-server og en innebygd kobling for én leverandør oppfører seg forskjellig, ser du i [innebygde koblinger og MCP sammenlignet](/native-connectors-vs-mcp).

## Hvilke Claude-abonnementer og apper støtter egendefinerte koblinger

Ifølge Anthropics hjelpesenter, per oktober 2026:

- **Abonnementer:** egendefinerte koblinger er tilgjengelige på Free, Pro, Max, Team og Enterprise. Free-abonnementet er begrenset til én egendefinert kobling.
- **Apper der du legger dem til:** claude.ai på nettet, Claude Desktop og Cowork.
- **Mobil:** en kobling du kobler til på nettet eller i Claude Desktop, blir tilgjengelig i Claude for iOS og Android neste gang du logger inn der. Anthropic beskriver installasjon av koblinger på mobil som beta og kaller nett- og skrivebordsappene hovedveien for egendefinerte koblinger, så sett den opp på en datamaskin først.
- **Hvem som kan legge til en kobling på et bedriftsabonnement:** på Team bare eiere (Owners) og primæreiere (Primary Owners). På Enterprise eiere, primæreiere og personer med en egendefinert rolle som inkluderer administrasjon av organisasjonens biblioteker.

## Slik legger du til en egendefinert kobling på Free, Pro eller Max

1. Åpne **Customize → Connectors** i claude.ai eller Claude Desktop.
2. Klikk **Add custom connector**. I noen oppsett ligger den bak en **+ Add**-knapp.
3. Skriv inn et navn og URL-en til serveren, og klikk **Continue**.
4. Se over autentiseringsinnstillingene Claude fant, og klikk **Continue**. Avsnittet om innloggingsvalg lenger ned forklarer valgene.
5. Klikk **Add** og deretter **Connect** for å logge inn på tjenesten.

Du kan ikke endre autentiseringsinnstillingene til en kobling etter at den er lagt til. Vil du endre dem, fjerner du koblingen og legger den til på nytt. For å fjerne en kobling åpner du **Customize → Connectors** og bruker **Remove** eller menyen med tre prikker ved siden av den.

## Slik legger organisasjoner til egendefinerte koblinger på Team og Enterprise

På Team og Enterprise er det å legge til en kobling og å koble til den to separate steg:

1. **En eier legger den til for organisasjonen.** Åpne **Organization settings → Connectors**, klikk **Add**, velg **Custom** og deretter **Web** hvis Claude spør om type. Skriv inn navn og URL, og gå gjennom de samme autentiseringsskjermene.
2. **Hvert medlem kobler til med sin egen konto.** Medlemmene åpner **Customize → Connectors**, finner koblingen, som vanligvis er merket **Custom**, og klikker **Connect**.

Siden hver person logger inn selv, når Claude bare det den personen har tilgang til i den tilkoblede tjenesten. Unntaket er en kobling satt opp med delt legitimasjon, for eksempel en API-nøkkel: alle som bruker den, får den tilgangen legitimasjonen gir.

Eiere kan også begrense hva en kobling får gjøre i hele organisasjonen. Hvert verktøy kan settes til **Always allow**, **Needs approval** eller **Blocked**, og enkeltbrukere kan ikke overstyre organisasjonens innstilling. Anthropics eget eksempel ligger nær e-posttilfellet nedenfor: la Claude søke i og oppsummere e-post, men hindre den i å sende meldinger.

Medlemmer som ikke kan legge til en kobling selv, må få en eier til å gjøre det. **Request**-knappen Claude viser, gjelder katalogoppføringer, så for en egendefinert URL sender du URL-en direkte til eieren.

## Innloggingsvalg: OAuth, automatisk registrering eller ingen innlogging

Claude viser opptil tre grupper med innstillinger når du legger til en kobling. Verdiene Claude finner, er som regel riktige.

**Authentication** bestemmer når folk logger inn:

- **Sign in now:** hver bruker går gjennom OAuth-innloggingen til serveren før koblingen tas i bruk. Dette er riktig valg for en server som har personopplysninger.
- **Sign in when needed:** Claude kobler til uten legitimasjon og ber brukerne logge inn når serveren krever det.
- **No sign-in:** alle som har URL-en, kan bruke koblingen. Dette dekker også servere som forventer en fast API-nøkkel, som du da legger til som en request header.

**OAuth client** bestemmer hvordan Claude identifiserer seg overfor innloggingssystemet til serveren. Den er skjult når du velger No sign-in:

- **Use Claude's published identity** er det Anthropic anbefaler. Serveren leser Claudes opplysninger fra et Client ID Metadata Document som Anthropic hoster, så du trenger ikke sette opp noe, så lenge serveren støtter den metoden.
- **Register automatically** bruker OAuth Dynamic Client Registration, som de fleste MCP-servere støtter.
- **Use your own OAuth client** er for en klient-ID du selv har registrert hos serveren.

**Request headers** inneholder fast legitimasjon, som en API-nøkkel eller et bearer-token. Claude lagrer dem sikkert, viser dem ikke igjen etter at du har lagret, og sender dem med hver forespørsel, opptil fire headere per kobling. Anthropic oppgir at request headers er en beta som bare er tilgjengelig for et begrenset utvalg organisasjoner, så det kan hende avsnittet ikke vises for deg.

Den praktiske forskjellen: med OAuth logger hver person inn som seg selv, godkjenner bestemte tilganger og kan trekke tilbake tilgangen uten at noen deler en hemmelighet. Med en fast nøkkel gir én legitimasjon samme tilgang til alle som bruker koblingen. [OAuth vs. API-nøkler for AI-tilgang til e-post](/blog/oauth-vs-api-keys-ai-email-access) går dypere inn i den avveiningen.

## Slå på en kobling i en samtale

Selv om du har lagt til en kobling, bruker ikke alle samtaler den. I en samtale klikker du **+**-knappen nede til venstre, åpner **Connectors** og slår hver kobling av eller på for den samtalen. Claude kan også selv foreslå en tilkoblet app når den passer til forespørselen.

For å styre enkeltverktøy åpner du **Customize → Connectors**, velger koblingen og setter hvert verktøy, eller hver gruppe med lese- og skriveverktøy, til **Always allow**, **Needs approval** eller **Blocked**. Når Claude ber om å kjøre et verktøy, velger du **Allow always** bare for servere og verktøy du stoler på at kan kjøre uten tilsyn.

## Sikkerhetssjekkliste før du kobler til

Anthropics råd kan oppsummeres i fem punkter:

- **Koble bare til servere som drives av organisasjoner du stoler på.** Serveren bestemmer hva verktøyene gjør, og den kan endre dem senere.
- **Les tilgangene på innloggingsskjermen.** Gi det smaleste settet som gjør jobben, og avslå alt som virker unødvendig.
- **Behandle verktøyresultater som upålitelige.** En nettside, en sak eller en e-post kan inneholde tekst skrevet for å styre Claude. Anthropic sier at Claude har innebygd beskyttelse mot prompt injection, men du bør likevel følge med på hva som går inn og ut.
- **Blokker eller krev godkjenning for skrivehandlinger du ikke trenger.** Det er ved sending, sletting og flytting at feil blir synlige for andre.
- **Vær forsiktig med Research.** Anthropic påpeker at Research kan kalle verktøyene til en kobling automatisk uten å spørre hver gang, så slå av skriveverktøy før du bruker den sammen med en kobling.

## Eksempel: e-post i Claude gjennom MCPEmails

E-post setter alt det ovenfor på prøve: en postkasse inneholder private data, og sending er en reell handling. MCPEmails er en hostet MCP-server som kobler til Gmail, Outlook og Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex og andre IMAP-postkasser, og presenterer dem for Claude som én egendefinert kobling.

**1. Koble en postkasse til MCPEmails.** [Opprett en konto](/signup), og åpne **Dashboard → Inboxes → Connect inbox**. Outlook og Microsoft 365 bruker Logg inn med Microsoft, de fleste andre leverandører bruker et app-passord, og [leverandørsidene](/connect) viser innstillingene for hver av dem. [Oppsettsiden for Claude](/docs/claude) har kortversjonen av steg 1 og 2.

**2. Legg til koblingen i Claude.** Under **Customize → Connectors** velger du **Add custom connector**, gir den navnet MCPEmails og skriver inn:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

**3. Velg innloggingsinnstillinger.** Velg **Sign in now**. For OAuth-klienten fungerer begge de to første valgene: MCPEmails støtter Claudes publiserte identitet og automatisk registrering. La request headers stå tomme, siden OAuth ikke trenger noen API-nøkkel.

**4. Logg inn og velg tilgang.** Klikk **Connect**, logg inn på MCPEmails og godkjenn tilganger på samtykkeskjermen. Claude ber først bare om \`read:email\`, og skjermen åpnes på det tilsvarende skrivebeskyttede valget. Legg til \`send:email\`, \`manage:drafts\`, \`manage:folders\` eller \`delete:email\` bare når en arbeidsflyt trenger dem. Et token uten \`send:email\` kan ikke sende, uansett hva Claude blir bedt om. Hvis en senere forespørsel trenger en tilgang du ikke har gitt, svarer MCPEmails med en \`insufficient_scope\`-feil som navngir scopet som mangler. Når du kobler til på nytt, krysser du av for den tilgangen på samtykkeskjermen. [Siden om skrivebeskyttet tilgang](/docs/read-only-access) viser nøyaktig hva en skrivebeskyttet tilgang kan og ikke kan gjøre.

**5. Angi verktøytilganger i Claude.** MCPEmails deler lesing og skriving i separate verktøy. \`email_read\`, \`inbox_list\`, \`folder_list\` og \`draft_list\` leser bare, mens \`email_compose\` sender, svarer og videresender, og \`email_delete\` sletter. Den inndelingen lar deg sette \`email_compose\` på **Needs approval** og \`email_delete\` på **Blocked** mens lesing står på **Always allow**. [Verktøyreferansen](/docs#tools) viser alle verktøyene.

**6. Start med en skrivebeskyttet oppgave.** Slå på koblingen i en ny samtale og be Claude liste opp innboksene dine og oppsummere de fem nyeste uleste e-postene uten å sende, flytte eller slette noe. Flere forslag til prompter finner du i [guiden til å koble Claude til e-post](/blog/connect-claude-to-email).

For et team legger eieren til den samme URL-en én gang i **Organization settings → Connectors**, og hvert medlem klikker **Connect** og logger inn med sin egen MCPEmails-konto. Hver person ser bare innboksene som kontoen deres har tilgang til. Skal utgående e-post vente på et menneske uansett hva Claude bestemmer, kan eieren av en innboks slå på sendegodkjenning i MCPEmails-dashbordet: hver sending, hvert svar, hver videresending, hver sending av utkast og hver planlagt sending holdes da tilbake til noen godkjenner den, og en forespørsel som ikke er avgjort, utløper etter 24 timer. [Godkjenn e-post som AI-agenter sender](/blog/approve-ai-agent-email-sends) går gjennom det oppsettet.

Når det gjelder data, henter MCPEmails e-post direkte fra leverandøren ved hver forespørsel og lagrer ikke meldingsinnhold. Tjenesten beholder bare det krypterte OAuth-tokenet eller app-passordet som trengs for å nå postkassen. Resultater som inneholder tekst fra postkassen, merkes som upålitelig innhold, slik at Claude får beskjed om at en e-post som ber den videresende eller slette noe, er data å rapportere, ikke en instruks. [Sikkerhetsoversikten](/security) og [er det trygt å gi en AI-agent tilgang til e-post?](/blog/is-it-safe-to-give-ai-agent-email-access) dekker trusselmodellen.

## Feilsøking av egendefinerte koblinger

- **Det finnes ingen Add custom connector-knapp.** På Team og Enterprise kan ikke medlemmer legge til egendefinerte koblinger. Be en eier legge til URL-en under **Organization settings → Connectors**.
- **Du får ikke lagt til en kobling nummer to på Free.** Free-abonnementet tillater én egendefinert kobling. Fjern den du ikke lenger bruker, eller gå over til et betalt Claude-abonnement.
- **Tilkoblingen får tidsavbrudd eller feiler.** Claude kobler til fra Anthropics sky, så serveren må være tilgjengelig fra det offentlige internettet. Den hostede MCPEmails-URL-en er det. En server du kjører selv, som [den selvhostede løsningen](/self-hosting), trenger en offentlig HTTPS-adresse eller en brannmur som slipper inn Anthropics IP-områder. Den selvhostede løsningen logger inn med en API-nøkkel i stedet for OAuth, så Claude kan bare bruke den der avsnittet Request headers er tilgjengelig.
- **Du valgte feil innloggingsinnstillinger.** Autentiseringsinnstillinger kan ikke redigeres. Fjern koblingen og legg den til på nytt, og så kobler medlemmene til igjen.
- **Koblingen er tilkoblet, men Claude bruker den ikke.** Åpne **+ → Connectors** i den samtalen og sjekk at bryteren er på, og at verktøyet du trenger, ikke står på **Blocked**.
- **Den vises ikke på telefonen.** Koble den til på nettet eller i Claude Desktop først, og logg deretter inn på nytt i mobilappen.
- **En e-posthandling blir avvist.** Tokenet mangler et scope. Koble til på nytt og godkjenn scopet handlingen trenger, eller trekk tilbake den gamle tilgangen i MCPEmails-dashbordet under **API keys**, der Claudes tilkobling står oppført som \`OAuth:\` etterfulgt av klientnavnet. [Oppsettsiden for Claude](/docs/claude) har de øvrige løsningene som gjelder Claude.

## Ofte stilte spørsmål

**Hva er Claude custom connectors?**  
Det er eksterne MCP-servere du legger til i Claude med URL. Claude kaller verktøyene til serveren i samtalene dine etter at du har logget inn og godkjent tilganger. De er tilgjengelige på Free, Pro, Max, Team og Enterprise, og Free-abonnementet tillater én.

**Fungerer egendefinerte koblinger i Claude Desktop og på mobil?**  
Ja. Du legger dem til i claude.ai, Claude Desktop eller Cowork, og en kobling du kobler til der, blir tilgjengelig i iOS- og Android-appene neste gang du logger inn.

**Hvem kan legge til en egendefinert kobling på Team eller Enterprise?**  
På Team kan eiere og primæreiere gjøre det. På Enterprise kan også personer med en egendefinert rolle som inkluderer administrasjon av organisasjonens biblioteker. Medlemmene kobler deretter til hver for seg.

**Er en egendefinert kobling trygg?**  
Den er like trygg som serveren bak den og tilgangene du gir. Anthropic verifiserer ikke egendefinerte koblinger, så koble bare til servere du stoler på, godkjenn de smaleste tilgangene, og krev godkjenning for skrivehandlinger eller blokker dem.

**Trenger jeg en API-nøkkel for å bruke MCPEmails som egendefinert kobling i Claude?**  
Nei. Claude logger inn på MCPEmails med OAuth. API-nøkler er for MCP-klienter uten OAuth-flyt, for eksempel skript.

## Neste steg

[Opprett en gratis MCPEmails-konto](/signup), koble til en postkasse og legg til \`https://mcpemails.com/api/mcp\` som egendefinert kobling i Claude. Bruker postkassen din IMAP og har ingen ferdig forhåndsinnstilling, viser [guiden til Claude IMAP-koblingen](/blog/claude-imap-connector) serverinnstillingene.`,
};

export default translation;
