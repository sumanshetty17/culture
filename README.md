# Connectly

A website where people create accounts, find each other by name, view profiles, chat in real time, and make voice and video calls.

**Putting it online:** see DEPLOY.md (GitHub + Render, step by step).

**Verification codes are OFF for now.** By default (`REQUIRE_CODES` not set) people sign up with name, username, email, phone and a password, and log in with username, phone or email plus the password; no email or text message is sent. One phone number, one email and one username per account is still enforced, with the red messages. To switch the code system (codes by email AND text at sign-up, login by code, forgot password) back on, set `REQUIRE_CODES=true` and set up email and text messages as described below. No code change is needed.

## Features (version 1)
- Profile picture, photos and videos: every member can add a profile picture (also offered during setup), up to 12 photos and up to 4 videos. Another member's profile has tabs: Profile (name, age, bio, I am, interested in, district, interests), Photos, Videos and a Chat tab. Photos open in a full-screen viewer; videos play on the page
- Chat has "Voice call" and "Video call" buttons at the top
- Sign-up takes name, username, email and phone number. A 6-digit code is sent to the email AND another to the phone. Only when BOTH are entered correctly is the account created; then the remaining details (birthday, district, gender, who you want to meet, bio) are asked. Nothing is reserved before that, so nobody can block someone else's number
- One phone number, one account. If a phone number or email already has an account, sign-up says so in red ("This phone number already has an account.") with a "Log in instead" link. Usernames are unique too, whatever the capital letters: "This username is already taken, so try another one." (the check runs while typing)
- Log in without a password: type your username, phone number or email, get a 6-digit code (by text message for a username or phone, by email for an email), enter it. Members who set a password can still use "I have a password"; "Forgot password?" sends a code too
- Settings > Account & security: change the phone number or email (a code is sent to the NEW one and it only changes after the code is entered), create or change a password, log out of all other devices, delete the account. The phone number can be changed but not removed, because it is a way to log in
- "Continue with Google" button on the login/sign-up page (appears once you set GOOGLE_CLIENT_ID, see below)
- Home page that is never blank: after login you see people of the group you chose (men, women or others) from your district: who is online now, suggested for you, and new members, each with a Message button
- Security: codes expire after 10 minutes, work once, lock after 5 wrong tries, and are limited per number/address (6 per hour) so nobody can flood a phone with texts. An older login must confirm with a code (or the password) before changing the phone, email or password, or deleting the account
- First-time setup after sign-up: date of birth (18+), district, gender (man / woman / other), who you want to meet (men / women / others), bio and interests
- Discover and the home page show only the group you chose, from your own district. Men see men, women see women, others see others, nobody else. "Show me" and "in" buttons switch the group, or widen from your district to your whole state
- Suggestions are ranked by who is online, shared interests, similar age and new members
- Profile pages (name, age, gender, district, interests, bio, online/last seen) and editing your own profile
- Real-time one-to-one text chat with history, unread counts, typing indicator, read receipts
- Voice calls and video calls (WebRTC, peer-to-peer) with ring/accept/decline, mute, camera toggle, busy and offline handling
- Responsive layout (desktop and phone), light/dark mode

## Run it
Requires Node.js 18+.

    npm install
    npm start
    # open http://localhost:3000

Open it in two different browsers (or one normal + one private window), create two accounts, and try chat and calls.

## Photos and videos
- Limits: photos up to 10 MB each (JPEG, PNG, WebP or GIF), videos up to 50 MB each (MP4, MOV or WebM). MP4 plays in every browser; some iPhone MOV files (HEVC) only play in Safari, so MP4 is the safe choice.
- Safety: every picture is decoded and re-saved as a clean WebP, so a renamed file or a hidden payload is rejected and the secret location data (GPS) inside phone photos is removed. Videos are checked by their file signature. Files get random names, and only logged-in members with a confirmed email can see them (they are not public web addresses).
- Files are stored in the `data/uploads` folder next to the database, so back up the whole `data/` folder. Deleting a photo or an account deletes the files too.
- Videos are stored as uploaded (no conversion). If your site gets big, move uploads to cloud storage and add video compression.

