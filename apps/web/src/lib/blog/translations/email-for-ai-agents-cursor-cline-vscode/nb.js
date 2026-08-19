export default {
  title: 'Sette opp e-post for AI-agenter i Cursor, Cline og VS Code',
  description: 'Gi kodeagenten din e-posttilgang i Cursor, Cline og VS Code. Cursor bruker OAuth; Cline og egendefinerte klienter bruker en avgrenset API-nøkkel over MCP. Komplett oppsett.',
  coverAlt: 'Sette opp e-posttilgang for AI-kodeagenter i Cursor, Cline og VS Code over MCP',
  content: `Her er kortversjonen. For å gi en kodeagent i editoren din tilgang til en ekte innboks, peker du den mot ett MCP-endepunkt: \`https://www.mcpemails.com/api/mcp\`. Cursor snakker OAuth, så du limer inn den URL-en og logger inn. Cline, den rå MCP-konfigurasjonen i VS Code og ethvert egendefinert skript gjør ikke OAuth-dansen, så de autentiserer med en avgrenset API-nøkkel sendt som en \`Authorization: Bearer\`-header. Samme endepunkt, samme verktøy, to veier inn.

Denne guiden dekker begge løypene, viser hvordan du lager en API-nøkkel avgrenset til nøyaktig \`read:email\` og \`send:email\`, og avslutter med en utviklingsflyt jeg faktisk bruker: agenten sorterer innboksen min og sender svar uten at jeg forlater editoren. Vil du ha det store bildet først, er pilarguiden om [hvordan du gir AI-agenten din tilgang til e-post](/blog/how-to-give-your-ai-agent-email-access) stedet å begynne.

## Før du kobler opp noen klient: koble til en innboks

MCP-serveren eier ikke e-posten din. Den megler en levende tilkobling til hvilken leverandør du allerede bruker, henter meldinger ved kalltidspunktet og forkaster dem. Ingenting om e-posten din lagres. Så steg én skjer i dashbordet, ikke i editoren din.

Gå til **Dashboard → Inboxes → Connect Inbox** og velg en leverandør:

- **Gmail** eller **Outlook / Microsoft 365** → ett-klikks OAuth. Logg inn med Google eller Microsoft og godkjenn.
- **iCloud, Fastmail, Yahoo, Zoho eller en hvilken som helst generisk IMAP-vert** → et app-spesifikt passord. Generer det i leverandørens innstillinger (for iCloud er det appleid.apple.com) og lim det inn.

Fastmail bruker kun app-passord, ikke OAuth, så ikke let etter et samtykkebilde i Google-stil der. Er du på iCloud eller Fastmail, har [gjennomgangen av oppsett for iCloud, Fastmail og IMAP](/blog/connect-icloud-fastmail-imap-to-claude) detaljene per leverandør. På Outlook, se [hvordan du kobler til Outlook og Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Når en innboks er koblet til, når agenten den gjennom verktøy. Du limer aldri inn en UUID eller et passord i editorkonfigurasjonen din.

## Cursor: lim inn URL-en, logg inn, ferdig

Cursor støtter OAuth 2.0 for MCP-servere, som er den smertefrie løypen. Det finnes ingen API-nøkkel og ingen hemmelighet å håndtere i en konfigurasjonsfil.

1. Åpne Cursor-innstillingene og finn seksjonen for MCP-servere.
2. Legg til en ny server med URL-en \`https://www.mcpemails.com/api/mcp\`.
3. Cursor åpner et nettleservindu. Logg inn på MCP Emails-kontoen din og godkjenn omfangene du vil at agenten skal ha — \`read:email\`, \`send:email\`, eller begge.
4. Tilkoblingen blir grønn og e-postverktøyene dukker opp i Cursors verktøyliste.

Under panseret er det OAuth 2.0 authorization code med PKCE, og tokenet Cursor holder er avgrenset til nøyaktig det du godkjente. Ga du bare \`read:email\`, kan agenten bokstavelig talt ikke sende. Når du er ferdig, kan du tilbakekalle tilkoblingen fra **Dashboard → API Keys** (OAuth-tildelinger bor der også) med ett klikk, og Cursors tilgang dør umiddelbart.

Claude Desktop og claude.ai følger den samme lim-inn-og-godkjenn-flyten hvis du også kjører dem.

## Cline, rå VS Code og egendefinerte skript: bruk en API-nøkkel

Cline, den nakne \`mcp\`-konfigurasjonen i VS Code, JetBrains og alt du selv skripter, implementerer ikke OAuth-håndtrykket. For dem oppretter du en API-nøkkel og sender den som et bearer-token. Dette er også det rette valget for CI-jobber og cron-drevet automatisering der det ikke finnes noe menneske til å klikke på et godkjenningsbilde.

### Steg 1: opprett en avgrenset API-nøkkel

I **Dashboard → API Keys**, klikk **Create key**. Gi den et navn du kjenner igjen senere (\`cline-laptop\`, \`triage-cron\`), og velg så omfangene dens:

- \`read:email\` for liste, søk og lesing.
- \`send:email\` for sending og svar.

Gi bare det klienten trenger. En skrivebeskyttet sorteringsassistent har ingenting å gjøre med å holde \`send:email\`. Nøkkelen vises nøyaktig én gang — kopier den i det øyeblikket den dukker opp, for du kan ikke se den igjen. Mister du den, roterer du den, du gjenoppretter den ikke.

### Steg 2: legg nøkkelen i klientkonfigurasjonen din

For Cline (og de fleste MCP-oppsett i VS Code) legger du serveren til i MCP-konfigurasjonens JSON med bearer-headeren:

\`\`\`json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

Et rått cURL-kall for å bekrefte at nøkkelen virker før du rører noen editor:

\`\`\`bash
curl -s https://www.mcpemails.com/api/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

Får du en verktøyliste tilbake, er du tilkoblet. En \`-32001\`-feil betyr at nøkkelen er ugyldig eller mangler et omfang — den er ikke gjentakbar, så fiks nøkkelen i stedet for å gå i loop. Ikke commit nøkkelen. Les den fra en miljøvariabel og hold den utenfor git. Veier du hvilken autentiseringsmodell du skal bruke hvor, legger [OAuth vs API-nøkler for AI-e-posttilgang](/blog/oauth-vs-api-keys-ai-email-access) frem avveiningene.

## Verktøyene agenten din får

Begge løypene eksponerer den samme flaten. En håndfull konsoliderte, handlingsbaserte verktøy dekker arbeidet:

- \`inbox_list\` — kall alltid dette først for å oppdage tilkoblede innbokser og ID-ene deres.
- \`email_read\` (handling \`list\`) — paginert, nyeste først.
- \`email_read\` (handling \`read\`) — parset ren tekst, valgfri renset HTML, vedlegg.
- \`email_read\` (handling \`search\`) — leverandørnativt søk (Gmail-operatorer, Outlook KQL, IMAP-tekst).
- \`email_compose\` (handling \`send\`) — sett sammen med CC/BCC, HTML, vedlegg opptil 10 MB.
- \`email_compose\` (handling \`reply\`) — setter In-Reply-To- og References-headere for deg slik at tråden holdes intakt.

Det finnes noen flere for flagg og flytting (\`email_organize\`), mapper, planlagt sending og kontakter, men disse få gjør brorparten av det reelle arbeidet.

## En utviklingsflyt som gjør seg fortjent til plassen

Her er det det lønner seg. Jeg holder en les+send-nøkkel koblet inn i editoren min og lener meg på agenten i de delene av dagen jeg ellers ville mistet til innboksen.

Morgensortering, skrevet rett inn i chatpanelet:

> Kall inbox_list, og list så ulest fra arbeidsinnboksen min de siste 12 timene. Grupper dem: trenger svar, FYI og støy. For FYI-bunken, gi meg én linje hver.

Agenten kjører \`inbox_list\`, deretter \`email_read\` med handling \`list\` og \`unread_only\` satt, leser de som betyr noe, og leverer tilbake et sortert sammendrag. Når jeg ser en jeg vil ha besvart, følger jeg opp:

> Svar på meldingen fra designkonsulenten og bekreft at torsdag klokken 14 fungerer, hold det kort.

Den kaller \`email_compose\` med handling \`reply\`, trådingen er håndtert, og svaret går ut gjennom min egen Gmail — så det lander fra adressen min med domenets omdømme, ikke et eller annet relé. For en grundigere behandling av sorteringsledetekster, se [hvordan du får en AI-agent til å sortere og oppsummere innboksen din](/blog/ai-agent-triage-summarize-inbox).

En ærlig begrensning: det finnes ingen webhooks. Serveren dytter ikke ny post til deg. Vil du at agenten skal reagere på innkommende meldinger, må du polle — \`email_read\` med handling \`list\` og \`unread_only: true\` etter en plan. Det er et bevisst designvalg, og det former hvordan du bygger noe som helst reaktivt, som en [autosvarer over MCP](/blog/build-email-auto-responder-mcp-agent).

## Ratebegrensninger for skriptet tilgang

Driver du serveren fra en cron-jobb eller en tett agentløkke, ta hensyn til grensene. Hver API-nøkkel er begrenset til **100 forespørsler per minutt, 1 000 per time og 10 000 per dag**, på alle planer. I tillegg finnes det et burst-tak per arbeidsområde satt av planen din: 60/min på Free, 300/min på Agent ($12/month), 1 000/min på Scale ($49/month). Se [prissiden](/pricing) for hele oversikten.

Når du treffer en hastighetsgrense, returnerer serveren en gjentakbar feil (kode \`-32003\`) med \`data.retry_after\` i sekunder. Respekter den — bakk av så lenge og prøv igjen. Men ikke alt kan prøves på nytt: bruker du opp den månedlige handlingskvoten på planen din, returnerer kallet et vanlig verktøyresultat med \`isError: true\` og en \`_meta["com.mcpemails/usage_limit"]\`-blokk, uten \`retry_after\`, og ingen nye forsøk løser det før \`reset_at\`. Og prøv aldri blindt på nytt en \`email_compose\`-sending ved en generisk feil; du fyrer av duplikater. Sjekk om den faktisk ble sendt først.

## Oppsummering

Cursor kobler deg opp med en URL og en innlogging. Alt annet krever en avgrenset nøkkel og en bearer-header. Begge treffer det samme endepunktet og de samme verktøyene, og begge holder legitimasjonen din utenfor repoet ditt og utenfor modellens kontekst.

[Kom i gang gratis](/signup) og koble til din første innboks, eller les [dokumentasjonen](/docs) for den fullstendige verktøyreferansen.`,
};
