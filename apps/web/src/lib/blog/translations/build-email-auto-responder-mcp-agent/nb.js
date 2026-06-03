export default {
  title: 'Bygg en automatisk e-postsvarer med en MCP-tilkoblet agent',
  description: 'Bygg en automatisk e-postsvarer med en MCP-tilkoblet AI-agent: poll etter ulest e-post, lag utkast og svar trygt med scopes, ratebegrensninger og sikringer.',
  coverAlt: 'Bygg en automatisk e-postsvarer med en MCP-tilkoblet agent — MCPEmails',
  content: `En automatisk e-postsvarer bygget på MCP Emails er en løkke, ikke en webhook. Det finnes ingen server-initierte hendelser, så agenten din **poller** etter ulest e-post på et tidsskjema med \`email_read\` (action \`list\`), leser hver melding med \`email_read\` (action \`read\`), lager et svarutkast og kaller \`email_compose\` (action \`reply\`). Dette innlegget går gjennom hele byggingen: polleløkken, scopene du trenger, hvordan du overlever ratebegrensninger, og sikringene som hindrer en agent i å spamme kontaktene dine med hallusinerte svar.

Dette er den avanserte enden av historien om å [gi AI-agenten din e-posttilgang](/blog/how-to-give-your-ai-agent-email-access). Hvis du bare vil ha triagering og morgensammendrag uten å sende noe, les [Triagering og oppsummering av innboks med en AI-agent](/blog/ai-agent-triage-summarize-inbox) først — det er et tryggere sted å starte. Kom tilbake hit når du faktisk vil at agenten skal trykke send.

## Den ærlige delen: det finnes ingen webhook

De fleste «autosvar»-veiledninger antar at en push-hendelse utløses i det øyeblikket e-post lander. MCP Emails fungerer ikke slik, og det gjør heller ingen MCP-server jeg kjenner til. MCP er en forespørsel/svar-verktøyprotokoll. Serveren svarer når agenten din spør; den ringer aldri deg.

Så en ekte automatisk e-postsvarer er en planlegger pluss en poll. Du kjører et tikk hvert N-te sekund eller minutt, ber om uleste meldinger, og behandler det som er nytt. Det er alt. Det er mindre elegant enn en webhook, men det er forutsigbart, og det betyr at *du* styrer takten og rekkevidden.

Velg et pollintervall som matcher toleransen din for forsinkelse opp mot ratebudsjettet ditt. Hvert 60. sekund er greit for support-aktige svar. Hvert 5. minutt er rikelig for de fleste innbokser og rører knapt grensene dine. Ikke poll hvert sekund — du brenner kvote uten grunn, og innboksen endrer seg sjelden så raskt.

## Det du trenger: en API-nøkkel med send-scope

En automatisk e-postsvarer kjører nesten alltid som et skript eller en cron-jobb, ikke inne i en chat-klient. Det betyr [API-nøkkel-veien, ikke OAuth](/blog/oauth-vs-api-keys-ai-email-access).

I dashbordet går du til **API Keys**, oppretter en nøkkel og gir den scopene du faktisk trenger:

- \`read:email\` — for å polle, liste og lese meldinger med \`email_read\`.
- \`send:email\` — for å kalle \`email_compose\` (action \`reply\`).

Nøkkelen vises bare én gang. Kopier den. Den ser ut som \`mcpe_live_...\` og du sender den med på hver forespørsel:

\`\`\`
Authorization: Bearer mcpe_live_YOUR_KEY
\`\`\`

MCP-endepunktet er én enkelt URL:

\`\`\`
https://www.mcpemails.com/api/mcp
\`\`\`

Gi **bare** de scopene jobben bruker. Hvis en fremtidig versjon av svareren din trenger å videresende eller flagge e-post, legger du til disse funksjonene da. En nøkkel som kan lese og svare, er en nøkkel som — hvis den lekker — bare kan lese og svare. (For hele bildet om håndtering og rotasjon av nøkler, se [dokumentasjonen](/docs).)

## Løkken

Her er formen på en fungerende svarer. Jeg har skrevet den som pseudokode over MCP-verktøyene, så det er tydelig hvilke kall som skjer i hvilken rekkefølge. Den nøyaktige oppkoblingen av MCP-klienten avhenger av stacken din, men sekvensen er poenget.

\`\`\`python
# Tools used: inbox_list, email_read, email_compose

inbox = inbox_list()[0]              # discover, never hardcode the UUID

while True:
    unread = email_read(
        action="list",
        inbox_id=inbox["inbox_id"],
        unread_only=True,
        limit=20,
    )

    for summary in unread["messages"]:
        if not should_handle(summary):   # allowlist + filters, see below
            continue

        msg = email_read(
            action="read",
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
        )

        draft = generate_reply(msg)      # your LLM call

        if not passes_guardrails(draft, msg):
            queue_for_human(msg, draft)  # don't send; flag it
            continue

        send_with_backoff(
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
            body=draft,
        )

    sleep(60)
\`\`\`

Tre ting å legge merke til. For det første kaller agenten \`inbox_list\` for å oppdage \`inbox_id\` i stedet for å lime en UUID inn i koden — det er oppdag-først-mønsteret, og det holder skriptet i gang hvis du kobler til en innboks på nytt. For det andre er \`unread_only: true\` det som gjør dette til en svarer for *ny e-post* i stedet for en maskin som svarer alle på nytt. For det tredje går hver melding gjennom sikringer før noe sendes.

### Markere meldinger som håndtert

Hvis du vil at en melding skal slutte å dukke opp som ulest når du har svart, leser du den med \`mark_as_read\` satt, eller kaller \`mark_read\` eksplisitt. Vær bevisst her: hvis løkken din svarer, men aldri markerer meldingen som lest, vil neste tikk svare igjen. Marker-som-håndtert er hvordan løkken forblir idempotent.

## Ratebegrensninger, og hvorfor du aldri prøver et send-kall på nytt i blinde

Hver API-nøkkel er begrenset til **100 forespørsler per minutt, 1 000 per time og 10 000 per dag**, uavhengig av plan. Arbeidsområdet ditt har også et burst-tak per nivå — **60 req/min på Free, 300 på Solo, 1 000 på Team** (se [priser](/pricing)). En høflig poll-og-svar-løkke lever godt innenfor det, men en som oppfører seg dårlig kan utløse det.

Når du treffer en grense, returnerer serveren en feil du kan prøve på nytt (kode \`-32029\`) med \`data.retry_after\` i sekunder. Respekter den. Sov så lenge, og fortsett deretter.

Her er regelen som betyr mest: **prøv aldri en \`email_compose\`-sending eller -respons automatisk på nytt i blinde.** En sending er ikke idempotent. Hvis et send-kall får tidsavbrudd eller returnerer tvetydig, kan et naivt nytt forsøk levere det samme svaret to ganger. Prøv *lesinger* på nytt fritt; behandle *sendinger* som engangskall, og prøv bare på nytt ved en eksplisitt feil du kan prøve på nytt, med backoff og et hardt tak.

\`\`\`python
def send_with_backoff(**kwargs):
    delay = 2
    for attempt in range(3):
        try:
            return email_compose(action="reply", **kwargs)
        except RateLimited as e:
            sleep(e.retry_after or delay)
            delay *= 2
        except RetryableError:
            sleep(delay)
            delay *= 2
        # any other error: do NOT retry a send. log it, move on.
        else:
            break
    raise SendFailed(kwargs)
\`\`\`

Legg merke til at den bare prøver på nytt ved ratebegrensning eller eksplisitt prøvbare feil, stopper på tre forsøk, og aldri løkker i det uendelige. En sending som feiler tre ganger er et menneskes problem, ikke løkkens.

## Sikringer: forskjellen mellom et verktøy og en risiko

En automatisk e-postsvarer som sender uten tilsyn er én dårlig prompt unna å sende sjefen din et selvsikkert feil svar. Bygg bremsene før du bygger motoren.

### Lag en tillatelsesliste over hvem som får autosvar

Ikke svar alle. Start med en smal tillatelsesliste — et support-alias, et bestemt avsenderdomene, meldinger som matcher et emnemønster. Alt annet settes i kø for et menneske eller ignoreres. En tillatelsesliste er den enkeltsikringen med høyest gevinst du kan legge til, fordi den avgrenser feilen til en gruppe du selv valgte.

### Hold et menneske i løkken, i hvert fall i starten

Den tryggeste versjonen av dette er egentlig ikke en automatisk svarer i det hele tatt — det er en automatisk *utkast-skriver*. Agenten leser, lager utkast og klargjør svaret, men en person godkjenner sendingen. MCP Emails støtter utkast, så du kan la løkken kalle \`draft\` (action \`create\`) i stedet for \`email_compose\`, og deretter sende de gode selv. Kjør i utkastmodus i en uke. Les hva den ville ha sendt. Først da slår du på automatisk sending for dem du stoler på.

### Stopp løkker og selvsvar

To klassiske feilmoduser:

- **Autosvar-pingpong.** Hvis du svarer på et feriefraværsvar og det svarer på svaret ditt, har du bygget en uendelig løkke med en annens bot. Filtrer bort meldinger som ser automatiske ut (sjekk etter \`Auto-Submitted\`-headere, \`no-reply\`-avsendere eller kjente autosvar-emner) og svar aldri på din egen adresse.
- **Svare på samme tråd om og om igjen.** Marker meldinger som lest etter håndtering, og før et lite register over meldings-ID-er du allerede har besvart. Idempotens er ikke valgfritt når sending er involvert.

### Begrens hva modellen kan si

Gi utkast-modellen stramme instruksjoner og et lengdetak. For support-svar slår en mal med felter friform-generering. Og kjør en billig sjekk før sending: inneholder utkastet et refusjonsløfte, en pris, en juridisk forpliktelse eller en lenke du ikke forventet? I så fall ruter du det til et menneske. Det er \`passes_guardrails\`-sjekken i løkken over, og det er der du bruker mesteparten av ingeniørinnsatsen din.

## En realistisk første versjon

Hvis jeg skulle satt dette i drift for en ekte innboks i morgen, ville jeg startet smått og kjedelig:

1. API-nøkkel med \`read:email\` og \`send:email\`, avgrenset til én innboks.
2. Poll \`email_read(action: "list", unread_only: true)\` hvert annet minutt.
3. Tillatelsesliste med nøyaktig ett support-alias.
4. Kun utkastmodus — opprett utkast, send ingenting automatisk.
5. Etter en uke med å lese utkastene, slå på automatisk sending for de åpenbare tilfellene og fortsett å lage utkast for resten.

Det er et system du faktisk kan stole på, og det lar seg generalisere. Den samme løkken med en annen prompt blir en triagebot, en lead-ruter eller en varsler. For en bredere meny over hva en agent kan gjøre når den er koblet til, se [7 ting en AI-agent kan gjøre med innbokstilgang](/blog/7-things-ai-agent-can-do-with-inbox-access). Hvis du fortsatt vurderer om du i det hele tatt skal gi en agent sendetilgang, er [er det trygt å gi en AI-agent e-posttilgang](/blog/is-it-safe-to-give-ai-agent-email-access) verdt tiden din før du går i drift.

Klar til å bygge det? Opprett en avgrenset API-nøkkel og les verktøyreferansen i [dokumentasjonen](/docs), eller [start gratis](/signup) — hver plan inkluderer ubegrenset antall verktøykall, så det eneste svareren din koster er disiplinen til å legge til sikringene først.`,
};
