const translation = {
  title: 'Koble Claude til Apple Mail: iCloud, Gmail, Outlook, Yahoo',
  description:
    'Koble Claude til kontoene i Apple Mail (iCloud, Gmail, Outlook.com, Yahoo, IMAP) og les, søk i, skriv utkast til og send e-post fra hvilken som helst enhet, også iPhone.',
  coverAlt: 'iCloud-, Gmail-, Outlook- og Yahoo-kontoene fra Apple Mail koblet til Claude over MCP',
  content: `For å koble Claude til Apple Mail kobler du til e-postkontoene Apple Mail viser, ikke selve Mail-appen. Apple Mail er en klient: den synkroniserer en iCloud-, Gmail-, Outlook.com-, Yahoo- eller annen IMAP-konto fra leverandørens servere. MCPEmails kobler Claude til de samme kontoene på serversiden, så Claude ser den samme innboksen, de samme mappene, utkastene og den sendte e-posten som Apple Mail gjør, og det fungerer fra claude.ai, Claude Desktop og Claude-appen på iPhonen din. Macen din trenger ikke være på.

## Kan Claude kobles til Apple Mail?

Ja, gjennom kontoene som ligger i den. Apple Mail har ingen egen tilkobling Claude kan logge inn på, så den pålitelige veien er:

1. Sjekk hvilke kontoer Apple Mail bruker.
2. Koble hver konto til MCPEmails, en hostet MCP-server.
3. Legg til MCPEmails i Claude som en egendefinert connector med én URL.

Deretter kan Claude lese, søke i, skrive utkast til, sende, planlegge og organisere e-post i alle tilkoblede kontoer, innenfor tilgangen du gir. Endringene dukker opp i Apple Mail på Macen og iPhonen neste gang den synkroniserer, fordi begge ser på den samme postkassen.

## Hvorfor koble til kontoen og ikke Mail-appen

MCP-serverne for Apple Mail som du finner på GitHub, kjører på Macen din og jobber gjennom selve Mail-appen, med AppleScript eller ved å lese Mails lokale indeks. Det fungerer, men med begrensninger som følger av selve utformingen:

- Det kjører bare på en Mac, med serveren installert og Mail tilgjengelig.
- Claude på iPhonen, på en Windows-PC eller på nettet kommer ikke til den, fordi tilkoblingen ligger på den ene Macen.
- Hvis Macen sover eller lokket er lukket, er serveren utilgjengelig.

En egendefinert connector i Claude fungerer motsatt vei. Anthropics hjelpesenter sier at tilkoblingen til en MCP-server går fra Anthropics servere, ikke fra enheten din, i alle Claude-klienter, også mobilappene. En tilkobling til e-postkontoen din på serversiden passer den modellen: det er ingenting å installere, og den samme connectoren fungerer uansett hvor du åpner Claude.

## Steg 1: Se hvilke kontoer Apple Mail bruker

- **På en Mac:** i Mail velger du **Mail → Innstillinger** og klikker **Kontoer**.
- **På iPhone eller iPad:** åpne **Innstillinger → Apper → Mail → Mail-kontoer**.

Hver konto i den listen kobles til MCPEmails på en av disse måtene:

- **iCloud** (@icloud.com, @me.com, @mac.com): et appspesifikt passord fra Apple. Innstillingene står på [iCloud-siden](/connect/icloud).
- **Google**: et Google-apppassord. Innstillingene står på [Gmail-siden](/connect/gmail).
- **Outlook.com, Hotmail, Live eller Microsoft 365**: Logg inn med Microsoft. For en jobb- eller skolekonto kan det hende IT-ansvarlig må godkjenne MCPEmails én gang. Detaljene står på [Outlook-siden](/connect/outlook).
- **Yahoo**: et Yahoo-apppassord. Innstillingene står på [Yahoo Mail-siden](/connect/yahoo).
- **Annen (IMAP)**: IMAP- og SMTP-innstillingene fra e-postverten din. Se [siden for egendefinert IMAP](/connect/imap).

Hvis leverandøren din ikke står i listen, har [hver leverandør vi støtter](/connect) sin egen side med serverinnstillingene.

## Steg 2: Koble hver konto til MCPEmails

Opprett en gratis [MCPEmails-konto](/signup), åpne dashbordet, gå til **Innbokser → Koble til innboks** og velg leverandøren.

### iCloud Mail

Apple godtar ikke passordet til Apple-kontoen din fra andre apper. Du trenger et appspesifikt passord:

1. Logg inn på [account.apple.com](https://account.apple.com).
2. Under **Pålogging og sikkerhet** velger du **Appspesifikke passord**.
3. Velg **Generer et appspesifikt passord**, gi det navnet \`MCPEmails\` og kopier passordet Apple viser.
4. I MCPEmails velger du **iCloud**, skriver inn iCloud-adressen din og limer inn passordet.

Apple-kontoen din må ha tofaktorautentisering for at dette skal fungere. Verdt å vite: endrer du passordet til Apple-kontoen, tilbakekalles alle appspesifikke passord, så etter et passordbytte lager du et nytt og kobler til på nytt. [Guiden for iCloud, Fastmail og IMAP](/blog/connect-icloud-fastmail-imap-to-claude) går mer i detalj.

### Gmail

Apple Mail logger inn hos Google med Google-kontoen din. MCPEmails bruker i stedet et Google-apppassord over IMAP, som Google tilbyr når totrinnsbekreftelse er slått på. Velg **Gmail** og lim inn passordet på 16 bokstaver sammen med adressen din. [Gmail-guiden](/blog/connect-gmail-to-claude) dekker Workspace-kontoer der en administrator har slått av apppassord.

### Outlook.com, Hotmail og Microsoft 365

Velg **Outlook** og klikk **Koble til med Microsoft**. Det er ikke noe passord å lime inn.

### Yahoo og andre IMAP-kontoer

Lag et apppassord hos leverandøren din, velg **Yahoo** eller **IMAP / SMTP**, og skriv inn adressen og passordet. For vanlige e-postverter fylles serverinnstillingene inn ut fra adressen.

Koble til hver Apple Mail-konto du vil at Claude skal nå. Hvor mange innbokser du kan legge til, avhenger av [abonnementet ditt](/pricing). Claude finner dem med \`inbox_list\`, så du limer aldri inn en konto-ID i en prompt.

## Steg 3: Legg til MCPEmails i Claude

På claude.ai eller i Claude Desktop:

1. Åpne **Customize → Connectors**.
2. Klikk **+ Add**, deretter **Add custom connector**.
3. Skriv inn et navn som \`MCPEmails\` og lim inn connector-URL-en:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Fortsett gjennom stegene og klikk **Add**. Klikk deretter **Connect**, logg inn på MCPEmails og velg hvor mye Claude får gjøre: **Skrivebeskyttet**, **Standard** (legger til sending, utkast og kontakter), **Full tilgang** (legger til mapper, planlegging og sletting) eller **Tilpasset**.

Det er ingen API-nøkkel og ingen konfigurasjonsfil. På et Team- eller Enterprise-abonnement legger en eier først til connectoren under **Organization settings → Connectors**, og medlemmene klikker deretter **Connect** på den. [Oppsettsiden for Claude](/docs/claude) dekker hvert steg og de vanligste feilene.

### Bruke det på iPhone

Anthropics hjelpesenter sier at en connector du legger til på claude.ai eller i Claude Desktop, er tilgjengelig neste gang du logger inn i Claude-appen for iOS eller Android. Legg den til én gang på nettet, og spør deretter Claude om e-posten din fra telefonen. Mail-appen på iPhonen trenger ikke være åpen, og Macen din trenger ikke være på.

## Hva Claude ser, og hva den ikke ser

Claude jobber med serverkopien av hver konto, som er kopien Apple Mail synkroniserer. Det betyr:

- **Mapper du har laget for kontoen, er synlige.** En postboks du har laget under iCloud- eller Gmail-kontoen din, ligger på serveren, så Claude kan liste opp og søke i den, og flytte e-post inn i den hvis du har gitt tilgang til mapper.
- **Utkast havner i Apple Mail.** Når Claude lagrer et utkast, havner det i Utkast-mappen til den kontoen, så du kan åpne det i Apple Mail, redigere det og sende det selv.
- **Sendt e-post blir lagret.** En melding Claude sender, lagres i Sendt-mappen til kontoen, akkurat som en melding sendt fra Apple Mail. Hvis en e-postserver avviser den kopien, sier resultatet fra Claude det.
- **Postbokser under «På maskinen» er ikke synlige.** Apple lagrer dem bare på Macen der du opprettet dem, så ingen servertilkobling kan se dem. Flytt det Claude skal finne, inn i en postboks under kontoen.
- **POP-kontoer kan være ufullstendige.** En konto Apple Mail bruker over POP, kan ha fjernet eldre e-post fra serveren etter at den ble lastet ned til Macen. MCPEmails kobler til over IMAP, så Claude når bare det som fortsatt ligger på serveren.

E-post hentes live fra leverandøren din for hver forespørsel og lagres ikke av MCPEmails. Det ene unntaket er en melding du planlegger å sende senere, som holdes til den er sendt.

## Prompts du kan prøve

Start med noe som bare leser:

> Oppsummer de uleste e-postene mine i iCloud og Gmail fra i dag. Én liste, merket med kontoen hver melding kom fra.

> Finn flybekreftelsen jeg fikk forrige måned, og gi meg bookingreferansen.

> Skriv et utkast til svar på den siste meldingen fra utleieren min, men ikke send det. Jeg gjør det ferdig i Apple Mail.

For flere rutiner, se [måter å la Claude håndtere innboksen din på](/blog/best-ways-to-let-claude-manage-your-inbox) og [oppskriften for innbokstriagering](/blog/ai-agent-triage-summarize-inbox). Har du flere kontoer, viser [guiden om å håndtere flere e-postkontoer med AI](/blog/manage-multiple-email-accounts-with-ai) hvordan du sørger for at svarene går fra riktig adresse.

## Koble ChatGPT til de samme kontoene

Connector-URL-en er en standard MCP-server, så ChatGPT kan nå de samme Apple Mail-kontoene. Du legger den til på chatgpt.com som en egendefinert MCP-server; OpenAIs hjelpesenter sier at det steget bare kan gjøres på nettet. Hvilke abonnementer og roller i arbeidsområdet som kan legge til en, endres ofte, så [oppsettsiden for ChatGPT](/docs/chatgpt) har de gjeldende stegene, og [e-postguiden for ChatGPT](/blog/connect-chatgpt-to-email) dekker de vanligste feilene.

## Behold kontrollen selv

- **Gi bare den tilgangen du trenger.** Velg **Skrivebeskyttet** på samtykkeskjermen hvis Claude aldri skal sende.
- **Se over sendinger først.** Slå på **Gjennomgang før sending** for en konto i dashbordet, så venter hver sending fra den på godkjenningen din. Se [menneskelig godkjenning av e-post sendt av AI](/blog/approve-ai-agent-email-sends).
- **Tilbakekall når som helst.** Fjern det appspesifikke passordet på account.apple.com, eller tilbakekall Claudes tilkobling under **API-nøkler** i MCPEmails-dashbordet.

Behandle hver e-post som tekst du ikke kan stole på: en melding kan inneholde instruksjoner rettet mot en AI. [Sikkerhetsguiden for e-posttilgang](/blog/is-it-safe-to-give-ai-agent-email-access) forklarer risikoene, og [sikkerhetssiden](/security) beskriver hvordan påloggingsinformasjon krypteres og hvor data lagres.

## Vanlige spørsmål

**Hvordan kobler jeg Claude til Apple Mail?**
Koble kontoene Apple Mail bruker (iCloud, Gmail, Outlook.com, Yahoo eller IMAP) til MCPEmails, og legg deretter til \`https://mcpemails.com/api/mcp\` som en egendefinert connector i Claude under Customize, Connectors. Claude leser og sender da fra de kontoene, og resultatet dukker opp i Apple Mail.

**Trenger jeg en Mac for dette?**
Nei. Ingenting kjører på Macen din. Claude når e-postkontoene dine gjennom MCPEmails, så det fungerer fra claude.ai, Claude Desktop på Windows eller Mac, og Claude-appen på iPhone og Android.

**Fungerer det med Apple Mail på iPhone?**
Ja. Mail-appen på iPhonen og Claude jobber begge med de samme kontoene. Legg til connectoren én gang på claude.ai, så er den tilgjengelig i Claude-appen på iPhone neste gang du logger inn.

**Hvorfor blir passordet til Apple-kontoen min avvist?**
iCloud godtar bare et appspesifikt passord fra andre apper. Lag et på account.apple.com under Pålogging og sikkerhet, og lim det inn i stedet.

**Kan Claude se mappene mine under «På maskinen»?**
Nei. De postboksene finnes bare på Macen din. Flytt meldingene inn i en postboks under iCloud-kontoen eller en annen konto, så kan Claude se dem.

**Blir e-posten min lagret?**
Nei. Hver forespørsel henter e-post live fra leverandøren din og forkaster den. Unntakene er meldinger du planlegger, som holdes til de er sendt, og den krypterte påloggingsinformasjonen for hver konto, som MCPEmails tar vare på. Den fullstendige steg-for-steg-veiledningen for hver leverandør står i [guiden til å koble Claude til e-post](/blog/connect-claude-to-email).

## Neste steg

[Start gratis](/signup), koble til iCloud-kontoen din, legg til connectoren i Claude, og spør den hva som trenger svar i dag. Åpne deretter Apple Mail, så ser du den samme innboksen Claude nettopp leste.`,
};

export default translation;
