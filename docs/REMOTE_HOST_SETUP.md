# Standing up the remote-support host (AWS Lightsail)

A step-by-step for someone who has not used Lightsail before. About 45 minutes,
most of it waiting for DNS.

**What you are building:** one small always-on Linux box running MeshCentral —
the engine that carries remote-desktop sessions between an engineer's browser
and a lab PC. The portal never carries the session itself (Vercel functions
cannot hold a connection open); it decides who may connect, writes it down, and
hands the browser a short-lived link to this box.

**What you need before starting:** an AWS account, and access to wherever DNS for
your portal domain is managed.

**Cost:** the 2 GB plan, roughly $12/month at current pricing — check the plan
selector, and note new instances often come with a free first month.

---

## 1. Create the instance

1. Go to **https://lightsail.aws.amazon.com** and sign in.
2. Click **Create instance**.
3. **Region** — pick the one closest to *the labs*, not to your engineers.
   Engineers move around; benches don't, and the lab leg of the connection is
   the one you can't improve later.
4. **Platform**: Linux/Unix.
5. **Blueprint**: choose the **OS Only** tab → **Ubuntu 24.04 LTS**.
   (Not an app blueprint — you don't want their preinstalled stack.)
6. **SSH key pair**: the region default is fine. You won't need the file if you
   use the browser terminal in step 5.
7. **Instance plan**: the **2 GB RAM / 2 vCPU** plan. Do not pick 512 MB — Node
   plus the engine will thrash on it.
8. **Name**: something you'll recognize in a year, e.g. `baseline-remote`.
9. **Create instance**, then wait until the state reads **Running** (1–2 min).

---

## 2. Give it a permanent address — do this before anything else

This is the one mistake that is genuinely painful to undo. Lightsail's default
public IP **changes if the instance is ever stopped and started**. Every agent
you install points at the address you gave it, so if that changes after machines
are enrolled, they all silently stop reporting and each one needs revisiting.

1. Open the instance → **Networking** tab.
2. Under **Public IP**, click **Attach static IP** (or **Create static IP**).
3. Name it e.g. `baseline-remote-ip`, confirm it's attached to this instance.
4. **Write the IP down.** You need it in the next step.

Static IPs are free while attached to a running instance.

---

## 3. Open the firewall

Lightsail has its **own** firewall, separate from EC2 security groups. Ubuntu
OS-Only instances start with SSH (22) and HTTP (80) open, but not HTTPS.

1. Same **Networking** tab → **IPv4 Firewall**.
2. **Add rule** → Application: **HTTPS**, Protocol TCP, Port **443** → Create.
3. Confirm you now have three rules: 22, 80, 443.

Port 80 is not optional — it's how the Let's Encrypt certificate check reaches
the box. You can close it later if you want, but leave it for now.

> **Do not also enable `ufw` on the server.** Lightsail's firewall is your
> firewall; adding a second one is the classic way to lock yourself out of SSH.

---

## 4. Point a name at it

Pick a subdomain of the domain your portal already uses, e.g.
`remote.yourportal.com`.

1. Wherever your DNS lives (Vercel, Cloudflare, Route 53, your registrar), add
   an **A record**: name `remote`, value = the static IP from step 2, TTL 300.
2. Wait, then check it resolves. From your own machine:

   ```bash
   dig +short remote.yourportal.com
   ```

   You want it to print your static IP. If it prints nothing, wait a few minutes
   and try again — **do not continue until this works**, because the certificate
   step in section 7 will fail without it.

---

## 5. Get a terminal on the box

Easiest path, no key files: instance page → **Connect** tab → **Connect using
SSH**. A terminal opens in the browser, already logged in as `ubuntu`.

If you'd rather use your own terminal, download the region's default key from
Lightsail (**Account → SSH keys**) and:

```bash
chmod 400 ~/Downloads/LightsailDefaultKey-<region>.pem
ssh -i ~/Downloads/LightsailDefaultKey-<region>.pem ubuntu@<your-static-ip>
```

Everything from here on is typed into that terminal.

---

## 6. Install Node and the engine

```bash
# Patch the box first
sudo apt update && sudo apt upgrade -y

# Keep it patched by itself - one line, worth it on a box you won't log into often
sudo apt install -y unattended-upgrades

# Node 22 LTS (Ubuntu's own 'nodejs' package is too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node --version    # expect v22.x
```

Now the engine. **Pin the version** — the exact build matters, because the
session-token format has changed between releases and the portal has to match
whichever one you install:

```bash
sudo mkdir -p /opt/meshcentral
cd /opt/meshcentral
sudo npm install meshcentral@1.2.4

# Confirm what you actually got:
sudo npm ls meshcentral
```

**Sierra's host is pinned to `meshcentral@1.2.4`**, and the portal's session-token
code is written against that build. Two things in it are version-specific:

- the login-cookie key is **80 bytes** (`meshcentral.js` checks the decoded
  length and warns if it isn't)
- a login token is `{ u: "user//<name>", a: 3 }`, AES-256-GCM, base64 with `+`
  and `/` swapped for `@` and `$`

Both have moved between releases. If you install a different version, say so —
`src/lib/remote.ts` and `tests/remoteCookie.test.ts` are where it lands.

Install it as a service so it survives reboots:

```bash
sudo node node_modules/meshcentral --install
sudo systemctl status meshcentral --no-pager
```

It will be running but not yet configured. That's expected.

---

## 7. Configure it

Generate the shared secret the portal will use to mint session links.
**Exactly 80 bytes — 160 hex characters.** MeshCentral parses this into a buffer
and checks its length at startup; anything else earns
`WARNING: Invalid "LoginCookieEncryptionKey"` and it quietly falls back to a key
of its own, which the portal cannot sign with. The server looks perfectly
healthy in that state, so this is worth getting right the first time:

```bash
openssl rand -hex 80
```

Copy that output somewhere safe — you'll paste it into both the config below and
Vercel later. **This key outranks every other secret in the system**: whoever
holds it can mint admin sessions on this host.

### First, a warning about pasting into this terminal

The Lightsail browser console mangles pasted text in three ways, all of which
were hit on the first run through this document:

- it **escapes braces** — a pasted `{` arrives as `\{`, and a leading backslash
  is invisible in an editor while making the file unparseable at character zero
- it **doubles newlines**, harmless inside JSON but fatal to any shell command
  using a `\` line continuation
- markdown code fences tag along if you copy carelessly

So: **paste single-line commands only**, and do not hand-edit JSON in this
terminal. Write the file with a generator instead — the structure is then
produced by a program and nothing you paste can land in it.

```bash
sudo systemctl stop meshcentral
```

```bash
sudo mkdir -p /opt/meshcentral/meshcentral-data
```

Now the config. Edit the two domains and the email below, then paste the whole
thing as one block — it is a heredoc, so the shell reads down to the closing
`ENDCFG` and reinterprets nothing in between. It mints the key itself, at the
right length, and prints it:

```bash
sudo python3 - <<'ENDCFG'
import json, pathlib, secrets
key = secrets.token_hex(80)          # 80 bytes / 160 hex chars - what v1.2.4 wants
cfg = {
  "settings": {
    "cert": "remote.yourportal.com",
    "port": 443,
    "redirPort": 80,
    "WANonly": True,
    "loginCookieEncryptionKey": key,
    "plugins": {"enabled": False},
  },
  "domains": {"": {
    "title": "Baseline Support",
    "newAccounts": True,
    "sessionRecording": {
      "onlySelectedDeviceGroups": False,
      "filepath": "/opt/meshcentral/meshcentral-recordings",
      "index": True,
    },
  }},
  "letsencrypt": {
    "email": "you@yourcompany.com",
    "names": "remote.yourportal.com",
    "production": True,
  },
}
p = pathlib.Path("/opt/meshcentral/meshcentral-data/config.json")
p.write_text(json.dumps(cfg, indent=2) + "\n")
print("wrote " + str(p))
print("\nREMOTE_LOGIN_KEY (save this for Vercel):\n" + key)
ENDCFG
```

**Copy the printed key before you clear the terminal.** Nothing else in this
process will show it to you again.

For reference, this is what each setting is doing:

What each part is doing:

| Setting | Why |
| --- | --- |
| `WANonly` | Agents and browsers all arrive over the internet, not a LAN |
| `loginCookieEncryptionKey` | The shared secret the portal signs connect links with |
| `newAccounts: true` | Temporary — you need it to create the first account. Turned off in step 9 |
| `sessionRecording` | Server-side recording of every session. This is the compliance story, so it's on from day one |
| `letsencrypt` | Free TLS certificate, renewed automatically |
| `plugins: false` | Nothing third-party executing on this box |

### Validate before starting the service

The engine reads this file once at startup and, if it can't parse it, dies
without telling you which character offended it. Check it while you still have
the context to fix it:

```bash
sudo python3 -m json.tool < /opt/meshcentral/meshcentral-data/config.json > /dev/null && echo "config parses"
```

If that prints anything other than `config parses`, see the first two
troubleshooting rows at the end of this document before going further.

Then start it and watch:

```bash
sudo systemctl start meshcentral
sudo journalctl -u meshcentral -f
```

**`Ctrl+C` stops watching** (it doesn't stop the server).

Three lines say it worked:

```
MeshCentral v1.2.4
Generating certificates, may take a few minutes...
Server has no users, next new account will be site administrator.
```

plus something about updating certificates from Let's Encrypt. One line says it
didn't, even though everything above it looks fine:

```
WARNING: Invalid "LoginCookieEncryptionKey" in config.json.
```

That means the key isn't the length this build wants, so the engine substituted
one of its own and the portal's Connect links will be rejected by a server that
otherwise looks perfectly healthy. Fix it with the row in Troubleshooting; don't
carry on past it.

If the certificate fails, it's almost always one of two things: DNS isn't
resolving yet (redo the `dig` check in step 4) or port 80 is closed (redo
step 3).

---

## 8. Create your accounts

1. Browse to **https://remote.yourportal.com**. You should get a padlock, no
   warning. If you get a certificate warning, ACME didn't finish — check
   `sudo journalctl -u meshcentral -n 100 --no-pager`.
2. Create an account. **The first account becomes the site administrator** — use
   your own email.
3. Turn on two-factor for it immediately: **My Account → Security → Add
   authenticator app**. This account is the break-glass way in.
4. Create a second account named `portal-admin`. This is the identity the portal
   acts as; nobody logs in with it interactively. Give it a long random password
   you don't need to remember.
5. Make `portal-admin` a site administrator too (**My Account → ... → Users →
   portal-admin → Site rights**).

   Not because it can't otherwise work — an ordinary account *can* create device
   groups, and one created by `portal-admin` is still visible to you, since a
   site administrator sees every group. The reason is a trap in the engine: the
   moment a mail server is configured on this host, creating a device group
   starts requiring a **verified** email address from anyone who isn't a site
   administrator. `portal-admin` has no mailbox to verify, so adding SMTP later
   would break enrollment with an error that has nothing to do with what you
   changed. Site rights make it immune to that check.

---

## 9. Close the door behind you

One line, so nothing has to be pasted into an editor:

```bash
sudo python3 -c "import json,pathlib;p=pathlib.Path('/opt/meshcentral/meshcentral-data/config.json');c=json.loads(p.read_text());c['domains']['']['newAccounts']=False;p.write_text(json.dumps(c,indent=2)+chr(10));print('self-registration off')"
```

```bash
sudo systemctl restart meshcentral
```

Now nobody can self-register. Every future identity is created by you or comes
from the portal.

---

## 10. Turn on backups

The `meshcentral-data` directory holds the agent certificates. Lose them and
**every enrolled machine needs re-enrolling by hand**, which is the one failure
here that costs real time.

1. Instance page → **Snapshots** tab.
2. Enable **Automatic snapshots**, pick a time in your quiet hours.
3. Take one manual snapshot now, so you have a known-good starting point.

Snapshots cost a few cents per GB per month. This is the cheapest insurance in
the whole project.

---

## 11. Tell the portal about it

In **Vercel → your project → Settings → Environment Variables**, add three:

| Variable | Value |
| --- | --- |
| `REMOTE_URL` | `https://remote.yourportal.com` |
| `REMOTE_LOGIN_KEY` | The 160-character key printed in step 7 |
| `REMOTE_ADMIN_USER` | `portal-admin` |

The portal checks that key's length before it uses it, so a truncated paste says
so plainly instead of producing links the host silently refuses.

Redeploy. Then in the portal: **Settings → Configuration → Modules → Remote
support** on.

`/remote` now appears in the staff menu, and Connect will open a real session.

---

## 12. What's left, and who does it

**Done:** the session-token format, written against 1.2.4's own
`encodeCookie`/`decodeCookieAESGCM` and covered by `tests/remoteCookie.test.ts`,
including a check that the engine's own decoder accepts what we mint. The three
admin calls the module needs — list a group's devices, create a group, generate
an installer link — speak the engine's WebSocket protocol, and the consent
setting is pushed to the machine before a session opens rather than being carried
in the URL, because the engine holds it per device.

**Verified against the live host** (`remote.sierraspectra.com`, 1.2.4): the
certificate validates, a token minted by the portal's own code is accepted on the
admin channel as `portal-admin`, and the read-only calls answer — an empty device
list and an empty group list, which is correct for a host with nothing enrolled
yet. That was the fragile joint in this whole design, and it holds.

The three calls that *write* — create a group, generate an installer link, set a
machine's consent flag — are exercised the first time somebody presses **Enroll**
on `/remote`. If that button reports an error, the message comes straight from the
engine and the Troubleshooting table below covers what it means.

**Then — the gate.** None of this is trusted until all seven pass, and every one
of them needs a real Windows PC, so this part can't be done from a keyboard
anywhere else:

1. Enroll a real Windows PC from the installer link on `/remote`.
2. Reboot it. It comes back on its own — that's what "unattended" means.
3. Connect from a browser and control the desktop.
4. A session recording file exists on the host.
5. The audit trail names you.
6. Hand the linked system off in the portal → the machine flips to "asks first".
7. Stop the Lightsail instance → `/remote` still lists machines from cache and
   refuses politely instead of erroring.

Only after 7 does anything get pointed at a customer's machine, and even then
TeamViewer stays installed alongside for a couple of months. When remote access
fails an engineer can't do their job, so ours earns its place one machine at a
time.

---

## 13. Making it yours

> **The agent branding below is not optional polish — do it before the gate in
> section 12.** Nothing in the portal can set it: the name, the picture and the
> Windows service name are baked into the binary by *this host* as it serves the
> download, from `config.json` and nowhere else. Skip it and everything still
> works, which is the problem — the first sign is a client's IT being handed a
> file called `meshagent64-Acme.exe` by a company that is not called MeshAgent.
>
> The enrollment page checks this now and says so in orange if the host is still
> serving the engine's name, so you find out at your own desk rather than at
> theirs. To check from here:
>
> ```bash
> curl -sI "https://remote.<your-domain>/meshagents?id=4" | grep -i content-disposition
> ```
>
> `filename="meshagent64.exe"` means it was never set. Your own name there means
> it took. A real per-group download is named `<fileName>64-<GroupName>.exe`.

Three surfaces carry someone else's branding out of the box, and they are worth
very different amounts of effort.

**The installer dialog and the tray app matter most.** A client's staff sees
those, at the moment they are deciding whether this software is legitimate. A
window headed "MeshCentral Agent" showing a stock globe is the single most
expensive piece of borrowed branding in the whole system.

**The web console matters least.** Engineers reach a machine from the portal,
which deep-links straight to its desktop tab — nobody navigates the console but
you. Style it enough that a stray visit isn't jarring, then stop.

### Branding the installer and the tray app

Put the artwork in `meshcentral-data` first — PNG for the agent, JPEG for the
assistant, which is what each one is served as:

```bash
sudo curl -fsSL -o /opt/meshcentral/meshcentral-data/agent-logo.png "<url of a ~200x200 PNG>"
```

Then the settings, as a generator rather than an edit, for the paste reasons in
section 7. Change the strings and run it as one block:

```bash
sudo python3 - <<'ENDBRAND'
import json, pathlib
p = pathlib.Path("/opt/meshcentral/meshcentral-data/config.json")
c = json.loads(p.read_text())
d = c["domains"][""]
d["agentCustomization"] = {
  "displayName": "Sierra Spectra Support",
  "description": "Remote support for instrument systems serviced by Sierra Spectra.",
  "companyName": "Sierra Spectra LLC",
  "serviceName": "SierraSpectraSupport",       # Windows service name: no spaces or quotes
  "installText": "Installing this lets a Sierra Spectra engineer work on this instrument PC.",
  "image": "agent-logo.png",                   # PNG in meshcentral-data
  "fileName": "SierraSpectraSupport",          # the downloaded .exe is named this
}
d["assistantCustomization"] = {
  "title": "Sierra Spectra Support",
  "image": "assistant-logo.jpg",               # JPEG in meshcentral-data
  "fileName": "SierraSpectraAssistant",
}
p.write_text(json.dumps(c, indent=2) + chr(10))
print("branding written")
ENDBRAND
```

Every key above is real and lands where you expect: MeshCentral lowercases config
keys as it loads them (`common.objKeysToLower`), so the camelCase here matches
the `agentcustomization.displayname` / `.filename` the server actually reads.
`serviceName` must have no spaces — it becomes the Windows service name.

Restart, then **download a fresh installer** — these settings are baked into the
executable when it is served, so machines already carrying an agent keep the old
name and picture until they are reinstalled. `serviceName` in particular is only
read at install time.

Confirm it took with the `curl -sI` line at the top of this section, or just open
the enrollment page for any client: it asks the host what it would serve and
shows the answer under the download buttons.

**The tray icon is a separate program: MeshCentral Assistant.** The agent is a
background service with no interface by design; the Assistant is the user-facing
half — it sits in the notification area, shows when somebody is connected, and
gives whoever is at the machine a way to ask for help. Install it alongside the
agent on any PC where a human should be able to see us coming. It downloads from
the device group's **Add Agent** panel, or from `/?meshaction=winassistant` while
signed in. Note it ships as an x64 binary only: native on lab PCs, emulated on an
ARM laptop.

### Keeping the session inside the portal

`/remote/<device>` renders the desktop in a frame on one of our own pages, with
the engine's banner, tab strip, footer and panel headings switched off — so
pressing Connect stays inside the product instead of landing on the support
host's console. The session still runs browser-to-relay; only the surround
changes.

Two host settings make it work, and the frame will show a sign-in box until both
are set:

```bash
sudo python3 - <<'ENDFRAME'
import json, pathlib
p = pathlib.Path("/opt/meshcentral/meshcentral-data/config.json")
c = json.loads(p.read_text())
s = c["settings"]
s["allowedFramingOrigins"] = ["https://app.ridgelinefield.com"]      # the portal, and nothing else
s["sessionSameSite"] = "none"                                        # or the session cookie won't be sent
p.write_text(json.dumps(c, indent=2) + chr(10))
print("framing allowed for", s["allowedFramingOrigins"])
ENDFRAME
```

This value is the portal's CURRENT origin, exactly. **Moving the portal to a
new domain breaks remote support until this is edited on the relay host and
MeshCentral is restarted** - the console will refuse to embed and sessions come
up blank, with nothing in the portal's own logs to say why. Change it in the
same sitting as the DNS cutover, not afterwards.

`allowedFramingOrigins` names the portal specifically, which emits a
`frame-ancestors` policy listing it and drops the `X-Frame-Options` header.
Prefer it to `allowFraming: true`, which lets **any** site frame the console and
is the version of this setting people regret.

`sessionSameSite: "none"` is the real trade-off. Inside our frame the engine's
session cookie is third-party, and the browser won't send a `Lax` cookie there —
but loosening it removes a browser-level cross-site protection from the console
itself. Acceptable here because the console has two human users and the portal is
the surface that matters; worth revisiting if that changes. It is also the part
most exposed to browser policy: strict tracking protection or a future
third-party-cookie change can break the frame, at which point the **open in a new
window** link on the session page is the fallback, and the durable fix is to stop
depending on the engine's page at all (below).

**The version without an iframe — built, then removed.** Commit `d8f2629` put the
desktop on our own canvas by vendoring the engine's decoder and relay transport.
It was taken back out one commit later: the framed path was working and a demo
should not rest on the newer of two paths. Reviving it is `git show d8f2629`
rather than research, and the findings that cost the time are worth keeping:

- **The relay credential is ours to mint.** The engine builds it as
  `encodeCookie({ userid, domainid, ip }, loginCookieEncryptionKey)` — the same
  key the portal already holds. So a viewer needs no admin round trip and no
  session cookie of the engine's, which also means `sessionSameSite` could go back
  to `lax` if the frame ever stops being used.
- **Omit `ip`.** The engine binds a cookie to an address only when that field is
  present, and the only address the portal could stamp belongs to a serverless
  function rather than to the engineer's browser.
- **One patch is needed in their transport**: `obj.Start` derives the relay socket
  address from `window.location`, which is wrong when the page is ours.
- **The unverified joint** was whether the agent joins the relay without the
  second `rauth` cookie that the console passes and the code treats as optional.
  That is the first thing to check if a revived viewer sits at "waiting for the
  machine to answer".

### The executable itself, and the SmartScreen warning

`agentCustomization` above changes the dialog's words and picture. What Windows
itself shows — the file's icon, its properties, and the publisher line in the
"unrecognized app" warning — comes from the binary's own resources, set by
`agentFileInfo` in the same `domains[""]` object: `icon` (an `.ico` in
`meshcentral-data`), `logo` (the dialog bitmap), `fileVersion`,
`fileVersionNumber`, `productVersionNumber`.

**Code signing is a real fix and a real snag.** The engine will sign every agent
it serves if it finds `meshcentral-data/agentsigningcert.pem` (certificate and
private key in one PEM), and it timestamps through Comodo's authenticode
timestamp server by default. Wire that up and the warning changes from
"unrecognized publisher" to your name.

The snag is where the key lives. Since June 2023 the CA/Browser Forum requires
publicly-trusted code-signing keys to sit on FIPS-certified hardware — a USB
token or a cloud HSM — so a modern OV or EV certificate does **not** come as a
PEM file you can copy onto a server. That rules out the drop-in path with a
current certificate. What is left:

| Route | What it costs | What it gets you |
| --- | --- | --- |
| Do nothing | free | Two-click bypass, every install, forever |
| Self-signed (the engine will generate one) | free | Binary is "signed" but by nobody trusted; SmartScreen still warns |
| Cloud-HSM signing (Azure Trusted Signing ~$120/yr, DigiCert KeyLocker, SSL.com eSigner) | ~$120–500/yr plus a build step | Genuinely signed; needs signing to happen **outside** the engine, on a binary the engine then serves without modifying — which conflicts with per-group personalisation, so it wants thinking through before buying anything |
| EV certificate on a token | ~$400–700/yr, manual | Immediate SmartScreen reputation, but somebody has to plug in a token to sign, so not automatic |

Worth knowing regardless: even a correctly signed binary from a new publisher can
warn until it accrues reputation, unless the certificate is EV. So signing is not
a switch that makes the warning vanish the day it is bought — which is a good
reason to leave this until client IT actually asks.

### That download page

**Done — the portal hosts it now.** `/remote/enroll/<org>` carries the
instructions in our words, with download buttons for the Windows builds that
actually exist in a lab, and hands the file straight from the host. The engine's
`agentinvite` view no longer appears in the normal path, so there is nothing to
restyle.

The one thing it is still used for is a client who has to run the installer
themselves and has no account here: the **Build a 24-hour link** button on that
page produces one. If that becomes a common route rather than an exception, the
next step is a public, token-addressed version of our own page, at which point
the engine's view is gone entirely.

For reference, if you ever do want to restyle theirs: copy
`views/agentinvite.handlebars` out of `node_modules/meshcentral` into
`/opt/meshcentral/meshcentral-web/views/` and edit it — per-file override, same
as the stylesheets, same cost of no longer receiving upstream fixes.

### Branding the console

Config-level, in the same `domains[""]` object — `title`, `title2`,
`titlePicture` (a file in `meshcentral-data`, replaces the text heading),
`loginPicture`, `welcomeText`, `footer` (HTML), `siteStyle` (3 is the newer
look), `nightMode`.

Below that, the engine looks for `/opt/meshcentral/meshcentral-web/public/…` and
`…/views/…` before its own copies, **per file** — so dropping in just
`public/styles/style.css` overrides the stylesheet and everything else still
comes from the package. Override as few files as you can live with: each one you
copy is a file that stops receiving upstream fixes, silently, until you diff it
after an upgrade. Stylesheets and images are usually worth it; the handlebars
views rarely are.

---

## Notices on a machine's screen

The repossession notices and safety holds posted from `/remote` are delivered by
the portal calling the engine - there is no inbound route and nothing to open.
Two things on the host decide whether they arrive, and neither announces itself
when it is wrong.

**`REMOTE_ADMIN_USER` needs Remote Control and Agent Console on the device
group.** Notices ride on `runcommands` type 4, which the server refuses without
rights `8 | 16`, and the agent re-checks the same two before it will act. A site
administrator does not automatically hold them on every group. Without them
every push comes back `Access denied` - which the machine list now says out
loud, under the notice: *Not delivered to the machine - Access denied.*

**A toast is what a person actually sees; the tray entry needs MeshCentral
Assistant.** Every push sends both. The standing `agentmsg` entry is the record,
but it renders through the agent's local IPC socket, which only has a listener
when the **MeshCentral Assistant** desktop app is installed alongside the agent
- the background service alone displays nothing at all. The toast needs no
companion app, so on a plain service-only install the toast is the whole of what
the user sees, and it fires only when the notice CHANGES rather than at every
hourly re-assertion.

If you want a notice that persists on screen rather than one that appears once,
install MeshCentral Assistant on the lab PCs. If you do not, expect the toast
and the portal's own record and nothing on the machine between them.

### Theft lockout

`/remote` can also lock a machine out of itself after it is reported stolen
(owner only, and it will not save without a report or claim reference). It rides
the same `runcommands` type 4 door as notices, so it needs no rights beyond the
`8 | 16` above, and it is enforced again on every hourly pass rather than once -
repetition is the only thing that gives it force.

What it sends is a message naming the reference and a contact number, then
`power 1` (LOGOFF), and `power 2` (SHUTDOWN) at the strongest setting. It
deliberately does **not** send the agent console's `lock`: that runs
`LockWorkStation`, which anybody holding the Windows password undoes at once, so
against a thief it is theatre.

Be clear with yourself about the ceiling. This ends the desktop session whenever
the machine is online and reachable, which stops somebody who does not have the
Windows password from using it. It does nothing to a machine kept offline, and
it does not survive the agent being uninstalled, the disk being reimaged or the
drive being moved to another chassis. It is a deterrent and a route home - the
number on the screen is the part most likely to actually recover an instrument.
Real protection against a determined thief is BitLocker, physical security and
insurance; this is not a substitute for any of them.

> Checking it worked: post a notice, then look at the machine's row on
> `/remote`. It says either *On the machine since \<time\>* or exactly what the
> engine refused with. `api/cron/notices` re-asserts hourly, so a machine that
> was asleep picks it up on the next run rather than never.

## Troubleshooting

These are the failures actually hit standing this up the first time, in the order
they happened.

| Symptom | Cause and fix |
| --- | --- |
| `ERROR: Unable to parse /opt/.../config.json` | The Lightsail console escaped a pasted `{` into `\{`, which is invisible in an editor. Confirm with `sudo head -c 40 /opt/meshcentral/meshcentral-data/config.json \| cat -A` — a leading `\{` shows as `\\{`. Fix with `sudo sed -i '1s/^\\\\//' /opt/meshcentral/meshcentral-data/config.json`, or just re-run the generator in step 7, which is why it's a generator |
| `WARNING: Invalid "LoginCookieEncryptionKey"` | The key isn't 160 hex characters, so the engine substituted its own and **the server keeps running and looks fine** while refusing every link the portal mints. Check the length: `sudo python3 -c "import json;print(len(json.load(open('/opt/meshcentral/meshcentral-data/config.json'))['settings']['loginCookieEncryptionKey']))"`. Replace it with `openssl rand -hex 80`, restart, and put the new value in Vercel — the two must match |
| `-bash: syntax error near unexpected token '&&'` | The browser console doubles newlines, which breaks any command using a `\` line continuation. Paste single-line commands only |
| Warnings still in the log after fixing them | `journalctl -n 40` shows the last 40 lines, not the last start. Use `sudo journalctl -u meshcentral --since "-1 min" --no-pager` after restarting |
| Certificate warning in the browser | ACME didn't complete. `sudo journalctl -u meshcentral -n 100 --no-pager`. Usually DNS or port 80 |
| `dig` returns nothing | DNS hasn't propagated, or the record name is wrong (`remote`, not `remote.yourportal.com`, in most DNS UIs) |
| Service won't start | `sudo journalctl -u meshcentral -n 50 --no-pager` — nearly always a JSON syntax error in `config.json`. Check with `python3 -m json.tool < /opt/meshcentral/meshcentral-data/config.json` |
| Site unreachable, service running | Port 443 missing from the Lightsail firewall (step 3) |
| Locked out of SSH | You enabled `ufw`. Use the Lightsail browser terminal to `sudo ufw disable` |
| Agent won't connect from a lab | The lab's firewall blocks outbound 443 to an unfamiliar host. Ask their IT to allow `remote.yourportal.com` |
| Windows says the installer is unrecognized | Expected until the agent is code-signed. Two-click bypass is safe — you're the one running it. A signing certificate (~$250–450/yr) is the later fix |

## Upgrading the engine later

Never a bare `npm update`. Snapshot first, upgrade, then re-run the seven-step
gate — a version change can move the session-token format, which is the one
thing that would break the portal's Connect button silently.

```bash
# Snapshot from the Lightsail console FIRST
sudo systemctl stop meshcentral
cd /opt/meshcentral && sudo npm install meshcentral@<new-version>
sudo systemctl start meshcentral
sudo npm ls meshcentral   # send me the new version
```
