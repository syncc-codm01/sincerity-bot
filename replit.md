# Sincerity Bot

A Discord bot for automated role assignment based on form submissions, and member verification management.

## Features

- Watches a designated form channel for bot-submitted form messages
- Assigns roles based on form answers (CODM, TikTok)
- Always assigns the "Unverified" role on form submission
- Removes "Unverified" role when a member receives the "Verified" role
- Kicks members who still have the "Unverified" role after 3 days

## Setup

- Bot token stored as `DISCORD_TOKEN` secret
- Persistent kick timer data stored in `data/unverified.json`

## Channel & Role IDs

- Form channel: `1509951821903302797`
- Unverified role: `1510537467814740038`
- CODM role: `1510537801144467586`
- TikTok role: `1510537918333325382`
- Verified role: `1509947656149925948`

## User Preferences

- Use discord.js v14
- Node.js bot, no web frontend
