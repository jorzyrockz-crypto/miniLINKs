# stub.li — a real, working link shortener

Two parts, both free to run:

- **`worker/`** — a Cloudflare Worker (serverless backend) that creates short
  links, stores them in Workers KV, and actually redirects visitors. This is
  deployed automatically by GitHub Actions whenever you push.
- **`docs/`** — a static frontend (plain HTML/JS, no build step) hosted on
  GitHub Pages. It talks to the Worker over its API. There are two pages:
  - **`docs/index.html`** — your private admin dashboard (needs the admin key).
    Unlimited stubs, full list, delete.
  - **`docs/create.html`** — the public page you share with other people.
    Free stubs up to a limit, then a PayMongo upgrade for unlimited.

Short links look like `https://stub-li.<you>.workers.dev/abc123` and really
redirect from anywhere — phone, another computer, a friend's browser.

## 1. One-time Cloudflare setup

1. Create a free account at https://dash.cloudflare.com/sign-up if you don't have one.
2. Install Wrangler locally and log in:
   ```
   npm install -g wrangler
   wrangler login
   ```
3. Create the KV namespace that stores your links:
   ```
   cd worker
   wrangler kv namespace create LINKS
   ```
   This prints an `id`. Copy it into `worker/wrangler.toml`, replacing
   `REPLACE_WITH_KV_NAMESPACE_ID`.
4. Get your **Account ID** (Cloudflare dashboard → right sidebar of any
   domain/Workers page) and create an **API Token**: dashboard → *My Profile*
   → *API Tokens* → *Create Token* → use the **"Edit Cloudflare Workers"**
   template.

## 2. GitHub repo setup

1. Push this folder to a new GitHub repo (root of the repo = this folder).
2. In the repo, go to **Settings → Secrets and variables → Actions** and add:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1.4
   - `CLOUDFLARE_ACCOUNT_ID` — your account ID from step 1.4
   - `ADMIN_KEY` — make up a long random string yourself (this is your
     personal password for creating/deleting links — treat it like one).
3. Push to `main`. The **Deploy Worker** Action runs automatically and
   deploys your Worker. Check the Action's log, or your Cloudflare dashboard
   under **Workers & Pages**, for the live URL — it looks like
   `https://stub-li.<your-subdomain>.workers.dev`.

## 3. Turn on GitHub Pages

1. Repo → **Settings → Pages**.
2. Source: **Deploy from a branch**. Branch: `main`, folder: **`/docs`**.
3. Save. GitHub gives you a URL like
   `https://<username>.github.io/<repo>/` — that's your shortener's UI.

## 4. Connect the frontend to your Worker

1. Open your GitHub Pages URL.
2. Click the small gear/eyebrow link at the top ("connect a worker").
3. Paste in:
   - **Worker URL**: your `*.workers.dev` URL from step 2.3
   - **Admin key**: the exact `ADMIN_KEY` value you set as a GitHub secret
4. Save & connect. From here on it's saved in your browser — you can start
   shortening real links.

## 5. Accept payments with PayMongo (optional)

This lets `docs/create.html` sell a one-time "unlimited stubs" upgrade
(default ₱149) paid via GCash, Maya, or card, entirely through PayMongo's
hosted checkout — no card-processing code of your own.

1. Sign up at https://dashboard.paymongo.com/signup. Start in **test mode**
   (default) so you're not handling real money yet.
2. Go to **Developers → API Keys** and copy the **Secret Key** (`sk_test_...`).
3. Go to **Developers → Webhooks → Add endpoint**:
   - URL: `https://<your-worker-url>/api/webhook/paymongo`
   - Events: subscribe to `checkout_session.payment.paid` (and any others you
     want to track later, like refunds).
   - Save, then copy the **webhook's Secret Key** it shows you (different
     from your API secret key).
4. Add two more GitHub repo secrets (**Settings → Secrets and variables →
   Actions**):
   - `PAYMONGO_SECRET_KEY` — the key from step 5.2
   - `PAYMONGO_WEBHOOK_SECRET` — the key from step 5.3
5. Push any small change (or re-run the Action manually) so the Worker picks
   up the new secrets.
6. Edit `docs/create.html` and set `API_BASE` near the bottom of the file to
   your Worker URL, then push.
7. Test it: open `create.html`, hit the free limit (`PUBLIC_FREE_LIMIT`,
   default 10 — lower it temporarily in `wrangler.toml` while testing),
   click **Upgrade**, and pay with a
   [PayMongo test card](https://developers.paymongo.com/docs/testing) or
   GCash test flow. A license key should appear and unlock unlimited stubs
   in that browser.
8. When ready for real money: switch to **live mode** in the PayMongo
   dashboard, regenerate a **live** secret key and webhook secret, and update
   the two GitHub secrets with the live values.

Adjust pricing or the free tier size by editing `PRO_PRICE_PHP` and
`PUBLIC_FREE_LIMIT` in `worker/wrangler.toml`.

## Notes

- The admin key gates *creating and listing* links so random visitors can't
  fill up your KV store or see your list. Anyone can still **use** a short
  link you've shared — the redirect itself is public, as a link shortener
  should be.
- Want a nicer domain than `*.workers.dev`? In Cloudflare, add a Worker
  **Route** or **Custom Domain** on any domain you own, pointing at this
  Worker — no code changes needed, just update the Worker URL in the
  frontend's settings panel afterward.
- To change or rotate your admin key later, update the `ADMIN_KEY` GitHub
  secret, push any small change to `worker/` (or run the Action manually via
  **Actions → Deploy Worker → Run workflow**), then update it in the
  frontend's settings panel too.
- The license-key model is intentionally simple: one key unlocks unlimited
  stubs in whatever browser holds it, with no per-person account. That's
  fine at small scale, but a key could technically be shared. If this grows
  and that becomes a problem, the fix is real user accounts (Firebase Auth,
  Clerk, etc.) with keys tied to a signed-in user instead of local storage.