## Places (district and state)
People pick their place from a fixed list of 749 Indian districts in 35 states and union territories, by typing a few letters and clicking the exact "District, State". Old and city names work too ("Bangalore", "Mysore", "Vizag", "Bombay", "Gurgaon"...). Nothing can be misspelled, because free text is never accepted.
- The list is in `src/places.json`. It follows district changes up to about 2024, but India keeps creating districts, so edit that file when you need to add or rename one (keep the `id` of an existing district unchanged, since members' places are stored by id).
- It is India only for now. To serve another country, add its regions to the same file.

Members who signed up before this update are asked to complete setup again the next time they log in (their gender and birthday are kept; they choose a district and men / women / others).

## Sign-up needs email AND text messages
Because every account needs a verified email and a verified phone, sign-up only works when the server can send both. Set the SMTP variables (email) and TWILIO variables (text messages) from `.env.example`, and `NODE_ENV=production`. If either is missing on a live server, the sign-up page says it is not available instead of failing. On your own computer you need none of this: the codes are printed in the terminal window, so you can test everything.
Phone numbers need the country code (+91 98765 43210). A plain 10-digit Indian mobile number is accepted and gets +91 added.
Accounts that already existed without a phone number (older accounts, and Google sign-ins) are asked to add and verify a phone the next time they use the site.

## Turn on account recovery codes (email and text message)
Codes are sent by **email** through any SMTP service and by **text message** through Twilio. Both need an account of your own, so set the variables from `.env.example` before going live:
- Email: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
- Text messages: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (Twilio charges a small fee per text)
- On your live server also set `NODE_ENV=production`.

While testing on your own computer you need none of this: with no SMTP/Twilio settings and no NODE_ENV=production, the "email" or "text message" is printed in the server console window, so you can copy the code from there. In production, a channel you have not configured is simply unavailable (the phone prompt in the app is hidden when texts are not set up).

How it is protected: codes are 6 digits, valid for 10 minutes, usable once, locked after 5 wrong tries, limited to one per minute, and stored only as a hash. The "forgot password" screen gives the same answer whether or not an account exists. A password reset or change signs the account out of every other device. A phone number only counts as a recovery method after the user proves they own it with a code. Adding a phone, changing email, changing password and deleting the account all ask for the current password (accounts created with Google have none yet, so they can create one in Settings).

Email confirmation and phone setup together mean recovery codes reach the right person: a mistyped email is caught at sign-up, and the phone is a second way back in.

Good to know:
- Accounts created before this update are asked to confirm their email the next time they log in.
- Accounts created with Google skip the email code (Google already verified the address).
- Resetting a password with an emailed code also confirms that email.
- If your server cannot send email at all (no SMTP settings in production), the confirmation step is switched off so nobody gets locked out, and a warning is printed when the server starts. Set up SMTP before launch.
- Adding a phone or changing the email only asks for the password when the login is older than 15 minutes, so sign-up stays smooth.

## Turn on "Continue with Google"
The button only appears when the server knows your Google client ID. It is free to create:
1. In the Google Cloud Console, create a project, then go to APIs & Services > Credentials > Create credentials > OAuth client ID (you may be asked to set up the consent screen first).
2. Choose "Web application". Under "Authorized JavaScript origins" add `http://localhost:3000` for testing and your real site address (https://yourdomain.com) when you publish. No redirect URI is needed.
3. Copy the client ID and start the server with it:

       GOOGLE_CLIENT_ID=1234-abcd.apps.googleusercontent.com npm start

People who sign in with Google skip the password. They still do the short first-time setup (date of birth, gender, who they want to meet). If a Google email matches an existing account, the two are linked instead of creating a duplicate.

## See the home page with sample people (development only)
A new site has few members, and the home page only shows people from your own district, so it will look empty at first. To preview it locally, run `npm run seed:demo`. It adds about 25 fake demo accounts, most in Bengaluru Urban (password `demo12345`). Never run this on your real public site.

## Important for calls
- Browsers only allow camera/microphone on **https://** or **http://localhost**. To use it across the internet, put it behind HTTPS (e.g. Caddy, nginx, or a host like Render/Fly/Railway).
- Calls use Google's public STUN servers. For users behind strict firewalls or mobile networks you will need a TURN server. Set TURN_URL, TURN_USERNAME, TURN_CREDENTIAL (see .env.example).

## Project layout
    server.js            Express + Socket.IO server
    src/db.js            SQLite database and tables (data/app.db, created automatically)
    src/auth.js          Login tokens and auth middleware
    src/places.js        The district picker data (src/places.json)
    src/routes/media.js  Uploads (pictures, photos, videos) and the protected /media files
    src/files.js         Where uploads are stored and how they are deleted
    src/google.js        Google sign-in verification and account linking
    src/otp.js           One-time code creation and checking
    src/notify.js        Sends codes by email (SMTP) and text message (Twilio)
    scripts/seed-demo.js Fake demo members for local previews
    src/routes/          REST API: auth, users/search/profile, conversations/messages
    src/socket.js        Real-time chat, presence, and call signalling
    public/              The website (index.html, css/style.css, js/app.js)

## Before going public
- Use HTTPS, and set a strong JWT_SECRET (otherwise one is generated into data/.jwt-secret).
- Back up the data/ folder (all accounts, messages, photos and videos live there).
- If behind a reverse proxy, set TRUST_PROXY=1 so rate limiting sees real client IPs.
