# Maaz Lead Suite Desktop

This Windows installer combines the LeadKing lead finder and Postbox Gmail campaign app in one desktop window.

## Install and connect

1. Run `dist/Maaz-Lead-Suite-Setup-1.0.0.exe` and follow the installer.
2. Open **Maaz Lead Suite** from the Start menu or desktop.
3. Use **Lead finder** for discovery and email research, and **Email & performance** for Gmail, scheduling, and the daily performance dashboard.
4. In Postbox, open Settings and enter the Google OAuth client ID and secret for this device. Add the displayed `http://localhost:3000/oauth/callback` URI to the OAuth client's authorized redirect URIs, save the settings, then connect Gmail.

OAuth tokens, local campaign data, research state, and exports are stored under `%LOCALAPPDATA%\MaazLeadSuite`. Gmail credentials and campaign queues are not embedded in the installer. Reference contact CSV and JSON files are kept locally and excluded from Git because they contain personal contact details. The app starts with empty reference lists if those files are missing.

The app uses local ports 3000 (Postbox) and 4173 (LeadKing). Close other local services using either port before opening it. Google sign-in opens in the default browser and returns to Postbox on localhost.

At startup, any scheduled Postbox jobs already past their send time are moved to `held_review`. They are not sent automatically. Future scheduled jobs keep their configured schedule.

## Sync between computers

The private GitHub repository stores the app source. It does not update an installed copy automatically. After changing code on one computer, commit and push it; on the other computer, pull the changes and rebuild the installer:

```powershell
git add -A
git commit -m "Describe the change"
git push
```

On the other computer, run `git pull --ff-only`, then rebuild using the steps below and install the new installer from `dist/`. Each installation keeps its OAuth credentials, scheduled jobs, research state, and exports on that computer. Copy approved reference data separately if both computers need the same contact lists.

## Build

Requires Windows, Node.js, and pnpm. From this folder run `pnpm install --ignore-workspace`, then run `pnpm install --prod --ignore-workspace --lockfile=false` from each service folder (`resources/apps/leadking` and `resources/apps/postbox`), then run `pnpm dist`. The NSIS installer is written to `dist/`.
