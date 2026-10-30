const translation = {
  title: 'Flere e-postkontoer i Claude Cowork, også personlig Outlook',
  description:
    'Claude Cowork når én Google-konto gjennom Gmail-koblingen, og Microsoft 365-koblingen avviser personlige Outlook-adresser. Slik gir du én Cowork-oppgave flere innbokser, både jobb og privat.',
  coverAlt:
    'E-postkontoer for jobb og privat, blant annet Gmail og Outlook.com, koblet til én oppgave i Claude Cowork',
  content: `**Claude Cowork bruker de samme koblingene som Claude-chatten, så den har de samme begrensningene for e-post: én Google-konto gjennom Gmail-koblingen, og bare Microsoft 365-jobbkontoer gjennom Microsoft 365-koblingen.** En personlig Outlook.com- eller Hotmail-adresse, en Gmail-konto til eller en firmapostkasse hos en IMAP-leverandør krever en egendefinert kobling. Med en MCP-server som MCPEmails gir én egendefinert kobling en Cowork-oppgave tilgang til alle postkassene du kobler til, hver med sitt navn.

**Hopp til:** [Innebygde koblinger](#hva-coworks-innebygde-e-postkoblinger-når) · [Flere innbokser](#flere-innbokser-i-én-cowork-oppgave) · [Oppsett](#slik-setter-du-det-opp) · [Tillatelser](#behold-kontrollen-over-sendingen) · [Vanlige spørsmål](#vanlige-spørsmål)

## Hva Coworks innebygde e-postkoblinger når

Anthropics [guide til Cowork](https://support.claude.com/en/articles/13345190-get-started-with-cowork) styrer koblinger fra den samme **Customize → Connectors**-siden som chatten, og chat og Cowork deler nå ett felles startsted i Claude-appen. Det Claude-kontoen din har koblet til, er det en Cowork-oppgave kan bruke.

- **Gmail.** Claudes Gmail-kobling leser, søker, lager utkast og sender. [Anthropics artikkel](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) beskriver tilgang til «the Google account you've connected», altså Google-kontoen du har koblet til, og sier ingenting om å legge til en konto til. En privat og en jobb-Gmail kan ikke ligge side om side gjennom den.
- **Microsoft 365.** [Microsoft 365-koblingen](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) er for kontoer i en bedrifts Microsoft 365-tenant. En global administrator må gi samtykke først, den starter skrivebeskyttet, og personlige Microsoft-kontoer som @outlook.com og @hotmail.com kan ikke brukes til å koble til.
- **Alt annet.** Yahoo, iCloud, Fastmail, Zoho, IONOS eller din egen e-postserver har ingen innebygd kobling i Claude.

Den vanlige blandingen, en jobbpostkasse pluss en personlig Outlook.com eller en Gmail-konto til, passer altså ikke inn i Cowork med bare de innebygde koblingene.

## Flere innbokser i én Cowork-oppgave

[Egendefinerte koblinger](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) er eksterne MCP-servere, og Anthropic oppgir at de er tilgjengelige i Claude, Cowork og Claude Desktop. Claude når dem fra Anthropics sky, og det har én konsekvens for Cowork: en lokal MCP-server du har satt opp i \`claude_desktop_config.json\`, er ikke tilgjengelig der. Serveren må kunne nås fra internett.

MCPEmails er en driftet MCP-server, så det er allerede tilfellet. Du kobler hver postkasse til den én gang, legger til én URL i Claude, og så er alle postkassene med i Cowork-oppgavene dine:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Alle kombinasjoner av leverandører.** [Gmail og Google Workspace](/connect/gmail) med et Google-apppassord, [personlig Outlook.com, Hotmail og Live](/connect/outlook) og [Microsoft 365 på jobb](/connect/office365) med Logg på med Microsoft, [iCloud](/connect/icloud), [Yahoo](/connect/yahoo), [Fastmail](/connect/fastmail), [Zoho](/connect/zoho) og alle postkasser som støtter [IMAP og SMTP](/connect/imap).
- **Hver postkasse med navn.** Oppgaven kaller \`inbox_list\` og ser hver tilkoblet adresse med visningsnavnet, så «sjekk post@ og Outlooken min» krever ikke noe ekstra oppsett.
- **Svar fra riktig adresse.** Hver postkasse sender gjennom sin egen leverandør, med sitt eget avsendernavn og sin egen signatur.
- **Lagres ikke.** E-posten hentes direkte fra leverandøren din for hver forespørsel og blir ikke liggende på våre servere.

En personlig Outlook.com-adresse kobles til med Logg på med Microsoft og trenger ingen administrator. En Microsoft 365-jobbkonto kan trenge at IT-ansvarlig godkjenner MCPEmails én gang for organisasjonen; [godkjenning fra administrator i Microsoft 365](/docs/microsoft-365-admin-consent) forklarer hva de godkjenner og gir dem lenken.

## Slik setter du det opp

1. **Koble til postkassene dine.** [Opprett en gratis MCPEmails-konto](/signup), åpne **Innbokser** og deretter **Koble til innboks**, én gang per postkasse. Gi hver av dem et tydelig visningsnavn som «Privat Outlook» eller «Acme Salg»: det er det Claude leser for å skille dem fra hverandre.
2. **Legg til koblingen i Claude.** Åpne **Customize → Connectors**, klikk **+ Add** og deretter **Add custom connector**. Kall den MCPEmails, skriv inn \`https://mcpemails.com/api/mcp\`, klikk **Continue**, behold innloggingsinnstillingene Claude fant, og klikk **Add**. På Team og Enterprise legger en eier den til, og medlemmene klikker **Connect**.
3. **Logg på og velg tilgang.** **Skrivebeskyttet** for oppgaver som bare leser, **Standard** for å legge til utkast og sending, eller **Full tilgang** for å legge til planlegging, mapper og sletting.
4. **Slå den på i Cowork.** Åpne **+**-menyen i en oppgave og slå på MCPEmails under koblinger.

[Guiden for oppsett i Claude](/blog/connect-claude-to-email) viser hvert skjermbilde, og [Claudes egendefinerte koblinger forklart](/blog/claude-custom-connectors-explained) tar for seg hva en egendefinert kobling kan og ikke kan gjøre.

Selve Cowork finnes på Claudes Pro-, Max-, Team- og Enterprise-abonnementer. Free-abonnementet i MCPEmails kobler til én postkasse; flere postkasser krever et betalt abonnement, som du finner på [prissiden](/pricing).

## Behold kontrollen over sendingen

En Cowork-oppgave går gjennom mange steg på egen hånd, så bestem på forhånd hva den kan gjøre uten å spørre.

- **I Claude.** Anthropics guide til Cowork lar deg sette hvert koblingsverktøy til **Always allow**, **Needs approval** eller **Blocked**. Setter du MCPEmails-verktøyene for sending til **Needs approval**, stopper Claude før hver sending. På Team og Enterprise kan organisasjonen din uansett kreve godkjenning for skriveverktøy.
- **I MCPEmails.** Slå på **Gjennomgang før sending** for en postkasse og velg hvordan: **Spør i chatten først** får Claude til å vise deg e-posten og vente på ja fra deg, og **Godkjenn på mcpemails.com** holder tilbake hver sending til en eier eller administrator av arbeidsområdet godkjenner den, logget på, noe Claude ikke kan gjøre for deg. Se [menneskelig godkjenning av e-post som KI sender](/blog/approve-ai-agent-email-sends).
- **Utkast først.** Når du ber om en e-post, ber MCPEmails Claude lagre den som et utkast i den postkassen, der du kan lese og redigere den før noe blir sendt.

E-post skrives av andre, og noe av den er skrevet for å styre en KI. En oppgave som leser e-post og også kan sende, bør ha en av disse sperrene slått på.

## Prompter for flere innbokser

> Bruk MCPEmails, gå gjennom jobbinnboksen min og den personlige Outlooken min, og list opp alt fra de to siste dagene som trenger svar fra meg. Én liste, med innboksen merket på hver linje. Ikke send eller flytt noe.

> Bruk MCPEmails og finn flybekreftelsen for neste uke. Søk i alle tilkoblede innbokser og si hvilken den ligger i.

> Bruk MCPEmails, skriv et svar fra salg@ på den nyeste henvendelsen, og lagre det som et utkast. Ikke send det.

Vil du ha den samme oppsummeringen hver morgen uten å spørre, kan du sette den første prompten på en tidsplan: [daglig e-postoppsummering med Claude og ChatGPT](/blog/daily-email-briefing-with-claude-and-chatgpt) tar for seg Claudes planlagte oppgaver. [Flere e-postkontoer i Claude og ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) viser det samme oppsettet i Claude-chatten og ChatGPT.

## Vanlige spørsmål

**Kan Claude Cowork bruke to Gmail-kontoer?**
Ikke gjennom Claudes innebygde Gmail-kobling, som Anthropic beskriver som tilgang til den ene Google-kontoen du har koblet til. Koble begge kontoene til MCPEmails med Google-apppassord og legg til MCPEmails som en egendefinert kobling; da ser en Cowork-oppgave begge.

**Kan Cowork lese e-post fra min personlige Outlook.com eller Hotmail?**
Ikke med Claudes Microsoft 365-kobling, som avviser personlige Microsoft-kontoer. Koble adressen til MCPEmails med Logg på med Microsoft, og legg deretter til MCPEmails i Claude. [Koble Claude til Outlook.com og Hotmail](/blog/connect-claude-to-outlook-com-hotmail) har stegene.

**Fungerer egendefinerte koblinger i Cowork?**
Ja. Anthropic oppgir at egendefinerte koblinger er tilgjengelige i Claude, Cowork og Claude Desktop. De må være eksterne servere som kan nås fra internett; en lokal server fra konfigurasjonsfilen til skrivebordsappen er ikke tilgjengelig i Cowork.

**Trenger jeg én kobling per postkasse?**
Nei. Én MCPEmails-kobling dekker alle postkassene i arbeidsområdet ditt, og den samme URL-en fungerer i Claude-chatten, Cowork, ChatGPT og andre MCP-klienter.

**Kan Claude sende e-post fra Cowork?**
Ja, fra alle postkasser du har koblet til med Standard eller Full tilgang. [Kan Claude lese e-posten min og sende e-post?](/blog/can-claude-read-my-email#kan-claude-sende-e-post) sammenligner hvordan hver kobling håndterer sending.

## Neste steg

[Start gratis](/signup), koble til postkassen du sjekker oftest, legg til MCPEmails i Claude, og spør en Cowork-oppgave hva som trenger svar i dag. Legg til de andre innboksene når du vil ha ett svar i stedet for flere.`,
};

export default translation;
