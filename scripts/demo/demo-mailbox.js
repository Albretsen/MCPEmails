#!/usr/bin/env node
/**
 * Seed a throwaway demo mailbox with realistic but entirely fictional mail,
 * so the product can be filmed without ever putting real correspondence on
 * camera.
 *
 * Every address uses a `.example` domain. `.example` is reserved by RFC 2606
 * and can never be registered, so no frame of the video can point at a real
 * person or a real company, and nobody can later buy the domain to make it
 * look like we did.
 *
 * Usage:
 *   DEMO_IMAP_HOST=imap.fastmail.com \
 *   DEMO_IMAP_USER=demo@yourdomain.tld \
 *   DEMO_IMAP_PASS='app-specific-password' \
 *   node scripts/demo/demo-mailbox.js seed
 *
 * Commands:
 *   seed    append the fixture messages to INBOX
 *   list    show what is currently in INBOX (verify before filming)
 *   purge   delete and expunge every message in INBOX (reset between takes)
 */

const tls = require("node:tls");

const HOST = process.env.DEMO_IMAP_HOST;
const PORT = Number(process.env.DEMO_IMAP_PORT || 993);
const USER = process.env.DEMO_IMAP_USER;
const PASS = process.env.DEMO_IMAP_PASS;

if (!HOST || !USER || !PASS) {
  console.error(
    "Missing config. Set DEMO_IMAP_HOST, DEMO_IMAP_USER and DEMO_IMAP_PASS.\n" +
      "Use a throwaway mailbox, never a personal one.",
  );
  process.exit(1);
}

/**
 * The fixture set is designed around what the video has to prove in about
 * twenty seconds: that a pile of genuinely mixed mail can be sorted by an
 * agent that was never told the rules in advance.
 *
 * So the shapes matter more than the prose. There are three things that
 * plainly need a human (an invoice past due, a customer escalating, a
 * contract needing signature), a cluster of noise that plainly does not,
 * and two that sit deliberately in between, because a triage demo where
 * every call is obvious proves nothing.
 */
