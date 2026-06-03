export default {
  title: 'Koble Outlook og Microsoft 365 til AI-agenten din via MCP',
  description:
    'Koble Outlook eller Microsoft 365 til AI-agenten din over MCP på minutter. Microsoft-pålogging med OAuth, Graph under panseret, les/søk/send/svar — uten egen server.',
  coverAlt: 'Kobler Outlook og Microsoft 365 til en AI-agent over MCP',
  content: `> **Kommer snart.** Støtte for Outlook og Microsoft 365 er bygget, men ennå ikke allment tilgjengelig. Du kan ikke koble til en Outlook-postkasse i produksjon i dag — denne guiden viser hvordan det vil fungere når koblingen lanseres. For postkasser du kan koble til akkurat nå, se [Gmail og IMAP](/docs/providers).

For å koble en Outlook- eller Microsoft 365-postkasse til AI-agenten din logger du inn på MCP Emails, legger til innboksen med Microsoft OAuth, og peker agenten mot ett MCP-endepunkt. Ingen appregistrering, ingen Azure-portal, ingen egen Graph-server. Hele greia tar omtrent to minutter, og agenten din får lese, søke, sende, svare, flagge og håndtere mapper mot den live postkassen.

De fleste «AI for e-post»-guider antar Gmail og stopper der. Outlook får et skuldertrekk og en lenke til et halvveis vedlikeholdt GitHub-repo. Hvis du lever i Microsoft 365 på jobb, er det å gripe det an fra feil ende. Dette innlegget er Outlook-først-versjonen: hva som faktisk fungerer, hvordan Microsoft-påloggingen flyter, hva som kjører under panseret, og hvor kantene mellom personlig og jobbkonto ligger.

## Hvorfor Outlook er vanskeligere enn det ser ut (og hvorfor det ikke er ditt problem her)

Microsoft-e-post er ikke én ting. Det finnes forbruker-Outlook.com / Hotmail / Live, og det finnes Microsoft 365 jobb- og skolekontoer som lever i Entra ID (identitetstjenesten som tidligere het Azure AD). De autentiserer ulikt, og en jobb-tenant kan ha policyer for betinget tilgang, krav om administratorsamtykke og MFA-regler lagt oppå.

Gjør-det-selv-veien betyr å registrere et program i Azure-/Entra-portalen, velge riktige støttede kontotyper, be om Microsoft Graph-tilganger som \`Mail.Read\` og \`Mail.Send\`, koble opp en redirect-URI, håndtere tokenfornyelse, og deretter skrive Graph-kallene for å liste, lese og sende e-post. Folk brenner en ettermiddag på dette og ender opp med å vedlikeholde en bitteliten server for alltid. Jeg har sett det skje.

MCP Emails gjør den registreringen og token-rørleggingen én gang, sentralt, så du slipper. Du klikker «logg inn med Microsoft», godkjenner, og du er tilkoblet. Vil du ha den konseptuelle bakgrunnen for hvorfor dette laget finnes i det hele tatt, er [den komplette guiden til å gi AI-agenten din e-posttilgang](/blog/how-to-give-your-ai-agent-email-access) bærebjelken å starte fra.

## Koble til Outlook-/Microsoft 365-innboksen din

To deler: koble til postkassen, deretter koble til agenten. De er adskilt med vilje — postkasse-tilkoblingen autoriserer MCP Emails til å nå leverandøren din, og agent-tilkoblingen autoriserer klienten din til å nå MCP Emails.

### Trinn 1 — Legg til innboksen

1. [Start gratis](/signup) og åpne dashbordet.
2. Gå til **Inboxes → Connect Inbox**.
3. Velg **Outlook / Microsoft 365**.
4. Du sendes til Microsofts egen påloggingsside. Skriv inn jobb- eller privat-Microsoft-kontoen din, fullfør MFA hvis tenanten din krever det, og se gjennom samtykkeskjermen.
5. Godkjenn. Microsoft gir tilbake et OAuth-token, MCP Emails krypterer det (AES-256-GCM) og lagrer bare det tokenet. Ingenting annet om postkassen din blir lagret.

Dette er OAuth 2.0 — samme modell som Gmail bruker. Du limer aldri inn et Outlook-passord i MCP Emails, og det finnes ikke noe app-passord å generere. Det er den avgjørende forskjellen fra IMAP-leverandørene; hvis du kobler til [iCloud, Fastmail eller en generisk IMAP-postkasse](/blog/connect-icloud-fastmail-imap-to-claude), bruker de et app-spesifikt passord i stedet, fordi de ikke tilbyr OAuth for tredjepartsklienter.

### Trinn 2 — Koble til agenten din

Du kobler til en klient én gang, og det samme oppsettet fungerer for hver innboks på kontoen din. For OAuth-kompatible klienter (claude.ai, Claude Desktop, Cursor) er det i claude.ai slik:

**Customize → Connectors → Add connector → lim inn URL-en → Connect → logg inn og godkjenn.**

Endepunktet er:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Når du klikker Connect, logger du inn på MCP Emails-kontoen din og godkjenner tilganger — \`read:email\`, \`send:email\`, eller begge. Ingen API-nøkkel skifter hender; det bruker OAuth 2.0 Authorization Code med PKCE og dynamisk klientregistrering under panseret.

For klienter som ikke snakker OAuth (Cline, JetBrains-plugins, dine egne skript, rå cURL), genererer du en nøkkel med avgrensede tilganger i **Dashboard → API Keys**, velger tilganger, og sender den som \`Authorization: Bearer <api-key>\`. Den fullstendige gjennomgangen for de klientene finner du i [e-post for AI-agenter i Cursor, Cline og VS Code](/blog/email-for-ai-agents-cursor-cline-vscode). Hvis du veier de to tilnærmingene mot hverandre, legger [OAuth vs. API-nøkler for AI-e-posttilgang](/blog/oauth-vs-api-keys-ai-email-access) frem avveiningene.

## Microsoft Graph, under panseret

Når du er tilkoblet, går hvert verktøykall agenten din gjør ut til Microsoft Graph i sanntid. Les en melding, og MCP Emails kaller Graph, gir det tolkede resultatet til agenten din og forkaster det. Send en melding, og den går gjennom Graph på dine vegne — fra din egen adresse, gjennom Microsofts infrastruktur, slik at domenets leveringsdyktighet og omdømme forblir ditt. MCP Emails videresender aldri e-post fra sitt eget domene.

Det praktiske utfallet: e-posten agenten din sender ser nøyaktig ut som e-post du sendte, fordi det er det. Den havner i Sent Items. Svar trådes riktig fordi svarverktøyet setter In-Reply-To- og References-hodene for deg.

## Personlig vs. jobb-/skolekonto

Begge fungerer. En forbruker-Outlook.com-konto og en Microsoft 365 jobb-/skolekonto kobler begge til gjennom samme Microsoft-påloggingsflyt, og begge eksponerer de samme verktøyene til agenten din.

Det ene stedet virkeligheten trenger seg på er samtykkeskjermen på jobb-/skolekontoer. Hvis IT-administratoren din har låst ned samtykke til tredjepartsapper i tenanten din — noe mange større organisasjoner gjør — kan du se «godkjenning kreves» i stedet for en vanlig samtykkeforespørsel, og tilkoblingen venter på en administrator. Det er ikke en begrensning i MCP Emails; det er tenantens policy, og den ville blokkert enhver tredjepartsklient på nøyaktig samme måte. For en personlig konto, eller en tenant som tillater brukersamtykke, godkjenner du det selv og er ferdig.

## Hva som fungerer når det er tilkoblet

Agenten din får de seks kjerneverktøyene pluss det ekstra Outlook støtter:

- \`list_inboxes\` — kall alltid dette først. Det returnerer de tilkoblede postkassene dine og deres \`inbox_id\`-UUID-er, slik at agenten aldri gjetter en ID.
- \`list_messages\` — nyeste først, paginert, med filtre som \`unread_only\`.
- \`read_email\` — tolket ren tekst, valgfri renset HTML, valgfrie vedlegg.
- \`search_emails\` — se søkenotatet nedenfor.
- \`send_email\` — skriv med CC/BCC, HTML og vedlegg på opptil 10 MB totalt.
- \`reply_to_email\` — svarer i tråden med korrekte trådhoder.

Utover de seks støtter Outlook å merke som lest/ulest, flagge (Outlooks «flagg» tilsvarer det stjernemerkede/flaggede konseptet), videresende og flytte mellom mapper. Sjekk de live [dokumentene](/docs) for den gjeldende listen over funksjoner før du bygger mot et bestemt verktøy.

### Søk bruker Microsofts \`$search\`

Outlook-søk er ikke Gmail-søk. Der Gmail tar operatorer som \`from:\` og \`is:unread\`, sender \`search_emails\` mot en Outlook-innboks spørringen din til Microsoft Graphs \`$search\`, som gjør relevansrangert fulltekstmatching på tvers av postkassen og også godtar KQL. Så en spørring som \`invoice from accounting last week\` fungerer som naturlig språk, og du kan bli mer presis med KQL som \`from:finance@acme.com AND subject:invoice\`. Hvis du skriver prompter som hardkoder Gmail-operatorer, oppfører de seg ikke likt på Outlook — be agenten din om å søke i klart språk og la Graph rangere.

## En arbeidsflyt verdt å sette opp

Her er en triage-løkke jeg kjører mot en Microsoft 365-innboks. En eller to ganger i timen gjør agenten:

1. Kaller \`list_messages\` med \`unread_only: true\`.
2. Leser alt som ser tidssensitivt ut med \`read_email\`.
3. Oppsummerer bunken og skriver utkast til svar på de jeg åpenbart ville besvart.
4. Lar alt stå ulest til jeg bekrefter.

Ett ærlig forbehold: MCP Emails er poll-basert. Det finnes ingen webhooks og ingen server-push, så agenten sjekker etter en tidsplan i stedet for å bli pinget i det øyeblikket e-post kommer. For triage er det greit — du setter takten. Bygger du noe mer reaktivt, les [hvordan du triagerer og oppsummerer en innboks](/blog/ai-agent-triage-summarize-inbox) for pollemønstrene som holder.

## Sammenlignet med å bygge din egen M365-server

De selvhostede Outlook MCP-serverne som svever rundt på GitHub treffer alle den samme veggen: Entra-appregistreringen og Graph-tokenets livssyklus er det egentlige arbeidet, og du eier dem for alltid. Du håndterer fornyelsestokener, tilgangsendringer når Microsoft justerer Graph, og sikkerheten der disse tokenene befinner seg. Med den hostede tilnærmingen er tokenet kryptert i hvile, dekryptert bare inne i en isolert funksjon ved kalltid, og kan tilbakekalles fra dashbordet med ett klikk. Vil du ha hele sammenligningen, går [hostet vs. selvhostet](/blog/hosted-vs-self-hosted-gmail-mcp-server) i dybden på avveiningene.

Å koble til Outlook koster ingenting å prøve — [gratisplanen](/pricing) gir ubegrenset antall innbokser og verktøykall på 60 forespørsler per minutt, uten kort. Legg til Microsoft 365-postkassen din, pek Claude mot endepunktet, og gi den noe å lese.`,
};
