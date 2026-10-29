// Norwegian (Bokmål) copy for /docs/microsoft-365-admin-consent. Same shape
// as `en` in content.mjs; the sources for every claim are listed there.
// Dashboard labels match messages/nb/dashboardChrome.json.

import { MS_GRANT, MS_ASSIGN, CLAUDE_M365 } from './links.mjs';

const nb = {
  meta: {
    title: 'Need admin approval for Outlook eller Microsoft 365? Godkjenn MCPEmails',
    description:
      'Hvorfor Microsoft viser "Need admin approval" når du kobler en Outlook- eller Microsoft 365-postkasse fra jobben til Claude eller ChatGPT, lenken du sender til IT-ansvarlig, og nøyaktig hvilke tillatelser administratoren godkjenner.',
  },
  breadcrumb: 'Godkjenning fra administrator i Microsoft 365',
  eyebrow: 'Dokumentasjon',
  title: 'Microsoft 365: "Need admin approval"',
  lead:
    'Microsoft viser "Need admin approval" når organisasjonen din ikke lar ansatte selv godkjenne e-posttilgang for en app. En IT-administrator godkjenner MCPEmails én gang, og deretter kan alle i organisasjonen koble til sin egen postkasse. Denne siden er for dere begge: hva den som kobler til gjør, og hva administratoren godkjenner.',
  sections: [
    {
      id: 'why',
      h: 'Hvorfor Microsoft ber om en administrator',
      items: [
        'Siden slutten av 2025 hindrer Microsofts standardpolicy for samtykke i jobb- og skoletenanter ansatte i å godkjenne e-posttillatelser som `Mail.Read` og `Mail.ReadWrite` for en app. Microsoft viser **Need admin approval** i stedet for det vanlige samtykkevinduet.',
        'Dette er noe organisasjonen din har bestemt, ikke kontoen din og ikke MCPEmails. At en app kommer fra en verifisert utgiver, hjelper ikke forbi det, og noen organisasjoner har slått av brukersamtykke for alle apper.',
        'Personlige Microsoft-kontoer (Outlook.com, Hotmail, Live) har ingen organisasjon og ingen administrator, så de ser aldri dette vinduet.',
        `Claudes egen Microsoft 365-kobling har det samme kravet: [Anthropics hjelpeartikkel](${CLAUDE_M365}) sier at en global administrator i Microsoft Entra må gi samtykke før noen i organisasjonen kan bruke den. Stegene under gjelder MCPEmails, som kobler postkassen til Claude, ChatGPT og andre MCP-klienter.`,
      ],
    },
    {
      id: 'connecting',
      h: 'Hvis du skal koble til postkassen din',
      ordered: true,
      items: [
        'I MCPEmails-dashbordet åpner du **Innbokser**, deretter **Koble til innboks**, velger Outlook og klikker **Koble til med Microsoft**.',
        'Svarer Microsoft med **Need admin approval**, går du tilbake til dashbordet. Der står det at organisasjonen din må godkjenne postkassetilgangen, og du får valget **Få en lenke til IT-ansvarlig**. Outlook-valget i tilkoblingsvinduet har den samme lenken under **Få godkjenningslenken til administratoren**.',
        'Kopier lenken og send den til IT-ansvarlig på e-post eller i chat. Den virker i 7 dager og kan åpnes flere ganger. Administratoren trenger ikke en MCPEmails-konto.',
        'Når administratoren har godkjent, klikker du **Koble til med Microsoft** igjen. Du logger på med din egen konto, og innboksen kobles til.',
      ],
    },
    {
      id: 'self-admin',
      h: 'Hvis du er din egen administrator',
      items: [
        'Klikk **Jeg er administrator, godkjenn nå** i den samme dialogen. Da åpnes Microsofts godkjenningsside i fanen din, og etter at du har godkjent, kommer du tilbake til dashbordet for å koble til postkassen.',
        'Logg på den siden med en konto som har en av rollene i neste del. En brukerkonto uten rolle kan ikke godkjenne, heller ikke i en liten tenant.',
      ],
    },
    {
      id: 'admin',
      h: 'Hvis du er IT-administrator',
      items: [
        'Lenken åpner Microsofts egen side for administratorsamtykke (`login.microsoftonline.com/organizations/v2.0/adminconsent`) for MCPEmails. Du logger på med jobbkontoen din hos Microsoft, på Microsofts side. MCPEmails ser aldri passordet ditt.',
        `For å godkjenne trenger du en rolle som kan gi samtykke til delegerte tillatelser for hele tenanten. [Microsoft oppgir](${MS_GRANT}) Privileged Role Administrator, Cloud Application Administrator, Application Administrator og AI Administrator, og en global administrator kan også gjøre det.`,
        'Gå gjennom tillatelsene og godta. Godkjenningen gjelder hele organisasjonen, én gang. Hver person logger fortsatt på med sin egen konto når de kobler til, og får bare tilgang til sin egen postkasse.',
        'Deretter kommer du til en MCPEmails-side som viser om Microsoft bekreftet godkjenningen. Mer trengs ikke fra deg.',
        'Lenken gir ingen tilgang i seg selv. Den starter bare Microsofts flyt, og ingenting endres i tenanten din før du godtar der.',
        `Foretrekker du administrasjonssenteret? Hvis MCPEmails allerede står under **Entra ID**, **Enterprise apps**, **All applications**, åpner du den, velger **Permissions** og klikker **Grant admin consent**. [Microsofts veiledning](${MS_GRANT}) beskriver den veien.`,
      ],
    },
    {
      id: 'permissions',
      h: 'Dette godkjenner administratoren',
      items: [
        '`Mail.ReadWrite` (delegert): lese og endre e-post i postkassen til personen som er logget på, slik at KI-en kan søke, lese, skrive utkast, flytte, flagge, administrere mapper og slette.',
        '`Mail.Send` (delegert): sende e-post som personen som er logget på. `Mail.ReadWrite` dekker ikke sending, så dette er en egen tillatelse.',
        '`offline_access`: holde tilkoblingen i gang uten ny pålogging, til personen kobler fra eller tilgangen fjernes.',
        'Når hver person logger på, ber MCPEmails også om `openid`, `profile` og `email` for å lese navn og adresse. Samtykkepolicyer begrenser ikke disse grunnleggende påloggingstillatelsene, så de er ikke med i administratorgodkjenningen.',
        'Alle tillatelsene er delegerte. MCPEmails ber ikke om noen applikasjonstillatelser, så den handler bare på vegne av personen som logget på, og kan ikke åpne andre postkasser i tenanten din.',
        'Meldinger hentes direkte fra Microsoft for hver forespørsel og lagres ikke. Tokenet fra hver pålogging er kryptert når det lagres, og data lagres i Stockholm. Se [sikkerhet](/security).',
      ],
    },
    {
      id: 'control',
      h: 'Begrens eller fjern tilgangen senere',
      items: [
        `Vil du at bare noen skal kunne koble til, slår du på **Assignment required** for MCPEmails under **Enterprise apps** og tildeler appen til brukerne eller gruppene som skal kunne logge på. [Microsofts veiledning](${MS_ASSIGN}) har stegene.`,
        'For å fjerne den for hele organisasjonen sletter eller deaktiverer du MCPEmails under **Enterprise apps**.',
        'Hver person kan når som helst koble fra sin egen postkasse ved å slette innboksen i MCPEmails-dashbordet.',
      ],
    },
    {
      id: 'problems',
      h: 'Hvis det fortsatt ikke virker',
      items: [
        '**"Godkjenningen gikk ikke gjennom".** Microsoft bekreftet ikke godkjenningen, så Outlook er fortsatt blokkert. Administratoren åpner lenken igjen, logget på med en konto som har en av rollene over.',
        '**"Ikke godkjent".** Godkjenningen ble avbrutt i Microsofts vindu, og ingenting er endret. Åpne lenken igjen når du er klar.',
        '**"Denne lenken har utløpt" eller "Denne lenken er ikke gyldig".** Lenker varer i 7 dager og må kopieres i sin helhet. Hent en ny fra dashbordet.',
        '**"Start på nytt".** Godkjenningen tok mer enn 10 minutter eller ble fullført i en annen nettleser. Åpne lenken igjen og fullfør i den samme nettleseren.',
        '**Ingen Outlook-postkasse.** En konto uten postkasse i Exchange Online, for eksempel en administratorkonto uten Exchange-lisens, har ingenting å koble til, så MCPEmails avviser den. Ligger e-posten din hos en annen leverandør, kobler du den til med IMAP i stedet.',
        '**Et forespørselsskjema i stedet for godkjenningssiden.** Har organisasjonen din slått på Microsofts arbeidsflyt for administratorsamtykke, kan en bruker som prøver å koble til, få se et skjema for å be om godkjenning. Administratoren kan godkjenne den forespørselen, eller bare åpne MCPEmails-lenken.',
      ],
    },
  ],
  evidence: {
    h: 'Sjekk det selv',
    intro: 'MCPEmails har åpen kildekode. Disse filene lager lenken, starter godkjenningen og lister opp tillatelsene som denne siden beskriver:',
    labels: {
      link: 'Den signerte godkjenningslenken som varer i sju dager, og resultatstatusene',
      route: 'Den offentlige ruten lenken åpner, og tillatelsene den ber administratoren om',
      oauth: 'Tillatelsene hver person gir ved pålogging, og hvordan et "Need admin approval"-svar blir gjenkjent',
    },
  },
  cta: {
    title: 'Koble til Microsoft 365-postkassen din',
    sub: 'Én innboks er gratis, for alltid.',
    button: 'Kom i gang',
    providers: 'Oppsett for Microsoft 365',
  },
};

export default nb;
