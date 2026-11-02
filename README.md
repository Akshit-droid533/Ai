# Alpha AI Workspace

A responsive AI chat workspace/PWA with OpenRouter model selection, streaming responses, optional agent tools, a local conversation library, file creation/downloads, offline shell caching, text/code attachments, and a plugin library UI.

## Run locally

1. Install Node.js 20.6 or newer.
2. Copy `.env.example` to `.env` and add your OpenRouter key and a long private access key.
3. In the project folder run `npm install`, then `npm start`.
4. Open `http://localhost:3000`.

The npm start script uses Node's `--env-file` support. The Docker image reads environment variables directly.

## Configuration

- `OPENROUTER_API_KEY`: server-side OpenRouter key. Never put this in browser code.
- `ACCESS_KEY`: required when binding to a public network. Enter the same value in Settings.
- `DEFAULT_MODEL`: initial model id.
- `FREE_MODELS`: comma-separated fallback models.
- `OLLAMA_URL` and `OLLAMA_MODEL`: optional local OpenAI-compatible Ollama fallback.
- `PORT`, `HOST`, `WORKSPACE`: optional server settings.

## Attachments and plugins

The composer accepts up to five text/code files per message, each up to 200 KB (`txt`, `md`, `csv`, `json`, common source files, YAML, SQL and logs). Their contents are added to the message context; files are not uploaded to the server automatically.

The Plugin Library includes built-in Workspace Tools and Voice Input, plus server-backed Web Research, Google Drive and Google Calendar integrations. External integrations require provider credentials; without them, the UI reports the exact setup requirement.

## Agent tools and security

Agent tools can create/read files and list/run commands inside `WORKSPACE`. Commands execute as the server's OS user; path checks restrict file APIs to the workspace but do not sandbox shell commands. Do not expose Agent auto-run on an untrusted public server. Use a low-privilege isolated container, a strong `ACCESS_KEY`, and preferably keep Agent mode disabled unless you understand the risk. Never commit `.env`.

## Deploy to Render

1. Push this folder to a GitHub repository.
2. In Render choose **New → Blueprint** and select the repository.
3. Set `OPENROUTER_API_KEY` and a long random `ACCESS_KEY` when prompted.
4. Deploy and open the HTTPS service URL. Enter the same access key in Alpha Settings.

The free Render filesystem is temporary. Download generated files you need; use persistent storage for durable workspace files.

## Offline and PWA

The app shell is cached and chats are stored in browser local storage. AI responses need a working network connection and server. Offline messages queue until the connection returns. Install from the browser's Add to Home Screen / Install App menu over HTTPS.


## Optional integrations

Alpha includes three real integrations in the Plugins panel:

- **Web Research:** Set `BRAVE_SEARCH_API_KEY` from the Brave Search API dashboard. Search is performed server-side; the key is never sent to the browser.
- **Cloud Storage:** Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` for a Google OAuth application with the Google Drive API enabled and the `https://www.googleapis.com/auth/drive.file` and `https://www.googleapis.com/auth/drive.metadata.readonly` scopes. It lists recent files and uploads text files.
- **Calendar:** Uses the same Google OAuth credentials with the `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.readonly` scopes. It lists events in the next 14 days and creates events.

Create an OAuth 2.0 client and obtain a refresh token using Google's OAuth consent flow. Keep all credentials in Render Environment (or your server `.env`), never in frontend files or GitHub. If credentials are absent, the plugin displays a setup message instead of pretending to connect.


## Extended integrations

Alpha now includes Gmail (read/search only), Google Docs (list/create), Dropbox (list/upload), OneDrive (list/upload), and a local custom-plugin marketplace for safe HTTPS shortcuts.

### Required credentials
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`. Re-authorize the OAuth consent flow with Gmail readonly, Drive, Docs, and Calendar scopes. A refresh token created without the new scopes will not gain them automatically.
- Dropbox: `DROPBOX_ACCESS_TOKEN` with `files.metadata.read` and `files.content.write` scopes.
- OneDrive: `MICROSOFT_ACCESS_TOKEN` with Microsoft Graph delegated `Files.ReadWrite.All`. This is a short-lived access-token configuration; for production, implement a Microsoft OAuth refresh-token flow.
- Web research: `BRAVE_SEARCH_API_KEY`.

All credentials belong in Render Environment Variables, never in frontend files or GitHub. The custom marketplace stores HTTPS links in the current browser only and opens them in a new tab; it intentionally does not execute third-party plugin code.

### Permissions and limits
Gmail is read/search only. Google Docs can create and list documents. Dropbox and OneDrive support browsing the root folder and uploading text files. Dropbox upload limit is 10 MB; OneDrive simple upload limit is 4 MB. OAuth scopes and provider-side consent must be configured before these integrations work.
