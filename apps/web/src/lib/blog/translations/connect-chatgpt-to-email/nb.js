const translation = {
  title: 'Koble ChatGPT til e-posten din med MCP (Gmail, Outlook, iCloud og IMAP)',
  description:
    'Steg for steg: koble Gmail, Outlook, iCloud, Fastmail eller en hvilken som helst IMAP-innboks til ChatGPT med en egendefinert MCP-kobling, og til OpenAI Codex med en avgrenset nøkkel. Ingen e-post lagres.',
  coverAlt:
    'Koble ChatGPT og OpenAI Codex til Gmail, Outlook, iCloud, Fastmail og IMAP-e-post med MCP Emails',
  content: `ChatGPT kommer ikke til en postkasse på egen hånd. Den trenger en MCP-server foran e-posten din, og MCP Emails er den serveren: koble til en innboks én gang, pek ChatGPT mot én enkelt URL, og den får de samme e-postverktøyene enten posten ligger i Gmail, Outlook eller Microsoft 365, iCloud, Fastmail, Yahoo, Zoho eller på en egen IMAP-server.

To OpenAI-flater er involvert, og de autentiserer på hver sin måte. ChatGPT kjører en OAuth-flyt i nettleseren, så det finnes ingen API-nøkkel å lime inn. OpenAI Codex kjører i terminalen, så den bruker en avgrenset bearer-nøkkel i stedet. Samme endepunkt, samme verktøy.

**Hopp til:** [Oppsett i ChatGPT](#steg-2-legg-til-koblingen-i-chatgpt) · [OpenAI Codex](#openai-codex-i-terminalen) · [Feilsøking](#feilsking)

## Dette trenger du

- **ChatGPT Plus, Pro, Business, Enterprise eller Edu, i nettleseren.** Egne MCP-koblinger ligger bak utviklermodus, som OpenAI tilbyr på chatgpt.com for disse abonnementene. Free- og Go-kontoer kan ikke legge til en, og mobil- og skrivebordsappene viser ikke valget. På Business og Enterprise må en administrator kanskje tillate utviklermodus først.
- **En gratis MCP Emails-konto.** [Opprett en her](/signup). Gratisplanen rommer én tilkoblet innboks og krever ikke kort.
- **Én postkasse.** Gmail, Outlook eller Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex, eller hva som helst som snakker IMAP og SMTP.

Er du på Free eller Go, fungerer den samme innboksen og URL-en allerede i [Claude](/docs/claude), [Cursor](/docs/cursor), [VS Code](/docs/vscode) og de andre [støttede klientene](/docs/clients).

## Steg 1: Koble innboksen til MCP Emails

I MCP Emails-dashbordet åpner du **Inboxes** og deretter **Connect Inbox**, og velger leverandøren din.

### Gmail og Google Workspace

Gmail kobles til med et Google-apppassord over IMAP som standard, og Google OAuth-innlogging er også tilgjengelig. Bruk apppassordet hvis en Workspace-administrator begrenser tilgangen for tredjepartsapper. [Gmail-veiledningen](/blog/connect-gmail-to-claude) har stegene.

### iCloud, Fastmail, Yahoo og Zoho

Disse vil ha et apspesifikt passord, ikke passordet du skriver inn på nettet. Opprett ett hos leverandøren, velg leverandøren i MCP Emails, og lim det inn. [Veiledningen for iCloud, Fastmail og IMAP](/blog/connect-icloud-fastmail-imap-to-claude) har de nøyaktige stegene.

### Outlook og Microsoft 365

Outlook kobles til med Logg inn med Microsoft, ikke et app-passord: velg **Outlook**, klikk **Koble til med Microsoft** og godkjenn. Personlige Outlook.com-, Hotmail-, Live- og MSN-kontoer kobles til med en gang. Jobb- eller skolekontoer i Microsoft 365 kan trenge at en IT-ansvarlig først godkjenner appen én gang for hele organisasjonen; dashbordet gir deg en lenke du kan sende dem. [Guiden for Outlook og Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) har detaljene.

### Alle andre IMAP-postkasser

Velg **IMAP** og skriv inn adressen og apppassordet. Vanlige innstillinger oppdages automatisk. Et eget domene kan trenge vert, port og sikkerhetsmodus fra leverandøren din. [Leverandørmatrisen](/docs/providers) viser hva hver enkelt støtter, og det finnes en side per leverandør under [connect](/connect), blant annet [Gmail](/connect/gmail), [Outlook](/connect/outlook), [Microsoft 365](/connect/office365), [iCloud](/connect/icloud) og [generisk IMAP](/connect/imap).

Koble til mer enn én postkasse hvis planen din tillater det. ChatGPT finner dem med \`inbox_list\`, så du limer aldri inn en postkasse-id i en forespørsel.

## Steg 2: Legg til koblingen i ChatGPT

1. Slå på **utviklermodus** i ChatGPT-innstillingene, under de avanserte innstillingene for apper og koblinger.
2. Opprett en ny kobling og gi den et navn.
3. Lim inn denne kobling-URL-en:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Velg **OAuth** som autentiseringsmetode, opprett koblingen, og autoriser deretter med MCP Emails.
5. Åpne en ny samtale, klikk **+**, velg **Developer mode** og velg MCP Emails-appen. ChatGPT ser bare verktøyene i en samtale der du har gjort dette, så gjenta det i hver nye samtale.

Velg OAuth, ikke "ingen autentisering". Denne serveren avviser anonyme kall, så en kobling opprettet uten autentisering ser riktig ut under oppsettet og feiler så ved første verktøykall, som er den forvirrende rekkefølgen. Med OAuth registrerer ChatGPT seg selv og fullfører en authorization code-flyt med PKCE: ingen klient-id å opprette, ingen klienthemmelighet noe sted. Ordlyden i menyene flytter seg mens OpenAI itererer på betaen, så sjekk [oppsettssiden for ChatGPT](/docs/chatgpt) for gjeldende sti.

## Steg 3: Godkjenn bare de tilgangene du trenger

Samtykkeskjermen er vår, ikke OpenAIs. Det første samtykket starter på \`read:email\`, som er nok til triagering, oppsummering og til å finne ting, og det tar hver eneste irreversible handling av bordet mens du bestemmer deg for hvor langt du vil gå. De andre tilgangene er \`send:email\`, \`search:email\` og \`manage:automations\`.

Å gi for lite er til å rette opp i: et kall som trenger en tilgang tokenet ditt mangler, kommer tilbake som en 403 med en insufficient scope-feil, så klienten kan be om samtykke på nytt for den tilgangen og prøve igjen. En innbokseier kan også kreve [menneskelig godkjenning](/blog/approve-ai-agent-email-sends) i dashbordet, som holder tilbake hver sending, hvert svar, hver videresending, hver utkastsending og hver planlagt sending til en person slipper den gjennom.

## Steg 4: Gi ChatGPT en trygg første oppgave

Start med lesetilgang:

> Oppsummer de tre nyeste uleste e-postene mine og marker alt som trenger svar i dag. Ikke send, flytt eller slett noe.

ChatGPT finner innboksen først, og leser så bare meldingene den trenger. Når det fungerer, kan du prøve:

- "Finn fakturaen fra Stripe fra forrige måned og fortell meg beløpet."
- "Skriv et svar til den nyeste meldingen fra Alex, men la det ligge som utkast."
- "Vis meg nyhetsbrev fra denne uken jeg kunne arkivert, og vent på bekreftelsen min."

For rutiner du gjentar, start fra [triageringsoppskriften for innboksen](/blog/ai-agent-triage-summarize-inbox) eller [samlingen med arbeidsflyt-forespørsler](/blog/ai-agent-email-workflows-and-prompts).

## Dette kan ChatGPT gjøre når det er koblet til

MCP Emails gir ChatGPT målrettede e-postverktøy i stedet for et passord eller en rå IMAP-forbindelse:

- **Lese og søke:** \`email_read\` dekker list, read, read_batch, search og attachment. Gmail-søk godtar operatorer som \`from:\` og \`is:unread\`.
- **Sende, svare og videresende:** \`email_compose\` sender gjennom din egen leverandør og adresse.
- **Organisere:** \`email_organize\`, \`email_search_and_move\` og \`email_delete\`.
- **Utkast, mapper og planlegging:** \`draft\`, \`draft_list\`, \`folder\`, \`folder_list\`, \`schedule\` og \`schedule_list\`.
- **Resten:** \`contact_search\`, \`signature_get\`, \`signature_set\`, pluss \`automation\` og \`automation_read\` for gjentakende regler.

Én begrensning å planlegge rundt: MCP Emails er basert på polling. Det finnes ingen webhooks og ingen hendelser serveren starter selv, så ChatGPT ser etter ny post når du ber den om det, ikke i det øyeblikket en melding lander.

## OpenAI Codex i terminalen

Codex er en annen flate enn ChatGPT-koblinger, og OAuth-flyten i nettleseren er ikke veien der. En terminalklient autentiserer med et bearer-token i stedet:

1. I dashbordet åpner du **API Keys** og oppretter en nøkkel. Kryss av bare for tilgangene denne agenten trenger.
2. Kopier nøkkelen med en gang. Den ser ut som \`mcpe_\` etterfulgt av 64 heksadesimale tegn, og vises bare én gang.
3. Registrer \`https://mcpemails.com/api/mcp\` som en streambar HTTP MCP-server i Codex sin egen MCP-serverkonfigurasjon, og send nøkkelen som en \`Authorization: Bearer\`-header.

Nøkkel- og OAuth-tilkoblinger treffer det samme endepunktet og ser den samme verktøykatalogen. Den eneste forskjellen er hvor tokenet kom fra. For å teste endepunktet først har [veiledningen for rå HTTP](/docs/curl) et \`tools/list\`-kall på én linje, og [OAuth mot API-nøkler](/blog/oauth-vs-api-keys-ai-email-access) forklarer når hver vei er den riktige.

Avgrens nøkkelen stramt. Bare lesetilgang er som regel riktig for en kodeagent: en som kan oppsummere en supporttråd er nyttig, en som kan sende e-post uten tilsyn er en helt annen risikokategori.

## Feilsøking

- **Ingen mulighet til å opprette en egendefinert kobling.** Utviklermodus krever Plus, Pro, Business, Enterprise eller Edu, på chatgpt.com i en nettleser. Free- og Go-kontoer har det ikke. I et Business- eller Enterprise-arbeidsområde må en administrator tillate det.
- **Koblingen feiler ved første verktøykall.** Den ble sannsynligvis opprettet uten autentisering. Slett den og opprett den på nytt med OAuth.
- **Koblingen er opprettet, men ChatGPT svarer uten å røre e-posten din.** Den er ikke slått på i denne samtalen. Klikk **+**, velg **Developer mode** og velg MCP Emails-appen, og spør igjen.
- **Leverandøren avviser passordet ditt.** Bruk et apppassord generert av leverandøren, ikke passordet du logger inn med på nettet. Noen leverandører utsteder det bare når tofaktorautentisering er slått på.
- **En egendefinert IMAP-tilkobling får tidsavbrudd.** Bekreft vert, port og TLS-modus. Port 993 bruker normalt implisitt TLS. Port 143 bruker normalt STARTTLS.
- **ChatGPT kobler til, men ser ingen post.** Sjekk at innboksen er aktiv i dashbordet, bekreft at tilkoblingen har \`read:email\`, og be ChatGPT kalle \`inbox_list\` først.

## Vanlige spørsmål

**Kan ChatGPT lese og sende e-posten min?**
Gjennom en egendefinert MCP-kobling, ja: lese, søke, sende, svare, videresende, organisere og planlegge, alt begrenset til tilgangene du godkjenner under oppsettet.

**Trenger jeg en API-nøkkel for ChatGPT?**
Nei. Velg OAuth, så registrerer ChatGPT seg selv og fullfører flyten. API-nøkler er for klienter som ikke kan kjøre en nettleserflyt, som Codex og skript.

**Settes Codex opp på samme måte?**
Nei. Codex er en terminalflate, så den bruker en avgrenset API-nøkkel i en \`Authorization: Bearer\`-header i stedet for OAuth-flyten i nettleseren. Samme endepunkt, samme verktøy.

**Lagres e-posten min på serverne deres?**
Nei. Hver melding hentes direkte fra leverandøren din for den forespørselen som ba om den, og forkastes deretter. Bare den krypterte leverandørlegitimasjonen beholdes. [Hvorfor det betyr noe at e-post aldri lagres](/blog/why-email-never-stored-matters) forklarer resonnementet.

**Hva koster det?**
Gratis dekker én tilkoblet innboks og 150 fakturerbare e-posthandlinger per UTC-kalendermåned, med de første 7 dagene utelatt fra tellingen. Den månedlige grensen gjelder arbeidsområder opprettet 13.09.2026 eller senere. Arbeidsområder opprettet tidligere er unntatt. Personal koster $5 per måned for 3 innbokser uten månedlig handlingsgrense, og Pro koster $15 per måned for ubegrenset antall innbokser. Se [priser](/pricing).

## Neste steg

[Start gratis](/signup), koble til en innboks, legg \`https://mcpemails.com/api/mcp\` til i ChatGPT, og be den oppsummere den uleste posten din. [Oppsettssiden for ChatGPT](/docs/chatgpt) har gjeldende klikkesti, og [dokumentasjonen](/docs) har den fullstendige verktøyreferansen.`,
};

export default translation;
