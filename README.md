# Maaz Lead Suite Desktop

This Windows installer combines the LeadKing lead finder and Postbox Gmail campaign app in one desktop window.

## Install and connect

1. Run `dist/Maaz-Lead-Suite-Setup-1.0.0.exe` and follow the installer.
2. Open **Maaz Lead Suite** from the Start menu or desktop.
3. Use **Lead finder** for discovery and email research, and **Email & performance** for Gmail, scheduling, and the daily performance dashboard.
4. In Postbox, open Settings and enter the Google OAuth client ID and secret for this device. Add the displayed `http://localhost:3000/oauth/callback` URI to the OAuth client's authorized redirect URIs, save the settings, then connect Gmail.

OAuth tokens, local campaign data, research state, and exports are stored under `%LOCALAPPDATA%\MaazLeadSuite`. Gmail credentials and campaign queues are not embedded in the installer. Reference contact CSV and JSON files are kept locally and excluded from Git because they contain personal contact details. The app starts with empty reference lists if those files are missing.

## Shared LeadKing research queue with Supabase

Supabase is optional and only shares the LeadKing website research queue between computers. The app sends pending source rows to a private table; each PC atomically claims a different row while it works. Completed research results can be downloaded to each PC. Supabase stores those queued rows and synced results. Browser research still runs on the computer doing the work. LeadKing search history/results, Postbox Gmail tokens and campaign data, exports, and other local settings remain on that PC unless separately copied or synced by you.

Set up the shared queue once:

1. Create a Supabase project and enable Email/Password sign-in. Create one account for yourself in **Authentication → Users**. Use that same account on both PCs.
2. In the project SQL editor, run [`supabase/migrations/001_shared_lead_queue.sql`](supabase/migrations/001_shared_lead_queue.sql).
3. From **Project Settings → API**, copy the Project URL and the public `anon` / publishable key. Never put the `service_role` key in the desktop app.
4. In LeadKing → **Therapist emails → Shared cloud queue**, enter the URL and public key and choose **Save project**. Enter the account email/password and choose **Sign in**. Repeat on the second PC.
5. Import the same source CSV on either PC. Use its same filename and row order on both PCs so source rows have matching identities. The shared start option queues pending rows from the local import automatically. Click **Sync this PC's queue** to add other already-imported pending rows. Enable **Use shared Supabase queue across computers** before starting research.
6. Choose **Download completed research** on either computer to bring shared results into that PC's local LeadKing database and refresh its email review/export screens.

Only the URL and public key are saved in the local LeadKing data folder. The sign-in password and Supabase session tokens stay in memory and are cleared when LeadKing closes; sign in again after restarting. Row claiming uses expiring leases so work can recover if a PC closes unexpectedly. A lost connection stops that PC's run without marking its current row complete. The table is restricted to the signed-in Supabase user by row-level security.

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
