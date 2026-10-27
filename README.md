# Little Board — cloud-synced Kanban, nothing more

Four columns: **Inbox · Next · Doing · Done**. Quick notes, drag to reorder or move between columns, rename headings, edit notes, and delete/clear them. Your notes sync across devices signed into **the same account**.

No due dates, tags, reminders, tracking, analytics, or subscriptions. A small static website using Supabase for login and secure cloud storage.

## First-time setup (about four actions)

1. **In Supabase**, open an existing project (including the one powering another app), or create a project. Open **SQL Editor**, paste all of `setup.sql`, and run it. It creates **only one new table** called `little_board_state` and configures row-level security and Realtime. It will not change your existing app's tables or policies.
2. In **Supabase → Project Settings → API Keys** (wording may vary), copy the **project URL** and its **publishable key**, or the legacy **anon** key. Open `config.js` with a text editor and replace its two example values. **Never** put a `service_role`, `secret`, or `sb_secret_...` key in a web app.
3. **Deploy to Cloudflare Pages**: create a new Pages project using Direct Upload and upload the `index.html`, `app.js`, and edited `config.js` together in the site's top-level directory. If uploading a ZIP, it should contain these files at its root. (The SQL and README can be included; they aren't needed by the running site.) This app is plain static HTML and JavaScript; there's no build command.
4. **In Supabase → Authentication → URL Configuration**, set **Site URL** to your Cloudflare Pages website's URL, and add it as an allowed **Redirect URL** (for confirmation emails). Open your published website, click **Create an account**, then sign in. If email confirmation is enabled, confirm the account using the email link first. Use the **same email/password** on each device.

When using an existing Supabase account from the same project, you can just sign in; you don't need another account.

## Sync and safety

- Card updates typically appear on other open devices immediately via Supabase Realtime. The board also refreshes on returning to the tab and periodically if a Realtime message was missed.
- Edits are cached locally if the network fails and queued until it returns. A status at the top shows whether changes have reached the cloud.
- The database keeps one board per authenticated account and uses revision checks, so simultaneous changes aren't silently overwritten by stale copies. When revisions conflict, pending edits are reapplied to the latest cloud version. **If the exact same note is edited simultaneously on two devices, the last successful edit to that note wins.**
- Sign in to the **same account** everywhere to see the same board. A separate email account gets a separate private board.
- The older browser-only version's notes can be merged with the new cloud board using **Bring in local notes** when you first open the new version in that browser. **Export backup / Import** also supports the old JSON format. Import **replaces** the synced board, so back up first if you're unsure.
- Your board is stored in your own Supabase project. Always keep occasional JSON exports of important notes.

## Files

- `index.html`: interface and styling
- `app.js`: board interactions, authentication, synchronization, and local queue
- `config.js`: your project URL and **public** key — edit this once before publishing
- `setup.sql`: database table, RLS, and Realtime settings — run once in Supabase

If the website says **One-time setup needed**, check `config.js`. If the website loads but can't open the board, make sure `setup.sql` was run and your project allows the Data API for the `public` schema. The browser also needs to be online on the first sign-in.

This app uses the Supabase JavaScript v2 library from a public CDN, so a network connection is needed to load the library on a fresh browser session.
