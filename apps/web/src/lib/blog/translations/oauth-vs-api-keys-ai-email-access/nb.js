export default {
  title: 'OAuth vs. API-nøkler for AI-e-posttilgang: Hva bør du bruke?',
  description: 'OAuth vs. API-nøkler for AI-e-posttilgang: bruk OAuth for claude.ai, Claude Desktop og Cursor; bruk en scopet API-nøkkel for Cline, JetBrains og skript.',
  coverAlt: 'OAuth versus API-nøkler for å koble AI-agenter til e-post — MCPEmails',
  content: `Når du kobler en AI-agent til e-posten din gjennom MCP Emails, autentiserer du på én av to måter: OAuth eller en API-nøkkel. Det korte svaret er OAuth hvis klienten din støtter det (claude.ai, Claude Desktop, Cursor), og en scopet API-nøkkel hvis den ikke gjør det (Cline, JetBrains, skript, cURL). Begge treffer samme endepunkt og eksponerer de samme verktøyene. Forskjellen er hvem som forvalter hemmeligheten og hvor enkelt du kan trekke ut støpselet.

Dette er ikke en avveining mellom sikkerhet og bekvemmelighet der du ofrer det ene for det andre. Begge veiene er scopet til nøyaktig \`read:email\`, \`send:email\`, eller begge, og begge kan tilbakekalles fra dashbordet med ett klikk. Det egentlige spørsmålet er hva som passer klienten du faktisk bruker. For det store bildet av hvordan alt dette henger sammen, start med pilarguiden, [hvordan du gir AI-agenten din tilgang til e-post](/blog/how-to-give-your-ai-agent-email-access).

## Anbefalingen på 30 sekunder

Bruk **OAuth** når MCP-klienten din støtter det. Det dekker claude.ai, Claude Desktop og Cursor i dag. Du limer inn én URL, logger inn, godkjenner scopene, og du er ferdig. Ingen hemmelighet å kopiere, ingen hemmelighet å lagre, ingen hemmelighet å lekke.

Bruk en **API-nøkkel** når klienten din ikke har noen OAuth-flyt. Cline, JetBrains AI-assistenten, en Python-cron-jobb, et shell-skript som sender JSON-RPC over cURL — disse trenger en bearer-token. Du lager én i dashbordet, scoper den, kopierer den én gang, og sender den i \`Authorization\`-headeren.

Hvis begge er alternativer for samme klient, velg OAuth. Færre hemmeligheter i konfigurasjonsfilene dine er alltid det beste standardvalget.

## Slik fungerer OAuth her

OAuth er veien uten nøkkel. I stedet for at du genererer en legitimasjon og limer den inn et sted, forhandler klienten og serveren frem en direkte, og token-en lever inne i klienten i stedet for i en konfigurasjonsfil du må forvalte.

I claude.ai er flyten: **Customize → Connectors → Add connector → lim inn URL-en → Connect → logg inn og godkjenn.** URL-en er MCP-endepunktet, \`https://mcpemails.com/api/mcp\`. Etter at du har godkjent, har agenten tilgang og du rørte aldri en hemmelighet.

Under panseret er det standard, moderne OAuth:

- **Authorization Code + PKCE** (RFC 7636), slik at ingen klienthemmelighet noen gang overføres. PKCE er den samme mekanismen som beskytter innlogginger på mobil og single-page-apper.
- **Dynamic Client Registration** (RFC 7591), slik at klienten registrerer seg selv uten manuelt oppsett fra din side.
- **Token-er fornyes automatisk** inne i støttede klienter. Du passer ikke på et utløp.
- **Scopene er nøyaktig det du godkjenner** på samtykkeskjermen: \`read:email\`, \`send:email\`, eller begge.

Den praktiske fordelen: token-en dukker aldri opp som en ren tekststreng du ved et uhell kunne committe, logge eller lime inn i feil chat. Når du vil kutte tilgangen, tilbakekaller du tilkoblingen i dashbordet og agenten er stengt ute umiddelbart. Grunnen til at den tilbakekallingen faktisk betyr noe: innboksen selv forblir urørt fordi [e-post aldri lagres](/blog/why-email-never-stored-matters) hos oss i utgangspunktet.

## Slik fungerer API-nøkler her

Noen klienter snakker ikke OAuth. Det er ikke et stikk mot dem. Cline, JetBrains, og alt du skriver selv forventer rett og slett en bearer-token, som er den eldre og helt greie måten å autentisere en maskin på.

Du lager én i **Dashboard → API Keys**:

1. Gi nøkkelen et navn du kjenner igjen senere (\`cline-laptop\`, \`triage-cron\`).
2. Velg scopene: \`read:email\`, \`send:email\`, eller begge.
3. Kopier den. Den vises **én gang** og aldri igjen. Mister du den, lager du en ny.

Nøkkelen ser slik ut: \`mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456\`, og du sender den med hver forespørsel:

\`\`\`
Authorization: Bearer mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456
\`\`\`

Et rått JSON-RPC-kall for å liste innboksene dine ser slik ut:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "inbox_list", "arguments": {} }
}
\`\`\`

POST det til \`https://mcpemails.com/api/mcp\` med bearer-headeren, så får du tilbake de tilkoblede innboksene dine og ID-ene deres. Derfra kaller agenten \`email_read\` (med \`action\` satt til list, read eller search) og \`email_compose\` (\`action\` send, reply eller forward) — kjerneverktøyene, pluss \`email_organize\`, \`folder\`, \`schedule\` og \`contact_search\` for flagg, mapper, planlegging og kontakter.

Det ene API-nøkler ber deg om som OAuth ikke gjør: behandle nøkkelen som et passord. Det er en langlivet hemmelighet i ren tekst. Legg den i en miljøvariabel, ikke i kildekode du skal pushe til GitHub. Hvis en nøkkel lekker, tilbakekall den fra dashbordet og roter til en ny.

## Scopes: gi minimum, hver gang

Denne delen er identisk for begge metodene, og det er sikkerhetskontrollen som gjør mest arbeid. En tilkobling som bare kan \`read:email\` kan ikke sende noe, uansett hva agenten bestemmer seg for å gjøre. Hvis du bygger en [arbeidsflyt for oppsummering og triagering](/blog/ai-agent-triage-summarize-inbox), gi kun lesetilgang. Agenten leser, rangerer og rapporterer, og det finnes ingen vei for en forvirret eller manipulert modell til å fyre av en melding.

Legg bare til \`send:email\` når sending er den faktiske jobben, som en [autosvarer bygget på MCP-verktøyene](/blog/build-email-auto-responder-mcp-agent). Selv da, scop en egen nøkkel eller tilkobling per oppgave i stedet for én altoverskridende legitimasjon du gjenbruker overalt. Minste privilegium er ikke paranoia. Det er den billigste forsikringen du kommer til å kjøpe.

## Så hva bør du bruke?

### Bruk OAuth hvis ...

Klienten din er claude.ai, Claude Desktop eller Cursor. Du vil ha null hemmeligheter i konfigurasjonen din. Du vil at token-fornyelse skal håndteres for deg. Du vil ha den ryddigst mulige tilbakekallingshistorien. Dette er standardvalget og det du bør gripe etter først.

### Bruk en API-nøkkel hvis ...

Klienten din har ingen OAuth-støtte — Cline, JetBrains, OpenAI-stil-verktøykjørerne, eller din egen kode. Du skripter mot endepunktet med cURL eller et lite program. Du trenger en stabil legitimasjon som en hodeløs prosess kan bruke uten at et menneske klikker seg gjennom en samtykkeskjerm. En scopet nøkkel er akkurat riktig her, og det finnes en full gjennomgang for [Cursor-, Cline- og VS Code-klientene](/blog/email-for-ai-agents-cursor-cline-vscode).

Én ting til som er sant uansett hva du velger: rategrenser. Hver API-nøkkel er begrenset til 100 requests/minute, 1 000/hour og 10 000/day, og hvert arbeidsområde har et burst-tak per plan (60/min på [Free](/pricing), opptil 1 000/min på Scale). Når du treffer en grense gir serveren tilbake en \`retry_after\`-verdi i sekunder. Respekter den, og prøv aldri en \`email_compose\`-sending blindt på nytt — du kommer til å sende dobbelt.

## Konklusjonen

OAuth og API-nøkler er ikke en sikkerhetsrangering. De er et samsvar med klienten din. OAuth er det beste standardvalget fordi det holder hemmeligheter helt unna hendene dine, men en scopet, godt lagret API-nøkkel er genuint trygg for klientene og skriptene som trenger en. Velg scopene nøye, lagre nøkler i miljøvariabler, og tilbakekall alt du ikke bruker.

Klar til å koble en opp? Å koble til en innboks og en klient tar omtrent [to minutter fra ende til ende](/blog/connect-email-to-ai-agent-under-2-minutes), eller du kan lese hele [dokumentasjonen](/docs) og [komme i gang gratis](/signup).`,
};
