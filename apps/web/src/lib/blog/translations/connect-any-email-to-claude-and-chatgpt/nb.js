const translation = {
  title: 'Slik kobler du enhver e-postkonto til Claude eller ChatGPT (Yahoo, IMAP, eget domene, flere postkasser)',
  description:
    'Alle måtene å gi Claude eller ChatGPT en ekte postkasse per november 2026: hva de innebygde koblingene for Gmail, Outlook og iCloud dekker, hvor de stopper, og hvordan du kobler til Yahoo, et eget domene, GMX eller flere postkasser med en MCP-server, en skrivebordsapp eller et automatiseringsverktøy.',
  coverAlt: 'Yahoo, IMAP, eget domene og flere andre postkasser koblet til Claude og ChatGPT',
  content: `Både Claude og ChatGPT har innebygde e-postkoblinger, og begge stopper ved de store leverandørene. Ligger e-posten din hos Yahoo, AOL, GMX, på et firmadomene hos IONOS, OVH eller et cPanel-webhotell, eller fordelt på flere kontoer, trenger du noe annet. Denne guiden lister opp alle alternativene per november 2026: de innebygde koblingene og nøyaktig hvor de slutter, de driftede MCP-tjenestene som fyller gapet (MCPEmails er én av dem, og vi nevner de andre), de lokale og selvdriftede veiene, og automatiseringsplattformene. Alle påstander om andre produkter ble lest på produktets egen side 11. november 2026; kildene står nederst.

**Gå til:** [Innebygde koblinger](#hva-de-innebygde-koblingene-dekker) · [Det som mangler](#hva-de-innebygde-koblingene-ikke-dekker) · [Driftede MCP-tjenester](#driftede-mcp-tjenester) · [Skrivebord og selvdrift](#skrivebordsapper-og-selvdriftede-servere) · [Automatiseringsverktøy](#automatiseringsplattformer) · [Sammenligningstabell](#alternativene-side-om-side) · [Oppsett med MCPEmails](#slik-gjør-du-det-med-mcpemails) · [FAQ](#faq)

## Hva de innebygde koblingene dekker

Start her, for hvis den eneste postkassen din er Gmail, en Microsoft 365-jobbkonto eller iCloud, trenger du kanskje ikke noe mer.

**Claude: Gmail.** Gmail-koblingen i Claudes katalog er laget av Google. Den leser og søker i e-post, lager utkast, sender, svarer, videresender, håndterer etiketter og flytter meldinger til papirkurven, og som standard ber Claude om godkjenning før hver av disse handlingene. Anthropics hjelpesenter beskriver den som å nå "the Google account you've connected": én Google-konto per tilkobling. Vedlegg kommer bare gjennom som metadata. Den er tilgjengelig for alle Claude-brukere; på Team og Enterprise slår en eier den på først.

**Claude: Microsoft 365 og privat Outlook.com.** To tilfeller. En jobb- eller skolekonto trenger en Microsoft Entra-tenant, et engangssamtykke fra en Global Administrator, og er skrivebeskyttet til organisasjonen slår på skriveverktøy. En privat Microsoft-konto (Outlook.com, Hotmail, Live eller MSN) kobles til på Free, Pro, Max og Ultra uten administrator, med skriveverktøy inkludert, så Claude kan lage utkast, sende og ordne e-post og spør før den gjør det; dette valget vises ikke på Team og Enterprise, og skriveverktøyene håndterer ikke vedlegg.

**Claude: Spark.** Spark Mails kobling står i Claudes katalog og er den ene innebygde veien til Yahoo eller IMAP i Claude, med en hake: den leser kontoene du har lagt til i Spark-skrivebordsappen, og verktøyene finnes bare mens Spark Desktop kjører på Macen eller PC-en din. Mer under [skrivebordsapper](#skrivebordsapper-og-selvdriftede-servere).

**ChatGPT: Gmail og Outlook.** Begge er apper under **Settings**, deretter **Plugins**. Siden juni 2026 kan ChatGPT lage utkast og sende fra en tilkoblet Gmail- eller Outlook-konto, på nettet, for Plus, Pro, Business og Enterprise. Siden august 2026 kan Gmail-pluginen holde flere Google-kontoer, og OpenAI utvidet senere flere kontoer til andre plugins på alle abonnementer. Outlook Email-appen er dokumentert for Microsoft-jobbkontoer: hva den får gjøre avhenger av Microsoft Entra-samtykke og arbeidsområdets innstillinger, og den kan lese, flytte og sende ren tekst fra en delt eller delegert postkasse du allerede har tilgang til. OpenAIs side beskriver ikke private Outlook.com-kontoer; [Koble ChatGPT til Outlook.com og Hotmail](/blog/connect-chatgpt-to-outlook-com-hotmail) dekker det folk støter på.

**ChatGPT: iCloud Mail.** Lagt til 27. oktober 2026 og rulles ut til alle ChatGPT-abonnementer på nettet, i skrivebordsappen og på iOS. Den logger inn med et app-spesifikt passord fra Apple og tar en adresse som slutter på @icloud.com, @me.com eller @mac.com, så en Gmail- eller Yahoo-konto som ligger ved siden av iCloud i Apple Mail er ikke med. Kontaktoppslag er skrivebeskyttet. Detaljer i [ChatGPTs iCloud Mail-plugin](/blog/chatgpt-icloud-mail-plugin).

**Leverandørens egen MCP-server.** Fastmail drifter en på \`api.fastmail.com/mcp\`, med separat lese-, skrive- og sendetilgang, ingen tilgang til vedlegg, og én Fastmail-konto per tilkobling i Claude. Zoho Mail drifter også en, gratis på gratis og betalte Zoho-abonnementer, med sending, svar, etiketter, flagg og mapper, og den kan bære verktøy fra andre Zoho-tjenester. Hver av dem betjener postkassene den leverandøren har, og hver legges til i Claude eller ChatGPT som en egendefinert kobling.

## Hva de innebygde koblingene ikke dekker

Sett listen over sammen, og dette er postkassene uten innebygd vei i noen av assistentene:

- **Yahoo Mail og AOL.** Ingen kobling i Claude, ingen plugin i ChatGPT.
- **Et eget domene hos et webhotell eller en e-postleverandør.** cPanel og delt webhotell, IONOS, OVH, Namecheap, GoDaddy, Hostinger, STRATO, one.com, Migadu og resten. Dette er IMAP- og SMTP-postkasser, og ingen av assistentene snakker IMAP.
- **Regionale leverandører.** GMX, web.de, T-Online, Orange, Libero, Seznam, Yandex, mail.ru og lignende.
- **Flere postkasser i én tilkobling.** ChatGPTs Gmail-plugin kan holde flere Google-kontoer, og ChatGPT lar deg koble til flere apper ved siden av hverandre. Ingen av assistentene har en innebygd måte å nå en Gmail, en Yahoo og en IMAP-firmapostkasse gjennom én tilkobling som vet hvilken som er hvilken.
- **Privat Outlook.com i ChatGPT.** Dokumentert for Claude på de private abonnementene; ikke beskrevet på OpenAIs Outlook-side.
- **Andre klienter enn Claude og ChatGPT.** Cursor, Codex, Gemini CLI, VS Code, Zed og andre MCP-klienter har ingen egen e-postkobling. Alt som er en vanlig MCP-server fungerer i dem; en kobling som bor inne i én assistent gjør det ikke.

Resten av guiden handler om å dekke den listen.

## Driftede MCP-tjenester

En driftet MCP-e-postserver logger inn på postkassen for deg, over IMAP og SMTP eller leverandørens eget API, og gjør postkassen tilgjengelig for enhver MCP-klient gjennom én URL. Du legger URL-en til i Claude som en egendefinert kobling og i ChatGPT som en egen MCP-server. Tjenestene under gjør alle dette; de skiller seg på leverandører, drift og pris. Vår rangerte og daterte sammenligning, med svakhetene til hver av dem, er [de beste MCP-serverne for e-post](/best-email-mcp-servers).

- **MCPEmails** (dette nettstedet). Gmail og Google Workspace med et Google-app-passord, Outlook.com og Microsoft 365 med Logg inn med Microsoft, iCloud, Fastmail, Yahoo, AOL, Zoho, Yandex og enhver IMAP- og SMTP-vert med app-passord eller e-postpassord. Flere postkasser i enhver blanding bak én URL, der hver sender fra sin egen adresse. Fungerer i Claude, ChatGPT, Cursor, Codex og de andre [støttede klientene](/docs/clients). En sperre per postkasse kan la hver sending vente på godkjenningen din. E-post hentes live og lagres ikke.
- **Mailbox MCP** (mailbox-mcp.com). Microsoft 365 og Outlook.com over Microsoft-innlogging, Gmail med app-passord, iCloud og enhver IMAP-vert, med oppsettsguider for Yahoo og GMX/WEB.DE. Fungerer i Claude, ChatGPT, Grok, Cursor, VS Code, Zed, Windsurf, Cline og andre. Tilgangsnivåer per tilkobling fra bare lesing til sending og sletting. Flere postkasser, hver på sitt eget abonnement. Har også kalender- og adressebokverktøy.
- **MailMCP** (mailmcp.io). Enhver leverandør som støtter IMAP og SMTP, med serverinnstillinger som oppdages for de vanlige. Fungerer i Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n og LibreChat. Sender, og kan planlegge en sending. Flere kontoer fra ett dashbord, hver med egne påloggingsdetaljer. Data driftet i Frankrike.
- **Mailopoly** (mailopoly.com). En e-postapp med samlet innboks for Gmail, Outlook, iCloud, Yahoo og IMAP, der MCP-serveren følger med appen. Står i katalogene til Claude og ChatGPT, og enhver klient for eksterne MCP-servere fungerer. Sending ligger bak en tillatelse og er merket bekreft-først. Én tilkobling dekker alle kontoene du eier.

Alle fire setter en tredjepart mellom assistenten og postkassen din, så les hvordan hver av dem håndterer påloggingsdetaljer og meldingsinnhold før du velger. [Er det trygt å gi en AI-agent tilgang til e-posten?](/blog/is-it-safe-to-give-ai-agent-email-access) er vårt syn på hva du bør se etter.

## Skrivebordsapper og selvdriftede servere

Vil du heller holde e-posten på din egen maskin, finnes det tre veier.

- **En skrivebordsapp for e-post med MCP-kobling.** Sparks kobling for Claude (Spark Mail Limited, Anthropic verified) gjør "any Spark email account, including Gmail, Outlook, Exchange, iCloud, Yahoo, and IMAP" tilgjengelig, med et nivå per konto (bare lesing, triage eller sending) satt under **Spark Desktop, Settings, AI Agents**. Den kan svare, videresende og planlegge. Begrensningen ligger i designet: verktøyene finnes bare mens Spark Desktop kjører, så den passer for Claude på maskinen du jobber ved, ikke for en planlagt oppgave eller en telefon. Det er en Claude-kobling, ikke en server andre klienter kan bruke.
- **En åpen IMAP-server du kjører selv.** Wh1isper/mcp-email-server er en IMAP- og SMTP-server for flere kontoer, BSD-3-Clause, startet med \`uvx\` eller en container og konfigurert gjennom et lokalt grensesnitt. Påloggingsdetaljene og e-posten forlater aldri maskinen. Claude Desktop og de fleste kodeverktøy kan kjøre en lokal server; Claude på nettet og ChatGPT kobler seg bare til eksterne servere, så denne veien er for skrivebordet.
- **Selvdriftet MCPEmails.** Samme server som kjører mcpemails.com er åpen kildekode under AGPL-3.0. [Kjør den selv](/self-hosting) mot din egen database og krypteringsnøkkel, med avgrensede API-nøkler per klient. Claude og ChatGPT når den bare når den har en offentlig HTTPS-adresse.

## Automatiseringsplattformer

Både Zapier og Make gjør nå appkatalogene sine tilgjengelige for MCP-klienter, som gir Claude eller ChatGPT en måte å handle i en postkasse gjennom en arbeidsflyt i stedet for en postkassetilkobling.

- **Zapier MCP** fungerer med Claude, ChatGPT, Cursor "and any other AI client", på tvers av 9 000+ apper. Gmail er blant dem, og Microsoft Outlook-appen lister Send Email, Find Emails og Create Draft Email som MCP-verktøy. Det er inkludert i alle Zapier-abonnementer, og hvert verktøykall bruker to oppgaver av kvoten din. Siden vi leste lister apper ved navn og beskriver ikke en generisk IMAP-postkasse.
- **Make MCP** fungerer med ChatGPT, Claude, Cursor og enhver MCP-agent. Du bygger et scenario i Make (et Gmail- eller Outlook-søk, en sending), og scenarioet blir et verktøy assistenten kan kalle. Det er inkludert i alle Make-abonnementer, også gratisabonnementet, og du betaler for operasjonene scenarioene bruker.

Disse passer når e-post er ett steg i en større automatisering du allerede kjører i Zapier eller Make. For en samtale om innboksen din ("hva trenger svar i dag?") er en postkassetilkobling det bedre verktøyet, fordi assistenten kan søke, lese og følge opp uten et scenario for hvert spørsmål.

## Alternativene side om side

| Alternativ | Hvilke postkasser | Hvilke AI-apper | Sender | Flere postkasser |
| --- | --- | --- | --- | --- |
| Claudes Gmail-kobling | Én Google-konto | Claude | Ja, spør først | Nei |
| Claudes Microsoft 365-kobling | Entra-jobbkontoer; privat Outlook.com, Hotmail, Live, MSN på Free, Pro, Max, Ultra | Claude | Jobb: når administrator slår på skriveverktøy. Privat: ja | Nei |
| ChatGPTs Gmail- og Outlook-apper | Google-kontoer; Microsoft-jobbkontoer, delte og delegerte postkasser | ChatGPT | Ja, på nettet, Plus og oppover | Gmail: flere Google-kontoer |
| ChatGPTs iCloud Mail-plugin | iCloud (@icloud.com, @me.com, @mac.com) | ChatGPT | Ja | Ikke oppgitt |
| Fastmails eller Zohos MCP-server | Den leverandørens postkasser | Enhver MCP-klient | Ja | Fastmail i Claude: én konto. Zoho: hvis klienten tillater flere tilkoblinger |
| Spark-koblingen | Enhver konto i Spark Desktop, også Yahoo og IMAP, mens appen kjører | Claude | Ja, nivå per konto | Ja |
| MCPEmails | Gmail, Outlook og Microsoft 365, iCloud, Fastmail, Yahoo, AOL, Zoho, Yandex, enhver IMAP | Claude, ChatGPT, Cursor, Codex, enhver MCP-klient | Ja, valgfri sperre for godkjenning | Ja, én URL |
| Mailbox MCP | Microsoft 365 og Outlook.com, Gmail, iCloud, enhver IMAP | Claude, ChatGPT, Grok, Cursor, VS Code, Zed, Windsurf, Cline | Ja, nivå per tilkobling | Ja, per postkasse |
| MailMCP | Enhver IMAP- og SMTP-leverandør | Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n, LibreChat | Ja, også planlagt | Ja |
| Mailopoly | Gmail, Outlook, iCloud, Yahoo, IMAP | Claude, ChatGPT, enhver klient for eksterne MCP-servere | Ja, bak en tillatelse | Ja |
| Wh1isper/mcp-email-server (selvdriftet) | Enhver IMAP- og SMTP-leverandør | Lokale MCP-klienter | Ja | Ja |
| Zapier MCP, Make MCP | Appene i katalogene deres, Gmail og Outlook blant dem | Claude, ChatGPT, Cursor, enhver MCP-klient | Ja, gjennom en handling eller et scenario | Per apptilkobling |

"Ikke oppgitt" betyr at siden vi leste ikke sa noe om det. Abonnementer og priser er bevisst utelatt: de endrer seg, og hver leverandørs prisside er stedet å lese dem.

## Slik gjør du det med MCPEmails

Tre steg, omtrent fem minutter, og resultatet fungerer i Claude og ChatGPT samtidig.

1. **Koble til postkassen.** [Opprett en gratis konto](/signup), åpne **Innbokser**, klikk **Koble til innboks** og velg leverandøren. [Yahoo Mail](/connect/yahoo) og [AOL](/connect/aol) tar et app-passord fra siden Account Security. En firmaadresse hos et webhotell legges inn som [IMAP](/connect/imap): skriv adressen, og serverinnstillingene fylles inn for de fleste verter, med egne sider for [cPanel](/connect/cpanel), [IONOS](/connect/ionos), [OVH](/connect/ovh), [Namecheap](/connect/namecheap) og [GoDaddy](/connect/godaddy). Tyske lesere har [GMX](/connect/gmx), [web.de](/connect/web-de) og [T-Online](/connect/t-online). Alle sidene under [connect](/connect) lister vertene vi kjenner. Gjenta for hver postkasse; abonnementet avgjør hvor mange som får plass.
2. **Legg koblingen til i AI-appen din.** I Claude åpner du **Customize**, deretter **Connectors**, klikker **+ Add**, velger **Add custom connector** og limer inn \`https://mcpemails.com/api/mcp\`. I ChatGPT, på chatgpt.com i en nettleser med et betalt abonnement, åpner du **Plugins**, klikker plussknappen, velger **Add custom MCP server**, limer inn samme URL og velger OAuth; OpenAIs hjelpeside har de gjeldende abonnementsreglene. Sidene per klient ([Claude](/docs/claude), [ChatGPT](/docs/chatgpt), [Cursor](/docs/cursor), [Codex](/docs/codex) og [resten](/docs/clients)) har skjermbilder og de vanlige feilene.
3. **Spør.** "Vis ulest Yahoo-post fra i dag" eller "søk i salg@ og post@ etter noe fra denne uken som ingen har svart på". Assistenten kaller \`inbox_list\` først, så den vet hvilken postkasse som er hvilken, og hvert svar går ut fra postkassen det hører til.

Slå på **Gjennomgang før sending** (Review before sending) på en postkasse, så venter hver sending fra den på godkjenningen din i dashbordet. Det er inkludert på alle abonnementer.

## FAQ

### Kan jeg koble Yahoo Mail til Claude eller ChatGPT?

Ikke med de innebygde koblingene: per november 2026 dekker Claudes e-postkoblinger Gmail og Microsoft-kontoer, og ChatGPTs plugins dekker Gmail, Outlook og iCloud Mail. Yahoo kobles til gjennom en MCP-server som MCPEmails, med et Yahoo-app-passord, eller gjennom Spark-koblingen i Claude mens Spark Desktop kjører. [Yahoo Mail i ChatGPT og Claude](/blog/connect-yahoo-mail-to-chatgpt-and-claude) har stegene.

### Hvordan kobler jeg en postkasse på eget domene hos cPanel, IONOS eller OVH til Claude?

Gjennom IMAP. Verken Claude eller ChatGPT snakker IMAP selv, så du kobler postkassen til en MCP-server som gjør det (MCPEmails, Mailbox MCP, MailMCP eller en server du kjører selv) og legger den serveren til i Claude som en egendefinert kobling. Med MCPEmails skriver du adressen, vertens innstillinger fylles inn, og sidene for [cPanel](/connect/cpanel), [IONOS](/connect/ionos) og [OVH](/connect/ovh) dekker det hver vert krever.

### Kan Claude eller ChatGPT lese flere e-postkontoer samtidig?

ChatGPTs Gmail-plugin kan holde flere Google-kontoer. For en blanding av leverandører, eller for Claude, trenger du én MCP-server som holder alle postkassene: MCPEmails, Mailbox MCP, MailMCP, Mailopoly og de selvdriftede serverne gjør alle dette, og assistenten navngir postkassen i hvert kall. [Flere e-postkontoer i Claude og ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) viser hvordan assistenten holder dem fra hverandre.

### Fungerer Claude med en privat Outlook.com- eller Hotmail-konto?

Ja, per november 2026. Anthropics hjelpesenter sier at en privat Microsoft-konto (Outlook.com, Hotmail, Live eller MSN) kobles til på Free, Pro, Max og Ultra uten administrator, med skriveverktøy inkludert. Valget vises ikke på Team og Enterprise. En MCP-server som MCPEmails kobler også til Outlook.com med Logg inn med Microsoft, og da fungerer samme postkasse i ChatGPT og andre klienter også.

### Trenger jeg e-postpassordet mitt?

Vanligvis ikke hovedpassordet. Yahoo, AOL, iCloud, Gmail, Fastmail og Zoho utsteder et app-passord for andre apper, og en postkasse hos et webhotell bruker postkassens eget passord. AI-appen ser det aldri: MCP-serveren holder det kryptert, og AI-appen logger inn på serveren med OAuth. [Hva er et app-passord?](/blog/what-is-an-app-password) forklarer hvor hver leverandør gjemmer det.

### Kan jeg bruke samme innboks i Cursor, Codex eller en annen MCP-klient?

Ja, hvis innboksen ligger bak en vanlig MCP-server. Én URL fra MCPEmails, Mailbox MCP eller MailMCP fungerer i Claude, ChatGPT, Cursor, Codex, VS Code og resten. En kobling som bor inne i én assistent, som Claudes Gmail-kobling eller ChatGPTs iCloud-plugin, blir i den assistenten.

### Lagres e-posten min av MCP-serveren?

Det avhenger av tjenesten, så les personvernsiden til hver av dem. MCPEmails henter hver melding live fra leverandøren din når assistenten spør, og lagrer den ikke; bare den krypterte påloggingen beholdes, pluss en melding du planlegger eller holder for godkjenning til den er sendt. Mailopoly er en e-postapp, så kontoene dine synkroniseres inn i den. De selvdriftede alternativene holder alt på din egen maskin.

## Kilder

Lest 11. november 2026: Anthropics hjelpeartikler om [Google Workspace-koblingene](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors), [Microsoft 365-koblingen for organisasjoner](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) og [tilkobling til Microsoft 365](https://support.claude.com/en/articles/15183774-connect-to-microsoft-365); oppføringene for [Gmail](https://claude.com/connectors/gmail) og [Spark](https://claude.com/connectors/spark) i Claudes katalog; OpenAIs sider om [tilkoblede apper](https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt), [Outlook Email- og Calendar-appene](https://help.openai.com/en/articles/12512241-outlook-email-and-calendar-apps-in-chatgpt), [egne MCP-servere](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) og [versjonsnotatene](https://help.openai.com/en/articles/6825453-chatgpt-release-notes); [Fastmails MCP-artikkel](https://www.fastmail.help/hc/en-us/articles/15869557281295); [Zoho Mail MCP](https://www.zoho.com/mail/help/mcp/getting-started.html); [Mailbox MCP](https://mailbox-mcp.com/), [MailMCP](https://mailmcp.io/en/features) og [Mailopoly](https://www.mailopoly.com/mcp/); [Wh1isper/mcp-email-server](https://github.com/Wh1isper/mcp-email-server); [Zapier MCP](https://zapier.com/mcp) og [Outlook-appen](https://zapier.com/apps/mcp-client-by-zapier/integrations/microsoft-outlook) der; [Make MCP](https://www.make.com/en/mcp). Har noe av dette endret seg siden, [si fra](/help), så oppdaterer vi siden.

## Neste steg

[Start gratis](/signup), koble til postkassen de innebygde koblingene ikke ville ta, og lim én URL inn i Claude eller ChatGPT. Sammenligningen av [innebygde koblinger og MCP-servere](/native-connectors-vs-mcp) går dypere inn i avveiningen.`,
};

export default translation;
