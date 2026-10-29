const translation = {
  title: 'Kan Claude lese e-posten min og sende e-post? Postkasse for postkasse',
  description:
    'Ja, for Gmail og Microsoft 365-jobbkontoer, med Claudes egne koblinger. Yahoo, iCloud, Outlook.com, IMAP-postkasser og flere leverandører samtidig krever en MCP-server.',
  coverAlt:
    'Claude leser og sender e-post fra Gmail, Microsoft 365, Yahoo, iCloud og IMAP-postkasser',
  content: `**Ja, Claude kan lese e-posten din og sende e-post, men bare fra en postkasse du har koblet til.** Claude har to egne e-postkoblinger (connectors), én for Gmail og én for Microsoft 365-jobbkontoer. Gmail-koblingen leser, søker og sender, og ber som standard om godkjenningen din før hver sending. Microsoft 365-koblingen leser og søker, og kan bare sende etter at en administrator har slått på skriveverktøyene. Yahoo, iCloud, en personlig Outlook.com-adresse, en firmapostkasse hos en IMAP-leverandør eller flere leverandører bak én tilkobling krever en MCP-server, for eksempel MCPEmails.

Denne siden hjelper deg å finne ut hvilket tilfelle som gjelder deg. Fakta om produktene til Anthropic og Google er hentet fra selskapenes egne sider i oktober 2026. Produktene endrer seg ofte, så hver del lenker til siden den bygger på.

**Hopp til:** [Gmail](#gmail-claudes-egen-kobling) · [Microsoft 365](#outlook-og-microsoft-365-bare-jobbkontoer) · [Det de innebygde koblingene ikke dekker](#det-de-innebygde-koblingene-ikke-dekker) · [MCPEmails](#slik-fyller-mcpemails-hullet) · [Vanlige spørsmål](#vanlige-spørsmål)

## Gmail: Claudes egen kobling

Claudes Gmail-kobling står oppført i Claudes katalog over koblinger som laget av Google, og den kjører på Googles Gmail MCP-server (\`gmailmcp.googleapis.com\`). Du slår den på fra koblingsinnstillingene i Claude og logger på med Google-kontoen din.

Dette kan den gjøre, ifølge [Anthropics hjelpeartikkel](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) og [oppføringen i katalogen](https://claude.com/connectors/gmail):

- **Lese og søke** i e-posten din med spørsmål på vanlig språk, og lese hele tråder.
- **Lage utkast, sende, svare og videresende.** Anthropics artikkel nevner alle fire.
- **Organisere** med etiketter, og flytte meldinger eller tråder til papirkurven.
- **Spørre først.** Som standard ber Claude om godkjenningen din før hver sending, hvert svar og hver videresending. På Team- og Enterprise-abonnementer må en eier først slå på koblingen for organisasjonen, og eieren bestemmer om medlemmer kan la disse handlingene kjøre uten å bli spurt.

Her stopper den:

- **Vedlegg.** Anthropics artikkel sier at Claude bare ser metadata om vedlegg, ikke innholdet.
- **Én Google-konto.** Artikkelen beskriver tilgang til «the Google account you've connected», altså Google-kontoen du har koblet til, og nevner ikke at du kan legge til en konto til.

Google dokumenterer også den samme Gmail MCP-serveren som en del av [Workspace Developer Preview Program](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server). Medlemmer av programmet kan selv legge den til i andre MCP-klienter, med sin egen OAuth-klient i Google Cloud. Den dokumenterte versjonen har verktøy for å søke, lese tråder, lage utkast og endre etiketter, men ikke for å sende: du går gjennom utkastet og sender det fra Gmail.

Er Gmail den eneste postkassen din og Claude den eneste KI-appen du bruker, kan den innebygde koblingen være alt du trenger.

## Outlook og Microsoft 365: bare jobbkontoer

Claudes Microsoft 365-kobling leser Outlook-e-post for kontoer som hører til en bedrifts Microsoft 365-tenant.

- **Lesing og søk** dekker hovedpostkassen din, arkivmappen og delte postkasser du har tilgang til.
- **Sending er av som standard.** Koblingen starter skrivebeskyttet. Når skriveverktøyene er slått på, kan Claude sende og videresende e-post og lage, redigere og slette utkast. Meldinger med vedlegg avvises av skriveverktøyene.
- **En administrator må godkjenne den.** En global administrator i Microsoft Entra i organisasjonen din må gi samtykke før noen der kan koble til, og på nytt før skriveverktøyene virker.
- **Personlige kontoer avvises.** [Anthropics artikkel](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) er tydelig: adresser som @outlook.com og @hotmail.com kan ikke brukes til å koble til.

En personlig Outlook.com-, Hotmail- eller Live-adresse har altså ingen innebygd vei inn i Claude. [Koble Claude til Outlook.com og Hotmail](/blog/connect-claude-to-outlook-com-hotmail) viser veien som fungerer.

## Det de innebygde koblingene ikke dekker

Legger du de to sammen, er dette postkassene ingen av de innebygde koblingene når:

- **Yahoo Mail og AOL.**
- **iCloud Mail.**
- **Personlige Outlook.com-, Hotmail- og Live-adresser.**
- **Firmapostkasser hos en IMAP-leverandør**: Fastmail, Zoho Mail, IONOS, STRATO, et webhotell med cPanel eller din egen server.
- **En Google-konto til.** Anthropics artikkel beskriver én tilkoblet Google-konto og nevner ikke at du kan legge til en annen.
- **Flere leverandører bak én tilkobling**, slik at ett spørsmål søker i post@, din egen adresse og en privat Gmail på en gang.

Fastmail og Zoho Mail har egne MCP-servere som du kan legge til i Claude som egendefinerte koblinger. Hver av dem når bare postkassene hos sin egen leverandør. Ingen av Claudes hjelpeartikler nevner planlagt sending til et senere tidspunkt. [Sammenligningen av de innebygde koblingene i Claude og ChatGPT](/native-connectors-vs-mcp) viser hver funksjon med kilde og datoen den ble sjekket.

## Slik fyller MCPEmails hullet

MCPEmails er en driftet MCP-server. Du kobler hver postkasse til den én gang, legger deretter til én koblings-URL i Claude, og så kan Claude lese, søke og sende fra alle postkassene du har koblet til:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Alle leverandører.** [Yahoo Mail](/connect/yahoo), [iCloud Mail](/connect/icloud), [personlig Outlook.com](/connect/outlook) og [Microsoft 365 på jobb](/connect/office365) (begge med Logg på med Microsoft), [Gmail](/connect/gmail) med et Google-apppassord, [Fastmail](/connect/fastmail) med et app-passord, [Zoho Mail](/connect/zoho) og alle postkasser som støtter [IMAP og SMTP](/connect/imap). [Den fullstendige listen over leverandører](/connect) har en side med innstillinger for hver av dem.
- **Flere postkasser i samme samtale.** Claude kaller \`inbox_list\` og ser hver tilkoblede adresse ved navn, så «søk i salg@ og i Gmailen min» fungerer i én og samme samtale. [Flere e-postkontoer i Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt) viser det oppsettet.
- **Send fra riktig adresse.** Hver postkasse sender gjennom sin egen leverandør, med sitt eget avsendernavn og sin egen signatur.
- **Planlegg og organiser.** Claude kan planlegge en sending til senere, og flytte, flagge, arkivere eller slette e-post i alle tilkoblede postkasser når du gir den Full tilgang.
- **Les vedlegg.** Claude kan [hente ut teksten fra et PDF-, CSV- eller HTML-vedlegg](/blog/extract-email-attachments-for-ai) uten at filen blir lagret.
- **De samme postkassene i andre apper.** Det er en standard MCP-server, så det samme oppsettet fungerer også i ChatGPT, Cursor, VS Code og andre MCP-klienter.

E-posten hentes direkte fra leverandøren din for hver forespørsel og lagres ikke. Dette lagres: den krypterte legitimasjonen for hver postkasse, en melding du har planlagt frem til den blir sendt, og en sending som venter på gjennomgang frem til den blir godkjent, avvist eller utløper. Data lagres i Stockholm.

### Legg den til i Claude

1. [Opprett en gratis MCPEmails-konto](/signup) og koble til en postkasse under **Innbokser**, deretter **Koble til innboks**.
2. I claude.ai eller Claude Desktop åpner du **Customize → Connectors**, klikker **+ Add** og deretter **Add custom connector**. Kall den MCPEmails, skriv inn \`https://mcpemails.com/api/mcp\`, klikk **Continue**, behold innloggingsinnstillingene Claude fant, og klikk **Add**.
3. Logg på MCPEmails når Claude ber om det, og velg hvor mye tilgang Claude skal få: **Skrivebeskyttet**, **Standard** (legger til sending og utkast) eller **Full tilgang** (legger til planlegging, mapper og sletting).

[Steg-for-steg-guiden for oppsett i Claude](/blog/connect-claude-to-email) går gjennom hvert skjermbilde og hver leverandør, og [oppsettsiden for Claude](/docs/claude) tar for seg feil med koblingen.

## Kan Claude sende e-post uten å spørre?

Det kommer an på koblingen og på deg.

- **Claudes Gmail-kobling** spør som standard før hver sending, hvert svar og hver videresending.
- **Claudes Microsoft 365-kobling** kan ikke sende i det hele tatt før skriveverktøyene er slått på.
- **MCPEmails** sender bare hvis du ga Claude tilgang til å sende da du koblet den til. Med **Skrivebeskyttet** kan Claude ikke sende. For en postkasse der hver utgående melding skal sjekkes, slår du på **Gjennomgang før sending** i innstillingene for den innboksen: hver sending venter da til en eier eller administrator av arbeidsområdet godkjenner den, logget på MCPEmails i en nettleser. Claude kan ikke godkjenne den selv. Se [menneskelig godkjenning av e-post som KI sender](/blog/approve-ai-agent-email-sends).

Uansett hvilken vei du velger, bør du behandle innholdet i en e-post som data, ikke som instruksjoner. En melding kan inneholde tekst som er skrevet for å styre en KI, og et gjennomgangssteg fanger den opp før noe forlater postkassen din. [Guiden om sikker e-posttilgang](/blog/is-it-safe-to-give-ai-agent-email-access) forklarer risikoene nærmere.

## Vanlige spørsmål

**Kan Claude lese e-posten min?**
Ja, når en postkasse er koblet til. Gmail og Microsoft 365-jobbkontoer kobles til gjennom Claudes egne koblinger. Yahoo, iCloud, personlig Outlook.com og IMAP-postkasser kobles til gjennom en MCP-server som MCPEmails, lagt til i Claude som en egendefinert kobling.

**Kan Claude sende e-post?**
Ja. Claudes Gmail-kobling kan sende, svare og videresende, og ber som standard om godkjenningen din først. Microsoft 365-koblingen kan sende når skriveverktøyene er slått på. Gjennom MCPEmails sender Claude fra hvilken som helst tilkoblet postkasse hvis du ga den tilgang til å sende da du koblet den til.

**Kan Claude lese Gmailen min?**
Ja, med Claudes innebygde Gmail-kobling, for Google-kontoen du kobler til. Vil du bruke mer enn én Google-konto, eller Gmail sammen med andre leverandører i samme samtale, kobler du dem til gjennom MCPEmails med et Google-apppassord.

**Kan Claude få tilgang til e-posten min i Outlook eller Hotmail?**
Jobb- og skolekontoer i Microsoft 365 kan bruke Claudes Microsoft 365-kobling etter at en administrator har godkjent den. Personlige Outlook.com- og Hotmail-adresser kan ikke det. MCPEmails kobler til begge med Logg på med Microsoft, men en jobbkonto kan fortsatt trenge at IT-ansvarlig godkjenner appen én gang for organisasjonen.

**Kan Claude lese e-post fra Yahoo eller iCloud?**
Ikke med en innebygd kobling. Koble postkassen til MCPEmails med et app-passord fra Yahoo eller Apple, og legg deretter til MCPEmails i Claude.

**Kan Claude lese flere e-postkontoer samtidig?**
Ja, gjennom MCPEmails. Hver postkasse du kobler til, dukker opp i Claude gjennom den ene URL-en til koblingen, og Claude oppgir hvilken postkasse den bruker i hvert kall.

**Lagrer MCPEmails e-postene mine?**
Nei. Meldingsinnholdet hentes direkte fra leverandøren din ved hver forespørsel og forkastes så snart svaret er sendt. Se [sikkerhet](/security) for hva som lagres.

## Neste steg

Ligger all e-posten din i én Gmail-konto, kan du prøve Claudes Gmail-kobling først. For alt annet kan du [starte gratis](/signup), koble til en postkasse, legge til \`https://mcpemails.com/api/mcp\` i Claude og spørre hva som trenger svar i dag.`,
};

export default translation;
