export default {
  title: 'Hostet vs. selvhostet Gmail MCP-server: fordeler, ulemper og kostnader',
  description:
    'Hostet vs. selvhostet Gmail MCP-server, ærlig sammenlignet: gratis gjør-det-selv-repoer gir full kontroll, men du eier OAuth, kryptering og oppetid. En hostet server tar minutter.',
  coverAlt: 'Sammenligning av hostet og selvhostet Gmail MCP-server — MCP Emails',
  content: `Hvis du vil at AI-agenten din skal lese og sende Gmail, har du to reelle valg: kjøre en selvhostet Gmail MCP-server fra et åpen kildekode-repo, eller peke klienten din mot en hostet en. Gjør-det-selv-veien koster null kroner og gir deg total kontroll, men du eier personlig OAuth-oppsettet, token-krypteringen, hostingen, oppdateringene og sikkerheten. En hostet server som MCP Emails tar minutter å sette opp og holder legitimasjonen kryptert, mot at du stoler på at en leverandør håndterer tilkoblingen.

Dette er den ærlige gjennomgangen. Jeg har bygd en hostet server, så jeg har en side i saken, men jeg skal si deg nøyaktig hvor selvhosting vinner og hvilken type person som bør velge det. Hvis du først bare vil ha modellen på verb-nivå, er [den komplette guiden til å gi en AI-agent tilgang til e-post](/blog/how-to-give-your-ai-agent-email-access) hovedartikkelen du bør lese ved siden av denne.

## Hva «selvhostet Gmail MCP-server» faktisk betyr

Søk på «Gmail MCP server», og du finner et dusin GitHub-repoer. Du kloner ett, registrerer et Google Cloud-prosjekt, genererer OAuth-klientlegitimasjon, kjører en lokal OAuth-samtykkeflyt, og serveren gjemmer en refresh-token på disk eller i en env-variabel. Etter det snakker MCP-klienten din med en prosess som kjører på \`localhost\` eller en maskin du leier.

Det er hele pitchen, og for en enkelt Gmail-konto på din egen laptop fungerer det. Kostnaden dukker opp senere, og den måles ikke i kroner.

## Argumentet for selvhosting: der det faktisk vinner

Jeg skal ikke late som at gjør-det-selv er en dårlig idé. For rett person er det det riktige valget.

### Du får full kontroll og null leverandørtillit

Koden kjører på din egen maskinvare. Ingen tredjepart sitter noensinne mellom agenten din og Google. Hvis trusselmodellen din sier «ingen ekstern tjeneste skal røre postkassen min, punktum», er selvhosting det eneste svaret som tilfredsstiller det. Du kan lese hver eneste linje, forke den og pinne den for alltid.

### Det er gratis i kroner

Ingen abonnement. Gmail API-et selv er gratis ved et hvilket som helst volum en agent vil treffe. Hvis tiden din er billig i forhold til $5 per måned (eller $15 per måned når du trenger ubegrenset antall innbokser), taler regnestykket for å lage din egen.

### Du kan bøye det til hva som helst

Egendefinerte verktøy, rare IMAP-mapper, en privat label-taksonomi, en logge-pipeline som mater SIEM-en din. Når du eier prosessen, kan du gjøre alt sammen. Et hostet produkt gir deg den overflaten det gir deg.

## Argumentet for selvhosting: der det faktisk koster deg

Nå til den delen README-filene i repoene glatter over.

### Du eier OAuth-oppsettet

Et Google Cloud-prosjekt, en OAuth-samtykkeskjerm, de riktige scopene, og — hvis du vil at noen andre enn deg selv skal bruke det — Googles app-verifiseringsprosess, som er en reell gjennomgang med reell behandlingstid. Velg feil scope, og du er tilbake i konsollen. Dette er steget som spiser en ettermiddag den første gangen og en mindre bit hver gang en token utløper eller Google endrer en policy.

### Du eier lagring og kryptering av legitimasjon

Her er den som holder meg våken. En refresh-token for \`read:email\` og \`send:email\` er en hovednøkkel til noens innboks. De fleste gjør-det-selv-oppsett dumper den i en klartekstfil eller en miljøvariabel. Hvis den maskinen blir kompromittert, eller tokenet lekker inn i en logg eller en backup, leser og sender angriperen e-post som deg.

Å gjøre dette skikkelig betyr å kryptere tokenet i ro, holde krypteringsnøkkelen atskilt fra token-lageret, og dekryptere kun ved kalltidspunkt i en isolert kontekst. Det er ikke vanskelig å beskrive, og det er genuint irriterende å bygge og vedlikeholde. Hopper du over det, har du bygd en risiko. [Hvorfor «e-post lagres aldri» betyr noe](/blog/why-email-never-stored-matters) går dypere inn på arkitektursiden av dette.

### Du eier hosting og oppetid

En localhost-server dør når laptopen din går i dvale. Hvis du vil at agenten skal triagere e-post klokka 6 om morgenen eller kjøre uten tilsyn, trenger du en prosess som alltid er oppe — en VPS, en container, en restart-policy, TLS, overvåking. Det er ops-arbeid, og det slutter aldri å være ops-arbeid.

### Du eier oppdateringer og sikkerhetsfikser

MCP er ungt. Spesifikasjonen beveger seg, Google roterer krav, og repoet du klonet kan bli utdatert eller forlatt. Når en avhengighet sender ut en CVE, er det din personsøker som ringer. Pinn en versjon, og du faller bakpå; følg \`main\`, og du arver andres feil.

### Multi-leverandør er ditt ansvar

Repoet du valgte gjør Gmail. Den dagen du legger til en Outlook-konto eller en iCloud-adresse, integrerer du Microsoft Graph eller kobler opp IMAP og SMTP selv, med en andre auth-modell og et andre sett med kanttilfeller. De fleste gjør-det-selv-servere forblir kun Gmail, fordi den andre leverandøren er et prosjekt i seg selv.

## Argumentet for hostet: MCP Emails, ærlig

En hostet MCP-server snur byttehandelen. Du gir opp å kjøre koden; du får tilbake all tiden listen over ville kostet.

### Oppsett er minutter, ikke en ettermiddag

Du registrerer deg, går til **Dashboard → Inboxes → Connect Inbox**, velger Gmail og klikker deg gjennom Googles ett-klikks OAuth. Ingen Cloud-prosjekt, ingen samtykkeskjerm, ingen verifiseringskø. Deretter kobler du til agenten din. For [claude.ai eller Claude Desktop](/blog/connect-email-to-ai-agent-under-2-minutes) limer du inn MCP-endepunkt-URL-en, logger inn og godkjenner scopene — ingen API-nøkkel. For en klient uten OAuth, som [Cursor, Cline eller et rått skript](/blog/email-for-ai-agents-cursor-cline-vscode), lager du en scopet API-nøkkel i **Dashboard → API Keys** og sender den som en bearer-token.

### Legitimasjon er kryptert og e-post lagres aldri

OAuth-tokenet er det eneste som lagres per innboks, og det er kryptert med AES-256-GCM i ro. Nøkkelen lever som en miljøhemmelighet, atskilt fra databasen, og dekryptering skjer kun inne i en isolert Edge Function ved kalltidspunkt. Selve e-posten lagres aldri i det hele tatt — hvert \`email_read\`-kall (enten du lister, leser eller søker) treffer Gmail live, gir resultatet til agenten din og forkaster det. Det er krypteringsarbeidet fra selvhosting-delen, gjort og vedlikeholdt. [Er det trygt å gi en AI-agent tilgang til e-post](/blog/is-it-safe-to-give-ai-agent-email-access) går gjennom hele sikkerhetsmodellen.

### Multi-leverandør følger med gratis

Det samme endepunktet og de samme kjerneverktøyene — \`inbox_list\`, \`email_read\`, \`email_compose\`, \`email_organize\` for flagg og mapper, pluss \`folder\`, \`draft\`, \`schedule\` og \`contact_search\` — fungerer på tvers av Gmail, Outlook, iCloud, Fastmail og enhver IMAP-innboks. Legg til en Outlook-konto neste uke, og ingenting ved agenten din endrer seg.

### Sending forblir hos din leverandør

MCP Emails videresender aldri e-post fra sitt eget domene. \`email_compose\` (med \`send\`-handlingen) går ut gjennom din Gmail (eller Microsoft Graph, eller din egen SMTP), så domenets omdømme og leveringsevne forblir dine. Det er den samme egenskapen du ville fått med selvhosting, uten å bygge den.

### Den ærlige kostnaden: du stoler på en leverandør

Dette er den reelle byttehandelen, og jeg skal ikke pynte på den. Med en hostet server ligger det krypterte tokenet ditt i noen andres database, og agentens kall rutes gjennom noen andres kode. Du stoler på at krypteringen er ekte, at isolasjonen holder, og at selskapet ikke gjør noe dumt. For de fleste er den tilliten velplassert og sparer enormt med tid. Hvis trusselmodellen din forbyr det helt, selvhost — det er den legitime grunnen til å gjøre det.

## Hva det koster i kroner

MCP Emails er gratis å komme i gang med: én tilkoblet innboks, ubegrenset antall API-nøkler, uten kredittkort. Gratisnivået kjører på 60 forespørsler per minutt med 7-dagers analyse og fellesskapsstøtte. [Personal koster $5 per måned](/pricing) (opptil tre tilkoblede innbokser, 120 req/min, 30-dagers analyse, e-poststøtte), Pro koster $15 per måned (ubegrenset antall tilkoblede innbokser, 300 req/min, 90-dagers analyse), og Team koster $79 per måned (medlemmer med roller, et eget arbeidsområde per kunde, SSO og revisjonslogger). Selvhosting er $0 i abonnement pluss hva enn VPS-en din og timene dine koster. Vær ærlig om timene.

## Så hva bør du velge?

Velg **selvhostet** hvis du er en ingeniør som liker rørleggerarbeidet, du trenger full kontroll eller har en ingen-tredjeparter-regel, du er komfortabel med å eie OAuth, kryptering og oppetid, og du noensinne bare rører én Gmail-konto. Det er et reelt, forsvarlig valg.

Velg **hostet** hvis du vil ha et fungerende endepunkt i dag, du heller ikke vil være på vakt for din egen e-postinfrastruktur, du sannsynligvis vil legge til Outlook eller iCloud eller en IMAP-boks på et tidspunkt, og du vil ha legitimasjonskryptering håndtert av folk som vedlikeholder det på heltid. Det er de fleste, inkludert de fleste ingeniører som kunne bygd det, men som har bedre ting å gjøre.

Hvis du fremdeles vurderer hvordan en agent i det hele tatt bør nå innboksen din, sammenligner [de beste måtene å la Claude håndtere innboksen din på](/blog/best-ways-to-let-claude-manage-your-inbox) de bredere alternativene. Når du er klar, [start gratis](/signup) eller skum [dokumentasjonen](/docs) — å koble til en Gmail-innboks tar faktisk omtrent ett minutt.`,
};