const FIXTURES = [
  {
    from: '"Priya Raghavan" <priya.raghavan@harborline.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Re: Q3 renewal - we need a decision this week",
    daysAgo: 0,
    hoursAgo: 2,
    unread: true,
    body: `Hi,

Following up on the renewal. Our procurement window closes Friday and I still
need the signed order form to get it through in time.

If the seat count is still under discussion I can hold the current pricing for
another 30 days, but I do need to hear back either way before Friday.

Best,
Priya Raghavan
Harborline Logistics`,
  },
  {
    from: '"Billing" <billing@northwind-tools.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Invoice NW-4471 is now 14 days overdue",
    daysAgo: 0,
    hoursAgo: 5,
    unread: true,
    body: `This is an automated reminder that invoice NW-4471 for 1,240.00 EUR
was due on the 5th and remains unpaid.

Invoice:  NW-4471
Amount:   1,240.00 EUR
Due:      5 August 2026
Status:   14 days overdue

A late fee of 2% applies after 30 days. If payment has already been sent,
please disregard this notice.

Northwind Tools Accounts Receivable`,
  },
  {
    from: '"Tom Bergstrom" <tom@fjordline-design.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Contract for signature - Fjordline statement of work",
    daysAgo: 1,
    hoursAgo: 3,
    unread: true,
    body: `Hei,

Attaching the statement of work we discussed on the call. Everything matches
what we agreed: eight weeks, two design sprints, one revision round per sprint.

Could you get this signed by end of week so we can lock the start date? The
team is currently holding capacity for you.

Tom Bergstrom
Fjordline Design`,
  },
  {
    from: '"Aisha Nkemdirim" <aisha@meridian-health.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "This is the third time I have written about the export bug",
    daysAgo: 0,
    hoursAgo: 9,
    unread: true,
    body: `I have now written three times about CSV export producing empty files
for any report over 10,000 rows.

The first ticket was opened on 28 July. I have had one reply asking me to clear
my cache, which I did, and then nothing for two weeks. My team is manually
copying data out of the UI in the meantime.

I would like a real answer on whether this is being fixed, and if so when.

Aisha Nkemdirim
Meridian Health`,
  },
  {
    from: '"Marcus Vogel" <m.vogel@steinberg-partners.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Intro call next week?",
    daysAgo: 1,
    hoursAgo: 7,
    unread: true,
    body: `Hello,

We spoke briefly at the logistics meetup in June. We are looking at tooling in
this space for Q4 and I would like to understand what you have built.

Would 30 minutes next Tuesday or Wednesday work? Happy to work around your
schedule.

Marcus Vogel
Steinberg Partners`,
  },
  {
    from: '"Dana Whitfield" <dana@lakeshore-studio.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Re: moving the Thursday sync to Friday",
    daysAgo: 2,
    hoursAgo: 1,
    unread: false,
    body: `Friday works on our side. Same time, same link.

I will send an updated invite once you confirm.

Dana`,
  },
  {
    from: '"The Interface Weekly" <hello@interfaceweekly.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Issue #212: the quiet return of the sidebar",
    daysAgo: 1,
    hoursAgo: 11,
    unread: true,
    listUnsubscribe: "<mailto:unsubscribe@interfaceweekly.example>",
    body: `THE INTERFACE WEEKLY - Issue #212

This week: why the sidebar came back, three teardowns of onboarding flows that
actually convert, and a short argument against modal dialogs.

Read online: https://interfaceweekly.example/212
Unsubscribe: https://interfaceweekly.example/unsubscribe`,
  },
  {
    from: '"Cascade Analytics" <no-reply@cascade-analytics.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Your weekly traffic summary is ready",
    daysAgo: 2,
    hoursAgo: 4,
    unread: true,
    listUnsubscribe: "<mailto:unsubscribe@cascade-analytics.example>",
    body: `Your weekly summary for the period ending 17 August.

Sessions:        4,182  (+6.1%)
New visitors:    2,904  (+9.4%)
Avg. duration:   2m 41s (-3.0%)

View the full report in your dashboard.
Manage email preferences: https://cascade-analytics.example/prefs`,
  },
  {
    from: '"Riverbend Coffee" <news@riverbend-coffee.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "20% off everything, this weekend only",
    daysAgo: 3,
    hoursAgo: 2,
    unread: true,
    listUnsubscribe: "<mailto:unsubscribe@riverbend-coffee.example>",
    body: `Weekend sale. 20% off the whole shop, including the subscription plans.

Use code WEEKEND20 at checkout. Ends Sunday at midnight.

Unsubscribe: https://riverbend-coffee.example/unsubscribe`,
  },
  {
    from: '"Summit Cloud Status" <status@summitcloud.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "[Resolved] Elevated API latency in eu-north-1",
    daysAgo: 2,
    hoursAgo: 8,
    unread: true,
    body: `The elevated latency affecting the eu-north-1 region between 09:12 and
10:47 UTC has been resolved.

Root cause was a misconfigured connection pool introduced during a routine
deploy. A full post-incident report will follow within five business days.

Summit Cloud Status`,
  },
  {
    from: '"Karin Lund" <karin.lund@harborline.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Wifi password for the Oslo office",
    daysAgo: 4,
    hoursAgo: 6,
    unread: false,
    body: `As promised, for when you are in on Thursday:

Network:  Harborline-Guest
Password: cormorant-19-batch

It rotates monthly, so ask again if you visit after September.

Karin`,
  },
  {
    from: '"Recruiting" <talent@vantage-search.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Senior backend role - would you be open to a conversation?",
    daysAgo: 3,
    hoursAgo: 9,
    unread: true,
    body: `Hello,

I am working with a Series B company building developer infrastructure and your
background looks like a strong match for a senior backend position.

Would you be open to a short call to hear the details? Fully remote, and the
compensation band is competitive.

Vantage Search`,
  },
  {
    from: '"Ops Rota" <rota@harborline.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "You are on call from Monday 24 August",
    daysAgo: 4,
    hoursAgo: 2,
    unread: false,
    body: `A reminder that your on-call rotation begins Monday 24 August at 09:00
and runs for one week.

Please confirm your escalation phone number is current in the rota tool before
the handover.

Ops Rota`,
  },
  {
    from: '"Sofia Marchetti" <sofia@atlas-freight.example>',
    to: '"Demo Owner" <OWNER>',
    subject: "Quick question about the API rate limits",
    daysAgo: 5,
    hoursAgo: 3,
    unread: true,
    body: `Hi,

We are planning an integration and I want to size it correctly. What are the
per-minute rate limits on the API, and do they apply per key or per account?

No rush, but it would help to know before we finalise the design.

Sofia Marchetti
Atlas Freight`,
  },
];

// ---------------------------------------------------------------------------
// Minimal IMAP client. Deliberately dependency-free so this can be run from a
// clean checkout without touching the project's lockfiles.
// ---------------------------------------------------------------------------

