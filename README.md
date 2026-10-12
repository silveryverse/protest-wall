# THE LOUDSPEAKER

A satirical, link-only protest wall about the **Cockroach Janta Party (CJP)** and its current protest concerning Chief Election Commissioner **Gyanesh Kumar**.

The site intentionally feels like a photocopied protest zine, not a SaaS product: newsprint, ink-black rules, chilli-red corrections, hand-lettered slogans and uneven poster edges. It has no upload pipeline and does not host video or image files.

## What works

- Public landing page with a source-backed, admin-editable manifesto.
- Public submissions for text, YouTube/Reddit/Twitter/X video links, image URLs and poster image URLs.
- All submissions are pending until an admin approves them.
- Click-to-load media: external media is not requested until a visitor asks to see it.
- Human moderation desk with approve, reject, set pending and permanent delete actions.
- Admin-editable protest summary, demands and source URL.
- Search, type filters, saved posts in browser storage, rotating original slogans and clearly labelled design examples.
- URL allowlists and validation, CSRF/origin checks, rate limits, body limits, secure headers and SSRF-resistant public URLs.

## Run locally

Node 22+ is required. No package install is needed.

PowerShell:

```powershell
$env:ADMIN_PASSWORD = "replace-this-with-a-long-password"
npm start
```

Open http://127.0.0.1:4173/ and choose **MOD DESK** or visit http://127.0.0.1:4173/#admin.

The app stores content in `data/store.json`, which is ignored by git. Admin sessions live in memory and expire after 30 minutes. Use HTTPS in production so the admin cookie gets the `Secure` attribute.

## Before going public

1. Re-check the dated reporting and CJP petition before publishing new claims. The current default copy uses “Cockroach Janta Party,” “Gyanesh Kumar,” and the electoral-roll/SIR campaign described in `research/cjp-research.md`.
2. Sign in to the mod desk and review the preloaded CJP summary, demands and source URL against the latest reporting. The public page labels this as sourced information, not official CJP communication.
3. Set a long, unique `ADMIN_PASSWORD`; do not commit it to the repository.
4. Put the app behind HTTPS and a reverse proxy with its own deployment-level rate limiting and backups.
5. Review external-link moderation rules and the platform terms for any embeds you plan to feature.

## Checks

```text
npm test
npm run check
```
