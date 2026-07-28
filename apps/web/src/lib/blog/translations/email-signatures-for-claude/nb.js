export default {
  title: 'E-postsignaturer for Claude: signert automatisk, hver gang',
  description:
    'Sett signaturen din én gang per innboks, så signerer Claude automatisk hver e-post den sender, i Gmail, Outlook, Fastmail, iCloud og alle IMAP-kontoer.',
  coverAlt:
    'E-postsignaturer for Claude: angi en signatur per innboks én gang, så signerer Claude hver melding den sender, hos alle leverandører',
  content: `Når Claude sender en e-post for deg, bør den se ut som om du sendte den. Det inkluderer avslutningen: navnet ditt, tittelen din, firmalinjen din, den lenken til bestillingssiden din. Frem til nå måtte du enten skrive signaturen din inn i hver melding, eller godta e-post som sluttet litt brått. I dag endres det: **MCP Emails legger nå signaturen din automatisk til i hver melding Claude sender.**

Signaturer er **per innboks**. Hver tilkoblet postkasse beholder sin egen, så gründerhatten havner på jobbadressen din og et enkelt "— Sam" på den private. Når den først er satt, tenker du aldri på den igjen.

## Hva som blir signert

Sett den én gang, så legges signaturen automatisk til på alt Claude sender fra den innboksen:

- **Nye e-poster** — \`email_compose\` (handling \`send\`).
- **Svar og videresendinger** — \`email_compose\` (handlingene \`reply\` og \`forward\`).
- **Utkast** — \`draft\`, så det du gjennomgår har avslutningen din allerede på plass.
- **Planlagte sendinger** — \`schedule\`, så en melding som er satt i kø til mandag morgen går ut signert.

Det er ingenting ekstra å si i meldingen din. "Svar Dana og fortell henne at presentasjonen er vedlagt" gir en komplett, signert e-post.

## Svar og videresendinger plasserer den riktig

Det vanskelige med signaturer er plasseringen, og det er der de fleste verktøy svikter. På et svar eller en videresending plasserer MCP Emails signaturen din **etter den nye teksten din og før den siterte tråden**, akkurat der et menneske ville plassert den, i stedet for å strande den helt nederst under sider med historikk.

Den er også smart med frem og tilbake. Det finnes en **svarmodus** slik at signaturen ikke gjentas hver gang Claude svarer i samme tråd. Det første svaret er signert; de raske oppfølgingene i den samtalen stables ikke opp med doble avslutninger. Du får rene tråder, ikke en vegg av gjentatte navn.

## Fungerer hos alle leverandører

Dette er ikke en finesse bare for Gmail. Signaturer gjelder hos **alle** tilkoblede leverandører: Gmail, Outlook, Fastmail, iCloud og alle andre IMAP-kontoer. Fordi MCP Emails komponerer den utgående meldingen selv, er oppførselen identisk uansett hvor postkassen ligger. Koble til en ny innboks av hvilken som helst type, og signaturer bare fungerer.

## To måter å sette den opp på

**1. Signatureditoren i dashbordet.** Åpne en innboks i MCP Emails-dashbordet og rediger signaturen dens direkte. Hver innboks har sin egen, så du kan gi hver adresse riktig stemme.

**2. Bare spør Claude.** Det finnes et nytt \`signature\`-verktøy, så du kan sette eller endre signaturen din i naturlig språk uten å forlate chatten:

> "Sett signaturen til jobbinnboksen min til: Sam Rivera, Gründer, Acme — calendly.com/sam"

Claude skriver den for den innboksen, og fra da av blir hver sending signert. Be den oppdatere signaturen senere, og den gjør det samme.

## Når du vil ha en bar melding

Noen ganger er en signatur bare støy: et ett-ords "Takk!" trenger ikke tre linjer med kontaktinfo under seg. For slike enkelttilfeller finnes **\`include_signature\`-valget**: be Claude hoppe over signaturen for én enkelt melding, så sender den den korte versjonen. Den lagrede signaturen din blir værende for alt etterpå.

> "Svar 'På vei' på den siste meldingen fra kontoret — uten signatur."

## Hvordan det passer inn i resten av arbeidsflyten

Signaturer glir rett inn i verktøyene du allerede bruker. Hvis Claude kjører morgentriagen din og fyrer av svar, bærer nå hvert av dem avslutningen din uten at du nevner den. Det samme gjelder [autosvar-mønstrene](/blog/build-email-auto-responder-mcp-agent) og [triage- og oppsummeringsguiden](/blog/ai-agent-triage-summarize-inbox) — alt som ender i en sending, ender nå signert.

Og personvernmodellen er uendret: e-posten din blir fortsatt [aldri lagret](/blog/why-email-never-stored-matters). Signaturen er en liten bit konfigurasjon per innboks; meldingene dine hentes fortsatt direkte og forkastes i det øyeblikket Claude har dem.

## Vanlige spørsmål

**Er signaturer per innboks eller per konto?**
Per innboks. Hver tilkoblet postkasse har sin egen signatur, så du kan signere jobb- og privatadressene dine forskjellig.

**Plasserer svar og videresendinger signaturen riktig?**
Ja. Den plasseres etter den nye teksten din og før den siterte tråden, og svarmodus hindrer at den gjentas gjennom et frem og tilbake i samme tråd.

**Hvilke leverandører støtter signaturer?**
Alle: Gmail, Outlook, Fastmail, iCloud og alle andre IMAP-kontoer. MCP Emails komponerer den utgående meldingen, så oppførselen er den samme overalt.

**Kan jeg sende en melding uten signaturen min?**
Ja. Bruk \`include_signature\`-valget (bare be Claude hoppe over signaturen) for en kort enkeltmelding. Den lagrede signaturen din blir værende for alt annet.

**Hvordan setter jeg signaturen min?**
På to måter: rediger den per innboks i dashbordet, eller spør Claude — for eksempel "sett signaturen min til …" via det nye \`signature\`-verktøyet.

## Oppsummering

Sett signaturen din én gang, per innboks, så går hver e-post Claude sender fra den postkassen (ny, svar, videresending, utkast eller planlagt) ut signert som om du skrev den. Den fungerer hos alle leverandører, plasserer seg riktig i tråder og holder seg unna med \`include_signature\` når du vil ha et bart svar.

[Åpne dashbordet ditt](/dashboard) for å sette en signatur, eller bare fortell Claude hva din skal være. Ikke tilkoblet ennå? [Kom i gang gratis](/signup) og koble til en innboks på rundt to minutter.`,
};