function createClient() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: HOST, port: PORT, servername: HOST });
    let buffer = "";
    let counter = 0;
    let pending = null;

    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!pending) return;

      // A literal (used by APPEND) may only be written after the server sends
      // its "+" continuation. Waiting for the byte rather than guessing with a
      // timer is what keeps a seed run from corrupting the mailbox halfway.
      if (pending.literal && /^\+/m.test(buffer)) {
        const payload = pending.literal;
        pending.literal = null;
        buffer = "";
        socket.write(payload + "\r\n");
        return;
      }

      const m = buffer.match(new RegExp(`^${pending.tag} (OK|NO|BAD)([^\\r\\n]*)`, "m"));
      if (m) {
        const response = buffer;
        const w = pending;
        buffer = "";
        pending = null;
        if (m[1] === "OK") w.resolve(response);
        else w.reject(new Error(`${m[1]}${m[2]}`.trim()));
      }
    });

    const send = (command, literal) =>
      new Promise((res, rej) => {
        if (pending) return rej(new Error("a command is already in flight"));
        const tag = `A${String(++counter).padStart(4, "0")}`;
        pending = { tag, literal: literal || null, resolve: res, reject: rej };
        socket.write(`${tag} ${command}\r\n`);
      });

    socket.once("data", () => {
      resolve({
        send,
        close: () => new Promise((r) => socket.end(r)),
      });
    });
  });
}

function imapDate(daysAgo, hoursAgo) {
  const d = new Date(Date.now() - daysAgo * 864e5 - (hoursAgo || 0) * 36e5);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${pad(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} +0000`
  );
}

function rfc822Date(daysAgo, hoursAgo) {
  return new Date(Date.now() - daysAgo * 864e5 - (hoursAgo || 0) * 36e5).toUTCString();
}

function buildMessage(fx) {
  const headers = [
    `From: ${fx.from}`,
    `To: ${fx.to.replace("OWNER", USER)}`,
    `Subject: ${fx.subject}`,
    `Date: ${rfc822Date(fx.daysAgo, fx.hoursAgo)}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}.${Date.now()}@demo.example>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (fx.listUnsubscribe) headers.push(`List-Unsubscribe: ${fx.listUnsubscribe}`);
  return headers.join("\r\n") + "\r\n\r\n" + fx.body.replace(/\n/g, "\r\n");
}

async function seed() {
  const client = await createClient();
  await client.send(`LOGIN "${USER}" "${PASS.replace(/"/g, '\\"')}"`);
  console.log(`Connected to ${HOST} as ${USER}`);

  for (const fx of FIXTURES) {
    const raw = buildMessage(fx);
    const flags = fx.unread ? "()" : "(\\Seen)";
    const bytes = Buffer.byteLength(raw, "utf8");
    await client.send(`APPEND INBOX ${flags} "${imapDate(fx.daysAgo, fx.hoursAgo)}" {${bytes}}`, raw);
    console.log(`  appended: ${fx.subject}`);
  }

  await client.send("LOGOUT").catch(() => {});
  await client.close();
  console.log(`\nSeeded ${FIXTURES.length} messages. Run "list" to verify before filming.`);
}

async function list() {
  const client = await createClient();
  await client.send(`LOGIN "${USER}" "${PASS.replace(/"/g, '\\"')}"`);
  const res = await client.send("SELECT INBOX");
  const exists = (res.match(/(\d+) EXISTS/) || [])[1] || "0";
  console.log(`INBOX contains ${exists} message(s).`);
  if (Number(exists) > 0) {
    const fetched = await client.send("FETCH 1:* (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])");
    console.log(fetched.split("\r\n").filter((l) => /^(From|Subject|Date):/i.test(l)).join("\n"));
  }
  await client.send("LOGOUT").catch(() => {});
  await client.close();
}

async function purge() {
  const client = await createClient();
  await client.send(`LOGIN "${USER}" "${PASS.replace(/"/g, '\\"')}"`);
  const res = await client.send("SELECT INBOX");
  const exists = Number((res.match(/(\d+) EXISTS/) || [])[1] || 0);
  if (exists === 0) {
    console.log("INBOX is already empty.");
  } else {
    await client.send("STORE 1:* +FLAGS (\\Deleted)");
    await client.send("EXPUNGE");
    console.log(`Purged ${exists} message(s) from INBOX.`);
  }
  await client.send("LOGOUT").catch(() => {});
  await client.close();
}

const command = process.argv[2];
const commands = { seed, list, purge };
if (!commands[command]) {
  console.error("Usage: node scripts/demo/demo-mailbox.js <seed|list|purge>");
  process.exit(1);
}
commands[command]().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
