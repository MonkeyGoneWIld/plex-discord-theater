# Discord Application Setup

Everything on the Discord side, in order. Set aside twenty minutes.

Two things here trip people up, and both have their own section below: keeping
the app **private** so nobody else can install it, and the **25-member limit**
that applies until the app is verified.

---

## 1. Create the application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. **New Application**, and give it a name. This name is what people see in the
   Activities list, so pick the one you want — "Theater", "Movie Night", and so on.
3. Open **General Information** and copy the **Application ID**. This is your
   `DISCORD_CLIENT_ID`.

> **Is the Application ID a secret?** No. It appears in every OAuth URL and is
> served to every viewer's browser. Treat it as public. The **Client Secret**
> below *is* a secret.

## 2. Get the Client Secret

1. **OAuth2** in the left sidebar.
2. **Reset Secret**, confirm, and copy the value.

This is your `DISCORD_CLIENT_SECRET`. It is shown once. If you lose it, reset it
again and update your `.env`.

![The OAuth2 page, with Reset Secret under Client Secret](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/portal-oauth2.png)

> [!WARNING]
> Never commit the Client Secret, and never paste it into a public issue.
> Anyone holding it can impersonate your application.

## 3. Enable Activities

1. **Activities → Settings** in the left sidebar.
2. Enable Activities for the application.

![Activity Settings, with Enable Activities on](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/portal-activities.png)

## 4. Add the URL mappings

This tells Discord where your Activity actually lives.

Open **Activities → URL Mappings** and set the **Root Mapping**:

| Prefix | Target |
|---|---|
| `/` | `your-domain.example.com` |

Use your real public HTTPS host — the same one that goes in `REDIRECT_URI` and
`ALLOWED_ORIGINS`. Enter the hostname without the `https://` scheme.

![Activity URL Mappings, with the root mapping set](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/portal-url-mappings.png)

**If you plan to use the [VPS Relay](VPS-Relay)**, add a second mapping now
with **Add Another URL Mapping**:

| Prefix | Target |
|---|---|
| `/theater` | `theater.your-domain.example.com` |

Without it, Discord's proxy blocks the relay's video segments and playback dies
with no obvious error.

## 5. Keep it private

By default, anyone with an install link can add your application to their
server. For a personal media server that is exactly what you do not want.

1. **Bot** in the left sidebar.
2. Turn **Public Bot** **off**.

With this off, only you can install the application.

> [!IMPORTANT]
> If the application is already public, Discord only lets you switch **Public
> Bot** off when **both** of these are true:
>
> - the application has **not** been verified, and
> - **Installation → Install Link** is set to **None**.
>
> So set Install Link to None first, then flip the toggle. Note the consequence
> of that ordering: once an app is verified, you can no longer make it private.
> Decide which you want before applying for verification — see
> [Private or verified?](#private-or-verified) below.

While you are here, set **Installation → Install Link** to **None** anyway.
Nothing about this project needs an install link.

---

## The 25-member limit

**An unverified Activity can only be launched in servers with fewer than 25
members.** This is a Discord platform rule. There is no way around it other than
verification.

While your app is unverified:

- It only appears in servers with **under 25 members**.
- It is only playable by **your team's developers** and **app testers you have
  explicitly invited**.
- It also works in **DMs and group DMs**.

For a group of friends this is usually fine — make a small private server for
movie nights and stay under 25 members.

### Adding app testers

Anyone not on your developer team must be added as a tester before they can
launch the Activity.

1. Open your application in the Developer Portal.
2. **App Testers** in the left sidebar.
3. Enter their Discord username and invite them.

![Application Testers](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/portal-testers.png)

They receive an invitation they need to accept. Until they do, the Activity will
not appear for them — which is the single most common reason for "my friend
cannot see it".

---

## Verifying the app

Verification lifts the 25-member limit and lets the Activity reach a wider
audience. It is also required for an app to scale past **100 servers**.

### What it unlocks

- Launching in servers of **any size**
- Playable by **anyone**, not just developers and testers
- Eligibility for **Discovery** and the App Directory
- Monetization features, if you ever wanted them

### How to apply

1. Open your application in the [Developer Portal](https://discord.com/developers/applications).
2. Open the **App Verification** tab.
3. Work through the checklist shown there until every item is green.
4. Click **Verify App**.

### What the process involves

The part people are not expecting: **identity verification through Stripe**.
Stripe is Discord's verification partner and confirms the identity of the team
owner, so you need a valid government ID. This is done by the **team owner**,
not by any team member.

You are also asked to describe what the app does and how it handles user data.
Be straightforward — it is a self-hosted media player for a private group.

### Private or verified?

These two goals pull against each other, so decide deliberately:

| | Unverified + private | Verified |
|---|---|---|
| Who can install it | Only you | Cannot be made private once verified |
| Server size limit | Under 25 members | None |
| Who can play it | Devs + invited testers | Anyone in a server where it is installed |
| Effort | One toggle | ID verification, checklist, review |

Because **Public Bot can only be switched off while the app is unverified**, the
practical choices are:

- **Small private group — recommended.** Stay unverified, Public Bot off, server
  under 25 members, friends added as app testers. Nothing else to do.
- **Larger server.** Verify the app, accept that it can no longer be made
  private, and use `ALLOWED_GUILD_IDS` to restrict which servers may use your
  backend.

That last point matters. Verification controls *Discord-side* distribution, but
your backend has its own allowlist. Even a verified app can be limited to your
own servers with
[`ALLOWED_GUILD_IDS`](Configuration-Reference#access-control).

---

## What this app actually asks for

The Activity requests three OAuth scopes:

| Scope | Used for |
|---|---|
| `identify` | Your Discord user ID and display name, so the room knows who is who |
| `guilds` | Confirming which servers you are in, so the server allowlist can be enforced |
| `rpc.activities.write` | Showing what the room is watching on your Discord profile. Decline it and playback still works |

No message reading, no message sending, no moderation permissions. The
application never posts to your server.

---

## 6. Launch it

Once the backend is running — see [Installation](Installation):

1. Join a voice channel in your server.
2. Click the **rocket icon** in the channel controls.
3. Pick your application from the list.
4. Use **Invite to Activity** to pull other channel members into the same room.

<img src="https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/discord-launch.png" alt="The Activity's launch card in Discord" width="320">

If it does not appear, work through
[Troubleshooting](Troubleshooting#the-activity-does-not-appear-in-the-rocket-menu).

---

## Sources

- [What are Verified and Unverified Activities?](https://support-dev.discord.com/hc/en-us/articles/26576097154199-What-are-Verified-and-Unverified-Activities)
- [How Can Users Discover and Play My Activity?](https://support-dev.discord.com/hc/en-us/articles/21204493235991-How-Can-Users-Discover-and-Play-My-Activity)
- [How Do I Get My App Verified?](https://support-dev.discord.com/hc/en-us/articles/23926564536471-How-Do-I-Get-My-App-Verified)
- [Enabling Discovery](https://discord.com/developers/docs/discovery/enabling-discovery)

---

## Next

→ [Plex Setup](Plex-Setup) · [Installation](Installation)
