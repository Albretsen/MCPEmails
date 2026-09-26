const translation = {
  title: 'Koble Outlook og Microsoft 365 til AI-agenten din via MCP',
  description:
    'Koble Outlook.com eller Microsoft 365 til AI-agenten din over MCP. Logg inn med Microsoft, uten app-passord, med Microsoft Graph under panseret. Jobbkontoer kan trenge én godkjenning fra IT-ansvarlig.',
  coverAlt: 'Kobler Outlook og Microsoft 365 til en AI-agent over MCP',
  content: `For å koble en Outlook- eller Microsoft 365-postkasse til AI-agenten din legger du til innboksen i MCP Emails-dashbordet med **Logg inn med Microsoft**, og peker deretter agenten mot ett MCP-endepunkt. Det er ikke noe app-passord, ingen IMAP- eller SMTP-innstillinger, ingen Azure-portal og ingen egen Graph-server. En personlig Outlook.com-konto kobles til på et par minutter. En jobb- eller skolekonto i Microsoft 365 trenger ofte ett ekstra steg først: en IT-ansvarlig godkjenner appen én gang for hele organisasjonen.

De fleste «AI for e-post»-guider antar Gmail og stopper der. Hvis du lever i Outlook, er dette Outlook-først-versjonen: hvilke kontoer som kobles til med en gang, hvordan godkjenningssteget hos IT-ansvarlig ser ut, hva agenten kan gjøre når den er tilkoblet, og de få stedene der Outlook oppfører seg annerledes enn Gmail.

## Personlige kontoer og jobbkontoer er to ulike tilfeller

Microsoft-e-post er ikke én ting, og forskjellen avgjør hvordan tilkoblingen går.

- **Personlige Microsoft-kontoer**: Outlook.com-, Hotmail-, Live- og MSN-adresser. Du logger inn med Microsoft, godkjenner tillatelsene selv, og du er tilkoblet. Ingen administrator er involvert.
- **Jobb- eller skolekontoer i Microsoft 365**: disse lever i organisasjonens Microsoft Entra-tenant. Mange organisasjoner krever at en IT-ansvarlig godkjenner en tredjepartsapp før noen kan bruke den. Microsofts standard samtykkepolicy (siden slutten av 2025) lar ikke ansatte godkjenne lesetilgang til postkassen selv, så i mange tenanter får du ikke fullført tilkoblingen alene. Det er en policy i Microsoft-tenanten, ikke noe MCP Emails kan skru av, og den gjelder for alle tredjeparts e-postapper.

Godkjenningen fra IT-ansvarlig er et engangssteg for hele organisasjonen. Når den er gjort, kobler hver ansatt seg til på vanlig måte.

## Koble til Outlook- eller Microsoft 365-innboksen din

To deler: koble til postkassen, og deretter koble til agenten. De er atskilt med vilje. Postkassetilkoblingen lar MCP Emails nå postkassen din, og agenttilkoblingen lar AI-klienten din nå MCP Emails.

### Steg 1: Legg til innboksen

1. [Start gratis](/signup) og åpne dashbordet.
2. Gå til **Inboxes → Connect Inbox** og velg **Outlook**.
3. Klikk **Koble til med Microsoft**. Du sendes til Microsofts egen innloggingsside.
4. Logg inn med Microsoft-kontoen din og fullfør MFA hvis kontoen din bruker det.
5. Se gjennom samtykkeskjermen og godkjenn. Microsoft viser at appen kommer fra en verifisert utgiver, og ber om tillatelse til å lese og skrive e-posten din, sende e-post som deg og beholde tilgangen til du kobler fra.

MCP Emails lagrer OAuth-tokenet kryptert og ingenting annet om postkassen din. Du skriver aldri inn Microsoft-passordet ditt i MCP Emails, og det er ikke noe app-passord å generere. Det er hovedforskjellen fra IMAP-leverandørene: [iCloud, Fastmail og generiske IMAP-postkasser](/blog/connect-icloud-fastmail-imap-to-claude) bruker et appspesifikt passord i stedet.

### Hvis organisasjonen må godkjenne appen først

På en jobb- eller skolekonto kan Microsoft stoppe deg før samtykkeskjermen og si at administratorgodkjenning kreves. Når det skjer, viser dashbordet et varsel med en **Send til IT-ansvarlig**-lenke:

1. Send den lenken til IT-ansvarlig.
2. IT-ansvarlig åpner den, logger inn og godkjenner MCP Emails én gang for hele organisasjonen.
3. Gå tilbake til dashbordet og koble til Outlook som i steg 1. Nå går det gjennom som for en personlig konto.

IT-ansvarlig godkjenner appen for organisasjonen, og hver person logger fortsatt inn med sin egen konto og kobler bare til sin egen postkasse.

### Hvis kontoen ikke har en Exchange-postkasse

Noen Microsoft-kontoer har ingen Exchange Online-postkasse, for eksempel en administratorkonto uten Exchange-lisens, eller en organisasjon der e-posten ligger et annet sted. MCP Emails avviser slike kontoer fordi det ikke er noe å koble til, og sier fra om det. Hvis e-posten din faktisk ligger på en annen server, kobler du til adressen med IMAP i stedet.

### Steg 2: Koble til agenten

Du kobler til en klient én gang, og det samme oppsettet virker for alle innboksene på kontoen din. For OAuth-kompatible klienter (claude.ai, Claude Desktop, Cursor) er det slik i claude.ai:

**Customize → Connectors → Add connector → lim inn URL-en → Connect → logg inn og godkjenn.**

Endepunktet er:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Når du klikker Connect, logger du inn på MCP Emails-kontoen din og godkjenner tilganger: \`read:email\`, \`send:email\` eller begge. Ingen API-nøkkel skifter hender.

For klienter som ikke snakker OAuth (Cline, JetBrains-plugins, egne skript, rå cURL), lager du en avgrenset nøkkel i **Dashboard → API Keys** og sender den som \`Authorization: Bearer <api-key>\`. Hele gjennomgangen for disse klientene finner du i [e-post for AI-agenter i Cursor, Cline og VS Code](/blog/email-for-ai-agents-cursor-cline-vscode). Veier du de to tilnærmingene mot hverandre, går [OAuth vs API-nøkler for AI-tilgang til e-post](/blog/oauth-vs-api-keys-ai-email-access) gjennom avveiningene.

## Microsoft Graph under panseret

Outlook kobles til via Microsoft Graph, ikke IMAP. Hvert verktøykall agenten gjør, går til Graph i sanntid: du leser en melding, og MCP Emails henter den fra Graph, gir resultatet til agenten og kaster det. Du sender en melding, og den går ut via Graph fra din egen adresse, så leveringsevnen og omdømmet ditt forblir ditt. MCP Emails videresender aldri e-post fra sitt eget domene.

## Hva agenten kan gjøre med en Outlook-innboks

- Lese og søke i e-post.
- Sende, svare og videresende, med vedlegg på opptil 25 MB.
- Jobbe med utkast, og planlegge en sending til senere.
- Jobbe med mapper, også nestede mapper.
- Flytte, kopiere og arkivere meldinger.
- Flagge og fjerne flagg, og merke meldinger som lest eller ulest.
- Flytte meldinger til Slettede elementer, eller slette dem permanent.
- Bruke signaturen du har satt for den innboksen på hver melding agenten sender.

### Der Outlook skiller seg fra Gmail

**Mapper, ikke etiketter.** Outlook organiserer e-post i mapper. Etikettverktøyene er bare for Gmail, så på en Outlook-innboks sorterer agenten e-post ved å flytte den til en mappe.

**Søk.** Outlook-søk bruker Microsoft Graphs eget søk. Én Graph-begrensning er viktig: et tekstsøk kan ikke kombineres med filtrene for ulest, har vedlegg, flagget eller dato. Når søket ditt inneholder tekst, brukes ikke disse filtrene, og resultatet forteller agenten hvilke som ble utelatt. Trenger du begge, søk etter teksten først og la agenten snevre inn resultatene den får tilbake.

**Nye Outlook.com-kontoer.** Microsoft kan midlertidig blokkere sending fra en helt ny Outlook.com-konto som sender mange meldinger på kort tid. Det er Microsofts beskyttelse mot misbruk. Hvis sending feiler på en ny konto, send i et roligere tempo og prøv igjen senere.

## En arbeidsflyt som er verdt å sette opp

Her er en sorteringssløyfe som fungerer godt på en Outlook-innboks. En eller to ganger i timen gjør agenten dette:

1. Lister ulest e-post i innboksen.
2. Leser alt som ser tidskritisk ut.
3. Oppsummerer bunken og skriver utkast til svar på de du åpenbart ville svart på.
4. Lar alt stå som ulest til du bekrefter.

MCP Emails dytter ikke ny e-post til agenten, så agenten sjekker med den frekvensen du velger. For sortering holder det. For pollemønstrene som holder mål, les [hvordan sortere og oppsummere en innboks](/blog/ai-agent-triage-summarize-inbox).

## Sammenlignet med å bygge din egen Microsoft 365-server

De selvhostede Outlook-MCP-serverne på GitHub treffer alle den samme veggen: appregistreringen i Entra, administratorsamtykket og livssyklusen til Graph-tokenene er selve jobben, og den eier du for alltid. Den selvhostede MCP Emails-versjonen støtter bare IMAP og SMTP. Outlook-koblingen blir værende i det hostede produktet, så en som selvhoster og vil ha den, må registrere sin egen Microsoft Entra-app. Med den hostede tilnærmingen er tokenet kryptert i hvile, dekrypteres bare i det kallet gjøres, og du kan koble fra innboksen i dashbordet når som helst. [Hostet vs selvhostet](/blog/hosted-vs-self-hosted-gmail-mcp-server) går dypere inn i avveiningene.

Vil du ha bakgrunnen for hvorfor dette laget finnes i det hele tatt, er [den komplette guiden til å gi AI-agenten din e-posttilgang](/blog/how-to-give-your-ai-agent-email-access) stedet å begynne. Ellers: [start gratis](/signup), koble til Outlook-innboksen din, pek agenten mot endepunktet og gi den noe å lese.`,
};

export default translation;
