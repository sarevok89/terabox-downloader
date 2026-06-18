# terabox-downloader

Recursively download a folder from your TeraBox account using its web API and your browser session cookie. No official API key required.

## Requirements

- Node.js 18+
- npm

## Setup

```bash
git clone <this-repo>
cd terabox-downloader
npm install
cp terabox_config.example.ts terabox_config.ts
```

Then edit `terabox_config.ts` and fill in your cookie (see below).

## Getting your cookie

1. Open [terabox.com](https://www.terabox.com) and log in.
2. Open DevTools (`F12`) → **Network** tab → refresh the page.
3. Click any request to `terabox.com` → **Headers** → **Request Headers**.
4. Find the `Cookie` header — copy the **entire value** and paste it into `terabox_config.ts`.

> Your cookie is your session credential. Keep `terabox_config.ts` out of version control (it's already in `.gitignore`).

## Usage

```bash
# Download a remote folder into ~/Downloads/terabox/
npx tsx terabox-downloader.ts "/My Files/Photos"

# Download into a specific local directory
npx tsx terabox-downloader.ts "/My Files/Photos" "/home/user/backup"
```

The remote path is the folder path as it appears in the TeraBox web UI (starting with `/`).

Already-downloaded files are skipped automatically.

## Troubleshooting

| Error | Fix |
|---|---|
| `auth failed — cookie/ndus is wrong or expired` | Re-copy your cookie from the browser; it may have expired. |
| `file or directory does not exist` | Check that the remote path matches exactly (case-sensitive). |
| `Could not auto-extract jsToken` | Grab `jsToken` from a `/api/list` request in DevTools and set it in `terabox_config.ts`. |
| `hit rate limit` | The API throttled you; re-run and already-downloaded files will be skipped. |
