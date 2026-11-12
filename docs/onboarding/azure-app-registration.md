# Outlook / Microsoft 365 in the Mail Agent — your own app registration

The Outlook path of the mail agent talks to **Microsoft Graph** instead of
IMAP (Microsoft has switched off IMAP basic auth — Graph is the only clean
way). Graph needs an **app registration** in Azure so that the device-code
sign-in works ("enter the code at microsoft.com/devicelogin"). This is a
one-time step, takes about 5 minutes, and is free.

**There is no shared Embervy vendor app yet**, so you register this app
in your own Azure tenant.

## Step by step

1. Open **[portal.azure.com](https://portal.azure.com)** and sign in with
   the Microsoft account whose mailbox the mail agent should work in
   (or an admin account if it is a company tenant).

2. In the search bar at the top, search for **App registrations** and open
   that section.

3. Click **New registration**.

4. Fill in:
   - **Name**: anything you like, e.g. `Embervy Mail Agent`
   - **Supported account types**: **"Accounts in any organizational
     directory and personal Microsoft accounts"** — this is required;
     otherwise it only works with a single company tenant.
   - **Redirect URI**: **leave empty**. The device-code flow does not need
     a redirect URI.

5. Click **Register**.

6. You land on the overview page of the new app. Copy the
   **Application (client) ID** — that is the string that later goes into
   the server configuration (`MAILBOX_GRAPH_CLIENT_ID`).

7. In the left menu: **Authentication** → scroll down to
   **Advanced settings**.

8. Set **"Allow public client flows"** to **Yes**. **This is required** —
   without this setting Microsoft rejects the device-code sign-in.

9. Click **Save**.

10. In the left menu: **API permissions** → check that the following
    **delegated** permissions for **Microsoft Graph** are present — if
    not, add them via **"Add a permission"** → **Microsoft Graph** →
    **Delegated permissions**:
    - `Mail.Read`
    - `Mail.ReadWrite`
    - `Mail.Send`
    - `offline_access`

    An admin-consent click is normally not needed for these four
    permissions on a personal account; on a company tenant the admin may
    be asked afterwards — that is then one click on **"Grant admin
    consent"** on the same page.

Done. The **Application (client) ID** from step 6 is all the server
needs — no client secret; the device-code flow is a "public client flow"
without a secret key.

## Afterwards

On the first run of the mail agent with `MAILBOX_PROVIDER=graph`, the
setup shows a code and a link to `microsoft.com/devicelogin`. Enter the
code, sign in with the Outlook account, done — the server remembers the
access from then on (token cache, renewed automatically).
