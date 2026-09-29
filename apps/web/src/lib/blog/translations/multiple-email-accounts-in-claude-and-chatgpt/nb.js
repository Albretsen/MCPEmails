const translation = {
  title: 'Flere e-postkontoer i Claude og ChatGPT: alle postkassene, én kobling',
  description:
    'Slik får du flere e-postkontoer inn i Claude og ChatGPT samtidig, også firmapostkasser hos IONOS, Zoho, Namecheap, Google Workspace eller på din egen server, med én MCP-kobling som fungerer i begge.',
  coverAlt:
    'Flere e-postkontoer for jobb og privat koblet til Claude og ChatGPT gjennom én MCP-kobling',
  content: `Du vil stille ett spørsmål og få svar på tvers av alle postkassene du har ansvar for: din egen adresse, post@, salg@, fakturainnboksen, kanskje en privat Gmail. Denne guiden viser hvordan du får flere e-postkontoer inn i Claude og ChatGPT samtidig, hva de innebygde koblingene allerede dekker, og hvor du trenger en MCP-server i stedet.

**Hopp til:** [Innebygde koblinger](#hva-de-innebygde-koblingene-gjr) · [Én kobling for alle postkassene](#n-kobling-for-alle-postkassene) · [Oppsett i Claude](#legg-den-til-i-claude) · [Oppsett i ChatGPT](#legg-den-til-i-chatgpt) · [Planer](#hvor-mange-postkasser-hver-plan-kobler-til)

## Hva de innebygde koblingene gjør

Begge assistentene har egne e-postkoblinger, og de har endret seg raskt, så her er status da dette ble skrevet (september 2026).

- **ChatGPT.** Siden slutten av august 2026 kan ChatGPTs egne programtillegg for Gmail, Google Calendar og Google Contacts ha mer enn én konto på Plus, Pro, Business og Enterprise, så en privat Gmail og en jobb-Gmail kan være med i samme samtale. I september utvidet OpenAI støtten for flere kontoer til andre programtillegg. Hvis alle postkassene dine er Google-kontoer, kan ChatGPTs eget programtillegg være alt du trenger.
- **Claude.** Anthropics hjelpesenter beskriver Gmail-koblingen som en kobling som når «the Google account you've connected». Én Google-konto per tilkobling.

Det ingen av dem er laget for, er postkassen et firma faktisk bruker på sitt eget domene når domenet ikke ligger hos Google eller Microsoft: IONOS, Zoho Mail, Namecheap Private Email, STRATO, Migadu, et cPanel-webhotell eller din egen server. De snakker IMAP og SMTP, og for å nå dem trenger du noe som snakker IMAP.

## Én kobling for alle postkassene

MCP Emails er en driftet MCP-server. Du kobler hver postkasse til den én gang, og AI-klienten din når alle sammen gjennom én URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Hvilken som helst blanding av leverandører.** Gmail og Google Workspace (app-passord eller Logg inn med Google), Outlook og Microsoft 365 (Logg inn med Microsoft), iCloud, Fastmail, Yahoo, Zoho, Yandex og enhver postkasse som snakker IMAP og SMTP. Det finnes en side per leverandør under [connect](/connect), blant annet [IONOS](/connect/ionos), [Zoho Mail](/connect/zoho), [Namecheap](/connect/namecheap), [STRATO](/connect/strato), [Migadu](/connect/migadu), [Google Workspace](/connect/google-workspace) og [Microsoft 365](/connect/office365).
- **De samme postkassene i begge assistentene.** Det er en vanlig MCP-server, så den ene tilkoblingen fungerer i Claude og i ChatGPT, og også i Cursor, VS Code og andre MCP-klienter. Legg til en postkasse én gang, så ser alle klientene den.
- **Agenten vet hvilken postkasse som er hvilken.** Den kaller \`inbox_list\` og får hver tilkoblede adresse med visningsnavnet. Alle andre verktøy oppgir hvilken postkasse de jobber i, så du sier bare «i salg@» med vanlige ord.
- **Svarene går ut fra riktig adresse.** Hver postkasse sender gjennom sin egen leverandør eller SMTP-server, med sitt eget avsendernavn og sin egen signatur. Et svar i en tråd i support@ sendes fra support@.

E-post hentes direkte ved hver forespørsel og lagres ikke. Det eneste unntaket er en melding du planlegger å sende senere, som holdes tilbake til den er sendt.

## Koble til postkassene

I MCP Emails-dashbordet åpner du **Inboxes** og deretter **Connect Inbox**, én gang per postkasse:

- **Firmapostkasse på eget domene.** Velg **IMAP** og skriv inn adressen. Vanlige leverandører gjenkjennes ut fra adressen, og et Google Workspace-domene gjenkjennes ut fra e-postoppføringene i DNS, så innstillingene fyller seg inn selv. Bruk passordet eller app-passordet leverandøren din krever.
- **Gmail eller Google Workspace.** Et app-passord, eller Logg inn med Google. I Workspace er det administratoren din som avgjør om app-passord og IMAP er tillatt.
- **Outlook eller Microsoft 365.** Logg inn med Microsoft. En jobb- eller skolekonto kan trenge at en IT-ansvarlig først godkjenner appen én gang for hele organisasjonen.

Gi hver postkasse et tydelig visningsnavn, for eksempel «Acme Salg» i stedet for «work2». Det er det agenten leser for å skille dem fra hverandre, og det er navnet mottakerne ser.

## Legg den til i Claude

I claude.ai eller Claude Desktop:

1. Åpne **Settings** og deretter **Connectors**.
2. Velg **Add custom connector** og lim inn \`https://mcpemails.com/api/mcp\`.
3. Velg **Connect**, logg inn på MCP Emails og godkjenn.

Alle postkassene du har koblet til, er nå tilgjengelige. [Claude-guiden](/blog/connect-claude-to-email) har detaljene.

## Legg den til i ChatGPT

Egendefinerte koblinger krever ChatGPT Plus, Pro, Business, Enterprise eller Edu i nettleseren, med utviklermodus slått på. På Business og Enterprise må en administrator kanskje tillate det først.

1. Slå på **utviklermodus** i ChatGPT-innstillingene, under de avanserte innstillingene for apper og koblinger.
2. Opprett en kobling, lim inn \`https://mcpemails.com/api/mcp\`, velg **OAuth** og autoriser med MCP Emails.
3. I hver nye samtale klikker du **+**, velger **Developer mode** og velger MCP Emails-appen.

[ChatGPT-guiden](/blog/connect-chatgpt-to-email) går gjennom menyene og de vanlige feilene.

## Prompter som bruker flere postkasser

> Gå gjennom salg@ og post@ og list opp alle henvendelser fra denne uken som ingen har svart på. Én samlet liste, merket med postkassen de kom inn i. Ikke send eller flytt noe.

> Finn fakturaen fra Hetzner fra august. Søk i alle tilkoblede postkasser og fortell meg hvilken den ligger i.

> Skriv et utkast til svar fra support@ på den siste klagen om levering. Vis det til meg før du sender.

Ett kall når én postkasse, så «søk i alle postkassene» betyr at agenten kjører søket én gang per postkasse og slår sammen svarene. Be om én samlet liste, ellers får du én rapport per konto. [Slik håndterer du flere e-postkontoer med AI](/blog/manage-multiple-email-accounts-with-ai) går dypere inn i avgrensning, avsenderidentitet og gjennomgang per postkasse.

## Hold et menneske ved sendeknappen

Slå på **Gjennomgang før sending** (Review before sending) for en postkasse, så venter hver sending, hvert svar, hver videresending, hver sending av utkast og hver planlagte sending fra den på godkjenningen din i dashbordet. Innstillingen gjelder per postkasse, så fakturainnboksen kan holdes tilbake mens din egen sender fritt. Den er med på alle planer, også Gratis. Se [menneskelig godkjenning av e-post sendt av AI](/blog/approve-ai-agent-email-sends).

## Hvor mange postkasser hver plan kobler til

- **Gratis:** én postkasse.
- **Personal:** tre postkasser.
- **Pro:** alle postkassene du har, uten grense, på én innlogging.
- **Team:** for når en person til trenger sin egen innlogging.

Et firma med post@, salg@ og faktura@ pluss din egen adresse er fire postkasser, og det er Pro. Gjeldende priser finner du på [prissiden](/pricing), og [MCP Emails for bedrifter](/for/business) viser hvordan én person håndterer alle firmapostkassene fra én agent.

## Vanlige spørsmål

**Kan Claude bruke mer enn én e-postkonto samtidig?**
Ja, gjennom en MCP-server. Koble hver postkasse til MCP Emails, legg til én egendefinert kobling i Claude, så ser Claude alle sammen og oppgir postkassen i hvert kall.

**Kan ChatGPT bruke mer enn én e-postkonto?**
ChatGPTs eget Gmail-programtillegg kan nå ha flere Google-kontoer. For postkasser som ikke ligger hos Google, for eksempel en firmaadresse hos IONOS, Zoho eller et cPanel-webhotell, legger du til MCP Emails som en egendefinert kobling, så er alle tilkoblede postkasser tilgjengelige.

**Trenger jeg en egen kobling per postkasse?**
Nei. Én koblings-URL dekker alle postkassene i MCP Emails-arbeidsområdet ditt, og den samme URL-en fungerer i Claude, ChatGPT og andre MCP-klienter.

**Går svaret ut fra riktig adresse?**
Ja. Hver postkasse sender gjennom sin egen leverandør eller e-postserver, med sitt eget visningsnavn og sin egen signatur. Å sende fra en adresse som ikke er postkassens egen, fungerer bare for en bekreftet Gmail Send As-adresse på en postkasse som er koblet til med Logg inn med Google, og avvises ellers.

**Lagres e-posten fra alle disse kontoene?**
Nei. Meldingsinnholdet hentes direkte fra leverandøren din ved hver forespørsel og forkastes. Det som beholdes, er den krypterte påloggingen for hver postkasse. Se [sikkerhet](/security).

## Neste steg

[Start gratis](/signup) med den travleste postkassen din, legg MCP Emails-koblingen til i Claude eller ChatGPT, og spør hva som trenger svar i dag. Legg til de andre postkassene når du vil ha ett svar i stedet for flere.`,
};

export default translation;
