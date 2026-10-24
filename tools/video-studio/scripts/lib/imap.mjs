/**
 * The smallest IMAP client the seeding script needs: login, list, select,
 * search, delete, append. Over TLS on 993 only.
 *
 * Written here rather than pulled in as a dependency because the surface is
 * six commands and the popular client publishes several releases a week; a
 * script that holds the demo mailbox password should not take a new release
 * of anything on every install.
 */

import tls from 'node:tls';

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class Imap {
  constructor({ host, port = 993, user, pass, timeoutMs = 30000 }) {
    Object.assign(this, { host, port, user, pass, timeoutMs });
    this.buf = '';
    this.tag = 0;
    this.waiting = null;
  }

  async connect() {
    this.sock = tls.connect({ host: this.host, port: this.port, servername: this.host });
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => {
      this.buf += d;
      this.pump();
    });
    this.sock.on('error', (e) => this.waiting?.reject(e));
    // Server greeting.
    await new Promise((res, rej) => {
      this.waiting = { greeting: true, resolve: res, reject: rej, lines: [] };
      this.pump();
    });
    await this.command(`LOGIN ${quote(this.user)} ${quote(this.pass)}`);
  }

  pump() {
    const w = this.waiting;
    if (!w) return;
    let nl;
    while ((nl = this.buf.indexOf('\r\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 2);
      if (w.greeting) {
        this.waiting = null;
        return line.startsWith('* OK') ? w.resolve(line) : w.reject(new Error(`IMAP greeting: ${line}`));
      }
      if (line.startsWith('+') && w.onContinue) {
        const go = w.onContinue;
        w.onContinue = null;
        go();
        continue;
      }
      if (line.startsWith(`${w.tag} `)) {
        this.waiting = null;
        clearTimeout(w.timer);
        const ok = line.slice(w.tag.length + 1).startsWith('OK');
        // Never echo the command: LOGIN carries the password.
        return ok ? w.resolve(w.lines) : w.reject(new Error(`IMAP ${w.verb} failed: ${line.slice(w.tag.length + 1)}`));
      }
      w.lines.push(line);
    }
  }

  /** Send one command; resolves with its untagged lines. `literal` is sent
   *  after the server's continuation, for APPEND. */
  command(cmd, literal) {
    const tag = `a${++this.tag}`;
    const verb = cmd.split(' ')[0];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`IMAP ${verb} timed out`)), this.timeoutMs);
      this.waiting = { tag, verb, resolve, reject, lines: [], timer };
      if (literal !== undefined) {
        const bytes = Buffer.byteLength(literal, 'utf8');
        this.waiting.onContinue = () => this.sock.write(literal + '\r\n');
        this.sock.write(`${tag} ${cmd} {${bytes}}\r\n`);
      } else {
        this.sock.write(`${tag} ${cmd}\r\n`);
      }
    });
  }

  /** Folder names, as the server spells them. */
  async list() {
    const lines = await this.command('LIST "" "*"');
    return lines
      .filter((l) => l.startsWith('* LIST'))
      .map((l) => {
        const flags = (l.match(/^\* LIST \(([^)]*)\)/) ?? [])[1] ?? '';
        const m = l.match(/ ("(?:[^"\\]|\\.)*"|\S+)$/);
        const name = m ? m[1].replace(/^"|"$/g, '').replace(/\\(.)/g, '$1') : null;
        return { name, noselect: /\\Noselect/i.test(flags) };
      })
      .filter((f) => f.name && !f.noselect);
  }

  create(folder) {
    return this.command(`CREATE ${quote(folder)}`);
  }

  select(folder) {
    return this.command(`SELECT ${quote(folder)}`);
  }

  /** UIDs matching a raw SEARCH criteria string. */
  async search(criteria) {
    const lines = await this.command(`UID SEARCH ${criteria}`);
    const hit = lines.find((l) => l.startsWith('* SEARCH'));
    return hit ? hit.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) : [];
  }

  async deleteUids(uids) {
    if (uids.length === 0) return;
    await this.command(`UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Deleted)`);
    await this.command('EXPUNGE');
  }

  append(folder, rfc822, { seen = false, date } = {}) {
    const flags = seen ? '(\\Seen)' : '()';
    const internal = date ? ` ${quote(imapDate(date))}` : '';
    return this.command(`APPEND ${quote(folder)} ${flags}${internal}`, rfc822);
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch {
      // Servers often close before the tagged OK. Nothing to do.
    }
    this.sock?.end();
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** IMAP INTERNALDATE: "24-Oct-2026 09:15:00 +0000". */
function imapDate(d) {
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}
