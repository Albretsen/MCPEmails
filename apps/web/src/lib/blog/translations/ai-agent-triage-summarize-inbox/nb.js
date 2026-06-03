export default {
  title: 'Slik får du AI-agenten din til å sortere og oppsummere innboksen',
  description:
    'En praktisk veiledning for innbokssortering med AI-agent: ferdige prompter som lister ulest e-post, leser det som betyr noe, oppsummerer og prioriterer, og poller på fast plan.',
  coverAlt: 'AI-agent sorterer og oppsummerer en innboks over MCP — MCP Emails',
  content: `Den raskeste måten å få en AI-agent til å sortere innboksen din på er å lene deg på to verktøy i rekkefølge: \`inbox_list\` for å finne postkassen din, og så \`email_read\` — med \`action: list\` og \`unread_only: true\` for å hente det nye, deretter \`action: read\` for de få som ser viktige ut — og så en instruksjon på vanlig norsk om å oppsummere og rangere dem. Det er hele løkka. Vil du at den skal skrive utkast til eller sende svar, legger du til \`email_compose\` med \`action: reply\` til slutt.

Dette innlegget gir deg de eksakte promptene jeg bruker, hvordan god output ser ut, og hvordan du kjører den samme løkka på fast plan slik at morgensorteringen er gjort før du setter deg ned. Det forutsetter at agenten din allerede har e-posttilgang via [MCP Emails](/blog/how-to-give-your-ai-agent-email-access). Har du ikke koblet til en innboks ennå, tar [koble-til-guiden på under to minutter](/blog/connect-email-to-ai-agent-under-2-minutes) deg dit først.

## Sorteringsløkka, i ett bilde

Hver sorteringsøkt er de samme fem stegene. Agenten finner ut rekkefølgen selv når du beskriver målet, men det hjelper å vite hva som skjer under panseret:

1. \`inbox_list\` — finn tilkoblede innbokser og deres \`inbox_id\`-UUID-er. Agenten hardkoder aldri en UUID; den slår den opp her.
2. \`email_read\` med \`action: list\` og \`unread_only: true\` — hent den uleste køen for én innboks, nyeste først.
3. \`email_read\` med \`action: read\` — åpne hele meldingsteksten for de få meldingene som er verdt å lese i detalj.
4. Oppsummer og prioriter — ren resonnering, ingen verktøykall. Modellen grupperer, rangerer og forklarer.
5. \`email_compose\` med \`action: reply\` (valgfritt) — skriv utkast eller send for dem som trenger et svar.

Steg 1 til 4 er skrivebeskyttet. Hvis du koblet til med en [OAuth-tildeling eller API-nøkkel](/blog/oauth-vs-api-keys-ai-email-access) med \`read:email\`-omfang, kan agenten fysisk ikke sende noe som helst, noe som er akkurat det du vil ha for en automatisk oppsummering du skummer gjennom senere.

## Prompt 1: morgenoppsummeringen

Start enkelt. Dette er den jeg kjører de fleste dager. Lim den inn i Claude (eller en hvilken som helst MCP-klient koblet til MCP Emails) og la den jobbe:

> Se på hovedinnboksen min. Hent alt som er ulest, og gi meg så en oppsummering gruppert i tre bøtter: må besvares i dag, til orientering / kan vente, og sannsynligvis støy. For hvert element i de to første bøttene, gi meg én linje: hvem det er fra og hva de vil ha. Ikke åpne noe jeg ikke trenger — skum emnefelt og avsendere først, les bare meldingsteksten når emnet er tvetydig.

Legg merke til hva den prompten gjør. Den ber agenten lene seg på metadataene fra \`email_read\` (action list) (avsender, emne, utdrag) og kalle \`email_read\` med \`action: read\` sparsomt. Det holder økta rask og godt under fartsgrensene — 100 forespørsler per minutt per API-nøkkel, og et tak per arbeidsområde som starter på 60/min på Free-planen. En ulest kø på 40 meldinger sortert på denne måten er kanskje et dusin verktøykall, ikke førti.

Et godt svar ser slik ut:

\`\`\`text
NEEDS A REPLY TODAY (3)
- Dana (Acme): contract redline is back, wants sign-off before Fri
- Priya: blocked on the staging creds, asking you directly
- Stripe: a payment dispute opened, response due in 5 days

FYI / CAN WAIT (4)
- GitHub: 2 PRs merged into main overnight
- Notion: weekly digest
- Lena: shared the Q3 deck, no ask
- AWS: scheduled maintenance next Tuesday

PROBABLY NOISE (11): newsletters, 2 calendar invites already on your
calendar, LinkedIn, 6 marketing blasts.
\`\`\`

Det er genuint nyttig på en måte en rå innboks ikke er. Agenten leste de tre meldingene der emnet ikke gjorde forespørselen åpenbar, og lot de elleve nyhetsbrevene være lukket.

## Prompt 2: grundig sortering med prioriteringer og resonnering

Når antallet uleste er stygt — en mandag etter en lang helg — vil jeg ha mer enn bøtter. Jeg vil at agenten skal forsvare rangeringen sin slik at jeg kan stole på den:

> Innboksen min er et rot. Sorter alt ulest fra de siste 4 dagene. Ranger de 8 øverste etter hvor presserende de faktisk er, ikke etter hvor høylytt avsenderen er. For hver av dem, fortell meg fristen hvis det finnes en, hvem som er blokkert, og din én-setnings begrunnelse for rangeringen. Les hele meldingsteksten for alt i topp 8 så du ikke gjetter.

Linja «ikke etter hvor høylytt avsenderen er» betyr noe. Uten den overvekter agenter på emner i STORE BOKSTAVER og «HASTER» fra automatiske systemer. Med den får du skjønn:

\`\`\`text
1. Priya — blocked on staging creds since Thu. A teammate can't ship
   until you respond. No formal deadline but it's costing time now.
2. Stripe dispute — hard deadline in 5 days, money attached, but you
   have buffer so it's #2 not #1.
3. Dana (Acme) — contract sign-off by Fri. Important, not yet urgent.
...
\`\`\`

For denne prompten kaller agenten \`email_read\` med \`action: read\` åtte ganger, én gang per toppelement, fordi du ba den slutte å gjette. Det er den riktige avveiingen: noen ekstra kall for rangeringer du kan handle på. Hvis agenten faktisk treffer en grense midt i kjøringen, returnerer MCP Emails en feil som kan prøves på nytt, med en \`retry_after\`-verdi i sekunder — en veloppdragen klient venter så lenge og fortsetter, i stedet for å hamre løs på serveren.

## Prompt 3: sortering som ender i et svar

Sortering er mer verdifull når den lukker løkker. Når du først stoler på oppsummeringene, la agenten skrive utkast. Jeg holder et menneske i løkka for sendinger, så prompten min ber om utkast, ikke autopilot:

> Samme sortering som vanlig. For alt under «må besvares i dag» som jeg kan svare på med to setninger, skriv utkastet til svaret og vis det til meg. Ikke send ennå — jeg sier «send 1 og 3» eller redigerer dem. Treff min vanlige tone: kort, direkte, ingen byråkratspråk.

Agenten kjører den skrivebeskyttede løkka og skriver så utkast direkte i samtalen. Når du sier «send 1 og 3», kaller den \`email_compose\` med \`action: reply\` for de to. Svar tråder automatisk — MCP Emails setter \`In-Reply-To\`- og \`References\`-overskriftene for deg, så svaret ditt lander i riktig samtale i stedet for å starte en ny. E-posten går ut gjennom din egen leverandør (Gmail API, Microsoft Graph eller din SMTP), så leveringsdyktighet og domeneomdømmet ditt forblir dine. Ingenting relayes fra et delt avsenderdomene.

Vil du ta neste steg og fjerne deg selv fra løkka helt, er det en annen form for automatisering — se [å bygge en e-post-autosvarer med en MCP-agent](/blog/build-email-auto-responder-mcp-agent) for sikkerhetstiltakene jeg ville lagt på den før jeg lot en agent sende uten tilsyn.

## Kjøre sortering på fast plan

Her er den ærlige begrensningen: MCP er **poll, ikke push.** MCP Emails har ingen webhooks og sender ingen serverinitierte hendelser. Agenten din får ikke et pling når post kommer. For å gjøre løpende sortering må noe kalle \`email_read\` med \`action: list\` og \`unread_only: true\` på en timer.

I praksis betyr det ett av to oppsett:

- En planlagt jobb — en cron-oppføring, en planlagt oppgave i agentplattformen din, eller Claudes egen planlegging hvis klienten din støtter det — som utløser morgenoppsummerings-prompten klokka 8 og igjen etter lunsj. To ganger om dagen dekker de fleste.
- En alltid-på agentløkke som poller med noen minutters mellomrom i arbeidstiden. Dette er overkill for en personlig innboks og brenner fartsgrense for lite gevinst. Reserver det for genuint tidskritiske postkasser som support@ eller alerts@.

Jeg kjører den planlagte-jobb-versjonen. To pollinger om dagen, hver én enkelt morgenoppsummerings-prompt mot hovedinnboksen min. Det koster en håndfull verktøykall og legger et rent sammendrag foran meg før jeg åpner e-postklienten. For de fleste slår det en sanntidsløkke på alle akser som betyr noe.

Uansett hvilken takt du velger, hold pollingen ærlig: hyppigere polling betyr ikke raskere, det betyr bare flere forespørsler mot det samme taket på 60 til 1 000 per minutt. Tilpass intervallet til hvor fort innboksen faktisk beveger seg.

## Noen ting som gjør sorteringen merkbart bedre

- **Navngi innboksen.** Hvis du har koblet til mer enn én konto, si «jobbinnboksen min» eller «support-innboksen». Agenten finner den fra titlene i \`inbox_list\`, og du unngår at den sorterer feil postkasse.
- **Gi den en rubrikk, ikke bare «oppsummer».** «Presserende = noen er blokkert eller det er en frist samme dag» gir dramatisk bedre rangeringer enn å la presserende være udefinert.
- **Sett tak på lesingen.** «Åpne bare meldingsteksten når emnet er tvetydig» eller «les de 8 øverste» holder øktene raske og billige. Ubegrenset «les alt» er tregt og sjelden bedre.
- **Hold deg skrivebeskyttet til du stoler på den.** Kjør med et \`read:email\`-omfang i en uke. Legg til \`send:email\` først når utkastene er gjennomgående gode.

Hvis sortering er den første arbeidsflyten du prøver, er det en god en å starte med — den er skrivebeskyttet, gevinsten er umiddelbar, og den bygger tilliten du vil ha før du gir fra deg sendetilgang. For flere ideer når du er komfortabel, her er [sju ting en AI-agent kan gjøre med innbokstilgang](/blog/7-things-ai-agent-can-do-with-inbox-access).

## Prøv det på din egen innboks

Koble til en innboks, lim inn Prompt 1, og se agenten din tynne ut et etterslep på 40 meldinger på under et minutt. Det er [gratis å komme i gang](/signup), uten kort, og du kan trekke tilbake tilgang fra dashbordet med ett klikk. [Verktøyreferansen i dokumentasjonen](/docs) har hver parameter hvis du vil koble løkka inn i et skript i stedet for en chat.`,
};
