export default {
  title: 'Slik kobler du iCloud, Fastmail eller en hvilken som helst IMAP-innboks til Claude',
  description:
    'Koble iCloud, Fastmail eller en hvilken som helst IMAP-innboks til Claude med et app-spesifikt passord. Steg-for-steg-oppsett, MCP-endepunktet, og hva IMAP får til som Gmail ikke gjør.',
  coverAlt: 'Koble iCloud, Fastmail og en hvilken som helst IMAP-innboks til Claude over MCP',
  content: `Å koble iCloud, Fastmail eller en hvilken som helst IMAP-postkasse til Claude krever én ting Gmail og Outlook ikke trenger: et **app-spesifikt passord**. Du genererer det inne hos e-postleverandøren din, limer det inn i MCP Emails én gang, og Claude kan lese, søke og sende gjennom den innboksen. Ingen OAuth-dans, ingen SMTP-serverinnstillinger å pugge.

Dette er ruten for alle leverandører som ikke er Gmail eller Microsoft. iCloud, Fastmail, Yahoo, Zoho, Yandex og enhver generisk IMAP-vert kjører alle gjennom den samme IMAP/SMTP-transporten, så de deler et identisk funksjonssett. Hvis du klarer å hente ut et app-passord fra leverandøren, kan du koble den til. En fin bonus over OAuth-leverandørene: IMAP gir Claude ekte, permanent sletting.

## Hvorfor disse leverandørene bruker app-passord, ikke OAuth

Gmail og Outlook tilbyr moderne OAuth-API-er, så MCP Emails kobler dem til med en innlogging på ett klikk. iCloud og Fastmail tilbyr ikke den veien til tredjeparts e-postverktøy. I stedet gir de deg et **app-spesifikt passord** — et langt, tilfeldig generert passord som er begrenset til én enkelt applikasjon, atskilt fra det egentlige kontopassordet ditt og som kan tilbakekalles for seg.

Én korrigering som er verdt å gjøre, fordi eldre omtaler tar feil her: **Fastmail bruker kun app-passord.** Fastmail støttet tidligere en OAuth-flyt for enkelte integrasjoner, men for å koble til MCP Emails i dag genererer du et app-passord i Fastmails innstillinger. Akkurat som iCloud. Hvis en guide ber deg "logge inn med Fastmail" via OAuth, er den utdatert.

App-passordet blir den ene legitimasjonen MCP Emails lagrer for den innboksen, [kryptert med AES-256-GCM i hvile](/blog/why-email-never-stored-matters) og dekryptert kun inne i en isolert Edge Function på kalltidspunktet. Selve e-posten din blir aldri lagret — hvert verktøykall henter den live fra leverandøren og forkaster den.

## Generer et app-spesifikt passord for iCloud

1. Gå til [appleid.apple.com](https://appleid.apple.com) og logg inn med Apple-kontoen din.
2. Under seksjonen **Sign-In and Security**, åpne **App-Specific Passwords**.
3. Klikk på **+** (Generate an app-specific password), gi det en etikett som \`MCP Emails\`, og bekreft med passordet til Apple-kontoen din.
4. Apple viser deg et passord i formatet \`abcd-efgh-ijkl-mnop\`. Kopier det nå. Du kan ikke se det igjen senere.

Du må ha tofaktorautentisering slått på for Apple-kontoen din — app-spesifikke passord er ikke tilgjengelige uten det. IMAP-verten for iCloud er \`imap.mail.me.com\` og SMTP er \`smtp.mail.me.com\`, men MCP Emails fyller dem inn for deg når du velger iCloud som leverandør, så du trenger vanligvis ikke å røre dem.

## Generer et app-passord for Fastmail

1. Logg inn på Fastmail og åpne **Settings → Privacy & Security → Connected apps & API tokens** (eldre kontoer kaller det **App Passwords**).
2. Klikk på **New app password**.
3. Gi det et navn (\`MCP Emails\` fungerer), og for tilgang velg **Mail (IMAP/SMTP)** slik at det både kan lese og sende.
4. Fastmail genererer passordet kun én gang. Kopier det før du lukker dialogen.

Fastmails IMAP-vert er \`imap.fastmail.com\` og SMTP er \`smtp.fastmail.com\`. Igjen, når du velger Fastmail i MCP Emails settes disse automatisk.

## Koble til en generisk IMAP-innboks (alt annet)

For Yahoo, Zoho, Yandex, en selvhostet e-postserver eller noe annet med et IMAP-endepunkt har stegene samme form: hent et app-passord fra leverandøren (de fleste som støtter 2FA krever ett), og gi deretter MCP Emails fire ting:

- **IMAP-vert og -port** (vanligvis \`993\` for TLS)
- **SMTP-vert og -port** (vanligvis \`465\` eller \`587\`)
- **E-postadressen din** som brukernavn
- **App-passordet** som passord

Hvis du faktisk bare har et vanlig passord og leverandøren ikke tilbyr app-passord, fungerer det også — men et app-passord er det riktige valget. Det begrenser skadeomfanget. Tilbakekall det, og bare denne tilkoblingen dør, ikke hele kontoen din.

## Koble til innboksen i MCP Emails

Når du har kopiert passordet:

1. Åpne dashbordet og gå til **Inboxes → Connect Inbox**.
2. Velg leverandøren din — **iCloud**, **Fastmail** eller **Generic IMAP**.
3. Lim inn e-postadressen din og det app-spesifikke passordet. For generisk IMAP, bekreft også verten og porten.
4. Lagre. Innboksen er live på under ett minutt.

Det er hele greia. Hvis du vil ha den raskest mulige versjonen på tvers av alle leverandører, dekker [gjennomgangen på under to minutter](/blog/connect-email-to-ai-agent-under-2-minutes) det fra ende til annen.

## Pek Claude mot innboksen din

Å koble til innboksen og å koble til Claude er to separate steg. Innboksen bor i MCP Emails; nå gir du Claude [MCP](https://modelcontextprotocol.io)-endepunktet slik at den kan kalle verktøyene.

I claude.ai:

1. Gå til **Customize → Connectors**.
2. Klikk på **Add connector** og lim inn endepunktet: \`https://www.mcpemails.com/api/mcp\`
3. Klikk på **Connect**, logg inn med MCP Emails-kontoen din, og godkjenn de tilgangene du vil ha — \`read:email\`, \`send:email\`, eller begge.

Ingen API-nøkkel, ingen konfigurasjonsfil. claude.ai bruker OAuth med PKCE under panseret, og tokenet Claude får er begrenset til nøyaktig det du godkjente. Hvis du er på en klient som ikke kan gjøre OAuth — Cursor, Cline, et cURL-skript — lager du i stedet en avgrenset nøkkel, som jeg dekker i [e-posttilgang for Cursor, Cline og VS Code](/blog/email-for-ai-agents-cursor-cline-vscode).

Når den er tilkoblet, la Claude kjøre \`inbox_list\` først. Den returnerer innboksen din og dens \`inbox_id\`, så du trenger aldri å kopiere og lime inn en UUID. Derfra er det [kjerneverktøyene](/docs) — \`email_read\` (liste, lese og søke i meldinger), \`email_compose\` (sende, svare, videresende) og \`email_organize\` — pluss noen flere for mapper, utkast, planlegging og kontakter. Hvert av dem styres med en \`action\`-parameter.

En prompt for å bekrefte at det fungerer:

\`\`\`
Use inbox_list to find my iCloud inbox, then summarize my 5 most recent unread messages.
\`\`\`

## Den ene tingen IMAP gjør som Gmail og Outlook ikke kan

Her er delen folk overser. Når Claude "sletter" en melding på Gmail eller Outlook, havner den i papirkurven. Det er en hard begrensning i Gmail- og Microsoft Graph-API-ene — de eksponerer ikke en permanent sletting til tredjepartsapper. Meldingen blir liggende i papirkurven til leverandørens oppbevaringsvindu utløper.

IMAP er annerledes. Fastmail, iCloud, Yahoo, Zoho, Yandex og generisk IMAP støtter alle **hard expunge** — Claude kan fjerne en melding permanent, ikke bare kaste den i papirkurven. Hvis du vil ha en agent som faktisk rydder opp etter seg, er IMAP den eneste transporten som lar den gjøre det. Nyttig, og også en grunn til å være bevisst på hvilke tilganger du gir. Expunge er ugjenkallelig.

Søk oppfører seg også litt annerledes. Gmail får hele operatorsyntaksen sin, Outlook bruker KQL, og IMAP-leverandører bruker IMAP-tekstsøk — kapabelt, men ikke like uttrykksfullt som Gmails operatorer. Verdt å vite hvis du skriver søketunge prompts.

## Hva du kan bygge når den er tilkoblet

Mekanikken er den samme uansett leverandør, så enhver arbeidsflyt du har sett for Gmail fungerer på Fastmail- eller iCloud-innboksen din. Noen som bærer sin egen vekt:

- Morgentriagering som flagger det som trenger et menneske og skriver utkast til svar på resten. Se [innbokstriagering og oppsummering](/blog/ai-agent-triage-summarize-inbox).
- En tilnærmet sanntids auto-svarer. Ett ærlig forbehold: MCP Emails er pollbasert, ikke push — det finnes ingen webhooks, så agenten sjekker etter ny post på en tidsplan. [Auto-svarer-byggingen](/blog/build-email-auto-responder-mcp-agent) forklarer hvordan du gjør det godt.

Hvis du fortsatt vurderer om du i det hele tatt skal koble e-post til en agent, start med hovedartikkelen: [hvordan du gir AI-agenten din tilgang til e-post](/blog/how-to-give-your-ai-agent-email-access).

## Oppsummering

iCloud, Fastmail og IMAP er ikke andrerangs her. Generer et app-passord, lim det inn i **Inboxes → Connect Inbox**, pek Claude mot [endepunktet](/docs), og du har en agent med full lese-/sendetilgang pluss permanent sletting som OAuth-leverandørene ikke kan tilby. Det er [gratis å komme i gang](/signup), uten kort, én innboks for alltid.`,
};
