# Put Connectly online: GitHub + Render

## What you need
- A free **GitHub** account (to keep the code) and a **Render** account (to run the site).
- **Money:** the site stores accounts, photos and videos, so it needs a Render **paid** web service with a **persistent disk**. At the time of writing that is about **$7/month** for the service plus **$0.25 per GB per month** for the disk (5 GB is about $1.25). Free Render services lose their files at every restart and fall asleep after 15 minutes, which would delete all accounts. Check Render's pricing page for current prices.
- An **email sender** (any SMTP service) and a **text-message sender** (Twilio). Every account needs a verified email and a verified phone, so sign-up stays closed until both are set up (see step 3).

## 1. Push the code to GitHub
1. On github.com click **New repository**. Name it `connectly`, choose **Private**, and do NOT add a README. Click **Create repository**.
2. Unzip `connectly.zip`, open a terminal inside the `connectly` folder, and run (replace YOUR-USERNAME):
```
git init
git add .
git commit -m "Connectly first version"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/connectly.git
git push -u origin main
```
3. GitHub does not accept your account password for this. When asked to log in, use a **personal access token** (GitHub > Settings > Developer settings > Personal access tokens), or install **GitHub Desktop**, or run `gh auth login` if you use the GitHub CLI.

Nothing secret is uploaded: `.gitignore` already keeps `node_modules`, `data` (the database and uploads) and `.env` out of GitHub.

## 2. Deploy on Render
1. Go to render.com and sign up with your GitHub account.
2. Click **New +** > **Blueprint**, choose your `connectly` repository, and click **Connect**. Render reads `render.yaml` from the project.
3. Render shows the settings and asks for the values marked "sync: false" (email, text message, Google, TURN). You can leave them empty for now and fill them in later under **Environment**.
4. Click **Apply**. The first build takes a few minutes. When it says **Live**, open the address at the top (like `https://connectly-xxxx.onrender.com`).

If you prefer to set it up by hand instead of the Blueprint: **New +** > **Web Service** > your repo, then use
Runtime `Node`, Build command `npm ci`, Start command `npm start`, Health check path `/healthz`, instance type **Starter**, and add a **Disk** with mount path `/var/data`.
Add these environment variables: `NODE_VERSION=22`, `NODE_ENV=production`, `DATA_DIR=/var/data`, `TRUST_PROXY=1`, `JWT_SECRET` (a long random text) and the ones below.

## 3. Email and text-message codes (required for sign-up)
In Render > your service > **Environment**, add:

| Purpose | Variables |
|---|---|
| Email codes | `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| Text codes | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (your Twilio number, or a Messaging Service SID) |

- **Email:** any SMTP service works (Brevo, Mailgun, SendGrid, or a Gmail "app password"). Use an address on your own domain for `SMTP_FROM` so messages do not land in spam.
- **Text messages:** Twilio trial accounts can only text numbers you have verified in Twilio, so upgrade the account before inviting real people. **For Indian phone numbers, Indian telecom rules (DLT registration of the sender and message template) apply to business texts. Check Twilio's India guidelines before launch, or ask me to add an Indian SMS provider.**
- Saving environment variables restarts the site. After that, sign-up works. Until both are set, the sign-up page says it is not available.

**Testing privately before you have these accounts:** delete the `NODE_ENV` variable. The site then prints each code in Render's **Logs** tab instead of sending it, so you can sign up yourself. Never leave it like that for real users, and set `NODE_ENV=production` again.

## 4. Optional extras
- **Google sign-in:** create the OAuth client as described in README.md, add your Render address (for example `https://connectly-xxxx.onrender.com`) under "Authorized JavaScript origins", and set `GOOGLE_CLIENT_ID`.
- **Video calls between different networks:** calls try to connect directly. On phones and strict networks that often fails without a **TURN server**. Get TURN details from a TURN provider (Twilio Network Traversal, Metered, or your own coturn) and set `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
- **Your own address:** Render > your service > **Settings** > **Custom Domains**. Render adds the https certificate for you.

## 5. After it is live
- **Updating:** change the code, then `git add . && git commit -m "message" && git push`. Render redeploys by itself. Because the site uses a disk, each deploy has a few seconds of downtime.
- **Backups:** Render snapshots the disk once a day. Also use Render's **Shell** tab now and then to download a copy of `/var/data` (database and uploads).
- **Growing:** the disk can be made bigger in the dashboard but not smaller. This setup runs as one instance (a disk allows only one), which is fine for a young site.
- **Never run** `npm run seed:demo` on the live site. It adds fake demo members.

## If something goes wrong
- **"Sign-up is not available right now":** the email or text-message variables are missing or wrong. Check Render's **Logs** for lines starting with "WARNING".
- **Build fails:** open the build log and send me the last 20 lines.
- **Site is slow to open after a while:** you are on a Free instance. Move it to Starter.
- **Accounts vanished after a restart:** the disk is not attached or `DATA_DIR` does not match the disk's mount path.
