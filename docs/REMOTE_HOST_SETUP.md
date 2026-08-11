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
8. **Name**: something you'll recognise in a year, e.g. `baseline-remote`.
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
sudo npm install meshcentral

# Record what you actually got, and tell me this number:
sudo npm ls meshcentral
```

That prints something like `meshcentral@1.1.xx`. **Send me that version string** —
it's what I need to finish the token minting in `src/lib/remote.ts`.

Install it as a service so it survives reboots:

```bash
sudo node node_modules/meshcentral --install
sudo systemctl status meshcentral --no-pager
```

It will be running but not yet configured. That's expected.

---

## 7. Configure it

Generate the shared secret the portal will use to mint session links:

```bash
openssl rand -hex 48
```

Copy that output somewhere safe — you'll paste it into both the config below and
Vercel later. **This key outranks every other secret in the system**: whoever
holds it can mint admin sessions on this host.

Now edit the config:

```bash
sudo systemctl stop meshcentral
sudo nano /opt/meshcentral/meshcentral-data/config.json
```

Replace the contents with this, substituting your domain, your email, and the
key you just generated:

```json
{
  "settings": {
    "cert": "remote.yourportal.com",
    "port": 443,
    "redirPort": 80,
    "WANonly": true,
    "loginCookieEncryptionKey": "PASTE_THE_OPENSSL_OUTPUT_HERE",
    "plugins": { "enabled": false }
  },
  "domains": {
    "": {
      "title": "Baseline Support",
      "newAccounts": true,
      "sessionRecording": {
        "onlySelectedDeviceGroups": false,
        "filepath": "/opt/meshcentral/meshcentral-recordings",
        "index": true
      }
    }
  },
  "letsencrypt": {
    "email": "you@yourcompany.com",
    "names": "remote.yourportal.com",
    "production": true
  }
}
```

What each part is doing:

| Setting | Why |
| --- | --- |
| `WANonly` | Agents and browsers all arrive over the internet, not a LAN |
| `loginCookieEncryptionKey` | The shared secret the portal signs connect links with |
| `newAccounts: true` | Temporary — you need it to create the first account. Turned off in step 9 |
| `sessionRecording` | Server-side recording of every session. This is the compliance story, so it's on from day one |
| `letsencrypt` | Free TLS certificate, renewed automatically |
| `plugins: false` | Nothing third-party executing on this box |

Save (`Ctrl+O`, Enter, `Ctrl+X`), then start it:

```bash
sudo systemctl start meshcentral
sudo journalctl -u meshcentral -f
```

Watch the log. You're looking for the certificate being obtained and a line
saying the server is running. **`Ctrl+C` stops watching** (it doesn't stop the
server).

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
   portal-admin → Site rights**), because it needs to create device groups.

---

## 9. Close the door behind you

```bash
sudo nano /opt/meshcentral/meshcentral-data/config.json
```

Change `"newAccounts": true` to `"newAccounts": false`, then:

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
| `REMOTE_LOGIN_KEY` | The `openssl rand -hex 48` output from step 7 |
| `REMOTE_ADMIN_USER` | `portal-admin` |

Redeploy. Then in the portal: **Settings → Configuration → Modules → Remote
support** on.

`/remote` will now appear in the staff menu. It will still say the session token
isn't wired up — that's mine to finish, and it's why I need the version string
from step 6.

---

## 12. What's left, and who does it

**Me, once you send the version string:** implement the session-token format
against that exact build, with a round-trip test. It's deliberately unimplemented
rather than guessed at — a plausible-looking implementation of somebody else's
crypto format typechecks, ships, and fails at the only moment that matters.

**Then, together — the gate.** None of this is trusted until all seven pass:

1. Enrol a real Windows PC from the installer link on `/remote`.
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

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Certificate warning in the browser | ACME didn't complete. `sudo journalctl -u meshcentral -n 100 --no-pager`. Usually DNS or port 80 |
| `dig` returns nothing | DNS hasn't propagated, or the record name is wrong (`remote`, not `remote.yourportal.com`, in most DNS UIs) |
| Service won't start | `sudo journalctl -u meshcentral -n 50 --no-pager` — nearly always a JSON syntax error in `config.json`. Check with `python3 -m json.tool < /opt/meshcentral/meshcentral-data/config.json` |
| Site unreachable, service running | Port 443 missing from the Lightsail firewall (step 3) |
| Locked out of SSH | You enabled `ufw`. Use the Lightsail browser terminal to `sudo ufw disable` |
| Agent won't connect from a lab | The lab's firewall blocks outbound 443 to an unfamiliar host. Ask their IT to allow `remote.yourportal.com` |
| Windows says the installer is unrecognised | Expected until the agent is code-signed. Two-click bypass is safe — you're the one running it. A signing certificate (~$250–450/yr) is the later fix |

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
