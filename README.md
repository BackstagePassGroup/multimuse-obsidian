# Multimuse Obsidian - Obsidian Plugin

Obsidian plugin for MultiMuse bot integration - track Discord threads and send messages as muses directly from Obsidian.

## Features

- ✅ Automatically tracks Discord threads linked in your scene files
- ✅ Updates `Replied?` and `Participants` fields in frontmatter
- ✅ **Send as Muse**: Right-click selected text to post as a muse to Discord threads
- ✅ Auto-detects user ID from API key (no manual configuration needed)
- ✅ Configurable poll interval (5-60 minutes)
- ✅ Works entirely within Obsidian
- ✅ Supports multiple muses and character selection

## Installation

### Manual Installation

1. Copy the `multimuse-obsidian` folder to your Obsidian vault's `.obsidian/plugins/` directory
2. Open Obsidian Settings → Community Plugins
3. Enable "Multimuse Obsidian"
4. Go to Settings → Multimuse Obsidian and configure your API key

### Development Installation

1. Clone or copy this folder to `.obsidian/plugins/multimuse-obsidian`
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the plugin:
   ```bash
   npm run build
   ```
4. Enable the plugin in Obsidian Settings → Community Plugins

## Setup

### 1. Get Your API Key

1. Open Discord DMs with the MultiMuse bot
2. Use the command: `/api generate`
3. Copy the generated API key (starts with `mm_`)

### 2. Configure Plugin

1. Open Obsidian Settings → Multimuse Obsidian
2. Paste your API key in the "API Key" field
3. Your user ID will be automatically detected from the API key
4. Set poll interval (default: 15 minutes)
5. Set scenes folder (default: "RP Scenes")
6. (Optional) Set Obsidian Base path for scene tracking
7. Enable polling

## How It Works

### Thread Tracking

1. The plugin scans all `.md` files in your scenes folder
2. For each file with a `Link` and `Characters` field in frontmatter:
   - Extracts the Discord thread ID from the URL
   - Queries the MultiMuse API for thread state
   - Updates `Replied?` field (true = your turn, false = not your turn)
   - Updates `Participants` field

### Send as Muse

1. Select text in a scene file
2. Right-click → "Send as Muse"
3. If multiple characters in frontmatter, select which muse to post as
4. Message is automatically posted to the Discord thread via the MultiMuse API
5. Long messages are automatically split to respect Discord's limits

## Scene File Format

Your scene files should have frontmatter like this:

```markdown
---
Link: https://discord.com/channels/123456789/987654321/111222333444555666
Characters:
  - Bel
  - Another Character
Participants: 2
Replied?: false
Is Active?: true
---

[Scene content here]
```

**Required fields:**
- `Link`: Full Discord thread URL
- `Characters`: Array of character/muse names (used for "Send as Muse")

**Auto-updated fields:**
- `Replied?`: Automatically updated by the plugin (true = your turn, false = not your turn)
- `Participants`: Automatically updated with thread participant count

## Commands

- **Check Discord Threads Now**: Manually trigger a check
- **Toggle Discord Polling**: Enable/disable automatic polling
- **Create New Scene**: Create a new scene file with muse selection
- **Sync from Tracker**: Sync scenes from bot tracker to Obsidian

## Settings

- **Enable Polling**: Turn automatic checking on/off
- **API Key**: Your MultiMuse API key (auto-detects user ID)
- **Poll Interval**: How often to check (5-60 minutes)
- **Scenes Folder**: Folder containing your scene files
- **Obsidian Base Path**: Optional path to Base file for scene tracking

## Troubleshooting

### "API authentication failed" error
- Make sure your API key is correct (starts with `mm_`)
- Verify the API key was generated using `/api generate` in Discord
- Check that the API key hasn't been revoked

### "Failed to get user ID from API key"
- Verify your API key is valid
- Check your internet connection
- Ensure the MultiMuse bot API is accessible

### "Muse not found or not accessible"
- Make sure the muse name in your frontmatter matches exactly (case-insensitive)
- Verify the muse exists in Discord
- Check that the muse is owned by you or shared with you

### Files not updating
- Check that your scene files have `Link` and `Characters` fields in frontmatter
- Verify the link contains a valid Discord thread URL
- Make sure polling is enabled
- Check the console (Ctrl+Shift+I) for errors

### "Send as Muse" not working
- Ensure text is selected before right-clicking
- Verify the file has `Link` and `Characters` in frontmatter
- Check that the selected muse exists and is accessible
- Verify your API key is configured correctly

## Privacy & Security

- Your API key is stored locally in Obsidian's settings
- The plugin only accesses threads you've linked in your scene files
- All communication goes through the MultiMuse bot API
- User ID is automatically detected from API key (no manual entry needed)

## License

MIT
