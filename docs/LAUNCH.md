# Darkroom launch checklist

Things that can only be set in dashboards (no API access from code). Do these before inviting clients.

## 1. Email delivery (required)
Supabase's built-in sender is for testing only: **2 emails per hour for the whole project, and only to members of the Supabase team.**
Clients' sign-up confirmations and password resets will not arrive until custom SMTP is set up.

1. Create an account at **resend.com** and add your sending domain (Domains → Add). Add the DNS records it shows in Cloudflare/your registrar, then wait for **Verified**.
2. Resend → API Keys → create a key (Sending access).
3. Supabase → Authentication → **SMTP Settings** (Emails → SMTP) → Enable custom SMTP:
   - Sender email: `no-reply@<your-domain>` · Sender name: `Darkroom`
   - Host `smtp.resend.com` · Port `465` · Username `resend` · Password: the API key
4. Supabase → Authentication → **Rate Limits** → "Emails sent per hour": raise to 100+.

## 2. Links in emails (required)
Supabase → Authentication → **URL Configuration**
- Site URL: `https://darkroom-umber.vercel.app` (or your custom domain)
- Redirect URLs: add `https://darkroom-umber.vercel.app/**` (and the custom domain, if any)

## 3. Branded emails
Supabase → Authentication → **Email Templates**
- Confirm signup → subject `Confirm your Darkroom account` → paste `supabase/templates/confirm-signup.html`
- Reset password → subject `Reset your Darkroom password` → paste `supabase/templates/reset-password.html`

## 4. Plans
- Supabase **Pro** (~$25/mo): free projects pause after a week of inactivity and have no backups. Pro adds daily backups and 100 GB storage.
- Vercel: make sure the team is on **Pro**. Hobby is for non-commercial use only.

## 5. Auto-deploys
Vercel → project `darkroom` → Settings → **Git** → connect `jayeed17/darkroom`, root directory `web`. After this, every push to `main` deploys.

## 6. Custom domain (recommended)
Vercel → project → Settings → Domains → add e.g. `gallery.<client-domain>`, add the DNS record it shows, then repeat step 2 with the new domain.
